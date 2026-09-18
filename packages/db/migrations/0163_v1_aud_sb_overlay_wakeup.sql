-- AUD-SB-01: Soundboard triggers are durable latest-play rows first. This
-- forward-only correction emits the existing channel-scoped overlay wake-up
-- only after a valid row is inserted in the same transaction. PostgreSQL
-- publishes NOTIFY at commit, so a rolled-back/rejected trigger cannot wake an
-- overlay. The notification is a latency optimisation only; the bounded
-- snapshot/SSE fallback remains the correctness path.
--
-- No table/column/return shape changes. Do not edit 0143: environments may
-- already have it applied. This body preserves its role/tier/source checks and
-- owner/admin function boundary verbatim, adding only the existing opaque
-- `{channelId, eventId}` wake-up call after the successful insert.

create or replace function app_private.trigger_soundboard_play(
  target_channel_id uuid,
  target_catalogue_entry_id uuid,
  target_upload_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_id uuid;
  current_tier text;
  entry record;
  is_disabled boolean;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to trigger this channel''s soundboard' using errcode = '42501';
  end if;

  if (target_catalogue_entry_id is null) = (target_upload_id is null) then
    raise exception 'exactly one soundboard source must be supplied' using errcode = '22023';
  end if;

  if target_catalogue_entry_id is not null then
    select id, min_tier into entry
      from public.soundboard_catalogue_entries
     where id = target_catalogue_entry_id;
    if not found then
      raise exception 'unknown soundboard catalogue entry' using errcode = 'P0002';
    end if;

    select app_private.current_channel_tier(target_channel_id) into current_tier;
    if app_private.soundboard_tier_rank(entry.min_tier) > app_private.soundboard_tier_rank(current_tier) then
      raise exception 'soundboard clip not available at this channel''s tier' using errcode = '42501';
    end if;

    select exists (
      select 1 from public.channel_soundboard_disables
       where channel_id = target_channel_id and sound_id = target_catalogue_entry_id
    ) into is_disabled;
    if is_disabled then
      raise exception 'soundboard clip is disabled for this channel' using errcode = '42501';
    end if;
  else
    if not exists (
      select 1 from public.channel_soundboard_uploads
       where id = target_upload_id and channel_id = target_channel_id
    ) then
      raise exception 'unknown soundboard upload' using errcode = 'P0002';
    end if;
  end if;

  new_id := gen_random_uuid();
  insert into public.channel_soundboard_plays (id, channel_id, catalogue_entry_id, upload_id, created_at)
  values (new_id, target_channel_id, target_catalogue_entry_id, target_upload_id, current_timestamp);

  perform app_private.notify_overlay_wakeup(target_channel_id, new_id);
  return new_id;
end
$$;

revoke execute on function app_private.trigger_soundboard_play(uuid, uuid, uuid) from public;
grant execute on function app_private.trigger_soundboard_play(uuid, uuid, uuid) to bsa_app;
