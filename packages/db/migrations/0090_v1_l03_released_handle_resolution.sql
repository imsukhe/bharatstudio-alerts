-- Released-handle resolution for the public tip page.
--
-- 0087 added channel_handle_history so a handle a creator releases can never
-- be claimed by anyone else. That closes the squatting hole but does not keep
-- old links working: every bharatstudio.in/tips/<old-handle> a creator ever
-- published still 404s, which is the reason the handle was reserved at all.
--
-- 0087 deliberately revokes ALL bsa_app access to channel_handle_history and
-- documents it as "a write-only reservation ledger ... the application has no
-- legitimate reason to read it directly". That judgement is preserved here:
-- this migration does NOT grant select on the table. It adds one narrow
-- security-definer function that takes a handle and returns the SAME public
-- projection app_private.get_public_channel already returns, and nothing else.
-- The application still cannot enumerate the ledger, read released_at, or map
-- a channel back to its former names — it can only ask "does this specific
-- handle resolve to a channel, and what is that channel's public row".
--
-- Chain safety: history rows point at channel_id, never at a successor
-- handle, so A -> B -> C resolves for an A link in one lookup regardless of
-- how many renames happened.

create or replace function app_private.get_public_channel_for_released_handle(target_handle text)
returns table (
  channel_id uuid,
  handle text,
  display_name text,
  accepting_tips boolean,
  minimum_tip_paise integer,
  public_config_version integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Resolve the released handle to its channel, then hand off to the existing
  -- public projection using that channel's CURRENT handle, so this function
  -- can never drift from what a live lookup returns.
  select p.*
    from public.channel_handle_history h
    join public.channels c on c.id = h.channel_id
   cross join lateral app_private.get_public_channel(c.handle) as p
   where lower(h.handle) = lower(target_handle);
$$;

revoke all on function app_private.get_public_channel_for_released_handle(text) from public;
grant execute on function app_private.get_public_channel_for_released_handle(text) to bsa_app;

-- ---------------------------------------------------------------------------
-- Defect fix: app_private.change_channel_handle raised 42702 on every rename.
--
-- 0087 declared the function `returns table (id uuid, handle text, ...)`, so
-- `id` and `handle` are OUT parameters and therefore PL/pgSQL variables inside
-- the body. Every statement in that function aliases the table to disambiguate
-- (`from public.channels channels where channels.id = ...`) EXCEPT the UPDATE:
--
--     update public.channels
--        set handle = target_new_handle, updated_at = current_timestamp
--      where id = target_channel_id;      -- <- `id` is ambiguous
--
-- Postgres rejects that with:
--     ERROR: column reference "id" is ambiguous
--     DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
-- So renaming a handle failed for every caller. It was not caught because the
-- batch-2 tests covering the rename exercised the route with a stubbed store
-- and never executed this function body against Postgres.
--
-- SECOND defect in the same function: it declares
--     public_config_version integer
-- but channels.public_config_version is BIGINT (0001_v1_baseline.sql:25), so
-- even with the ambiguity fixed the function fails on return with
--     ERROR: structure of query does not match function result type
--     DETAIL: Returned type bigint does not match expected type integer in column 5.
-- Both defects had to be hit in sequence to be seen, which is why executing the
-- function against a real database — rather than stubbing the store — was the
-- only thing that could have caught either.
--
-- 0087 is left untouched (migration history is never rewritten). This
-- recreates the function with the UPDATE's target aliased and the column typed
-- bigint, identical in every other respect: same signature shape, same
-- validation order, same 22023/42501/23505 error codes, same reservation
-- insert, same return projection.
-- ---------------------------------------------------------------------------

-- The OUT-parameter row type changes (integer -> bigint), which CREATE OR
-- REPLACE cannot do, so the old function is dropped first. Dropping a FUNCTION
-- is not rewriting migration history: 0087's file is unchanged and still
-- replays exactly as written; this migration then supersedes the object it
-- created, which is the ordinary forward-only way to fix a shipped function.
drop function if exists app_private.change_channel_handle(uuid, text);

create function app_private.change_channel_handle(
  target_channel_id uuid,
  target_new_handle text
)
returns table (
  id uuid, handle text, display_name text, accepting_tips boolean,
  public_config_version bigint, featured_consent boolean
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_handle text;
begin
  if target_new_handle is null or target_new_handle !~ '^[A-Za-z0-9._-]{1,64}$' then
    raise exception 'invalid channel handle' using errcode = '22023';
  end if;

  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'insufficient role to change channel handle' using errcode = '42501';
  end if;

  select channels.handle into current_handle
    from public.channels channels
   where channels.id = target_channel_id
     for update;

  if not found then
    return;
  end if;

  if current_handle <> target_new_handle then
    if exists (
      select 1 from public.channels other
       where lower(other.handle) = lower(target_new_handle) and other.id <> target_channel_id
    ) or exists (
      select 1 from public.channel_handle_history history
       where lower(history.handle) = lower(target_new_handle)
    ) then
      raise exception 'channel handle unavailable' using errcode = '23505';
    end if;

    insert into public.channel_handle_history (handle, channel_id)
    values (current_handle, target_channel_id);

    update public.channels channels
       set handle = target_new_handle, updated_at = current_timestamp
     where channels.id = target_channel_id;
  end if;

  return query
    select channels.id, channels.handle, channels.display_name, channels.accepting_tips,
           channels.public_config_version, channels.featured_consent
      from public.channels channels
     where channels.id = target_channel_id;
end
$$;

revoke execute on function app_private.change_channel_handle(uuid, text) from public;
grant execute on function app_private.change_channel_handle(uuid, text) to bsa_app;
