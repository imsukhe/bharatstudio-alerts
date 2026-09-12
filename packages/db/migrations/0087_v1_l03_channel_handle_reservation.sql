-- L03: self-service channel handle change, with the released handle
-- permanently reserved.
--
-- A handle is a PUBLIC IDENTIFIER already shared on tip pages
-- (/tips/[handle]) — every link a creator has posted, printed, or put in a
-- stream overlay embeds it. Letting the string go back into the free pool
-- the instant a creator renames would let anyone else immediately claim
-- the old link and receive tips meant for the original creator. This
-- migration does not (and cannot, from this lane) add a redirect on the
-- public tip page itself — /tips/[handle] belongs to a different lane's
-- ownership boundary — so a stale outbound link still 404s after a rename.
-- What it guarantees is narrower but still real: the released handle can
-- never be reassigned to anyone else, so a future redirect (or a manual
-- support fix) always has a stable, conflict-free record of who used to
-- own it.
--
-- Handle format/case-fold rules mirror what already governs channels.handle
-- (see 0001_v1_baseline.sql's channels_handle_lower_unique index and
-- routes/channels.ts's POST /v1/channels pattern): case-insensitive
-- uniqueness, ^[A-Za-z0-9._-]{1,64}$.

create table public.channel_handle_history (
  handle text primary key,
  channel_id uuid not null references public.channels(id),
  released_at timestamptz not null default current_timestamp
);

create index channel_handle_history_channel_idx
  on public.channel_handle_history (channel_id);

alter table public.channel_handle_history enable row level security;
revoke all on public.channel_handle_history from public;
revoke all on public.channel_handle_history from bsa_app;
-- No select policy for bsa_app: this table is a write-only reservation
-- ledger consulted only from inside change_channel_handle below; the
-- application has no legitimate reason to read it directly.

-- Atomically renames a channel's public handle: reasserts owner/admin
-- authorization (this runs security definer, so the table's own
-- channels_owner_update RLS policy does not apply here — see 0069's
-- record_subscription_lifecycle_request for the same pattern/reasoning),
-- validates the new handle's format, rejects it if already taken by any
-- live channel OR any previously-released handle, then reserves the
-- outgoing handle so it can never be reused. A rename to the channel's own
-- current handle (e.g. a pure case fix) is a no-op with respect to
-- reservation — nothing is reserved when nothing actually changes.
create or replace function app_private.change_channel_handle(
  target_channel_id uuid,
  target_new_handle text
)
returns table (
  id uuid, handle text, display_name text, accepting_tips boolean,
  public_config_version integer, featured_consent boolean
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

    update public.channels
       set handle = target_new_handle, updated_at = current_timestamp
     where id = target_channel_id;
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
