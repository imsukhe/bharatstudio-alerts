-- RT-03 (§19.0, owner decision 2026-09-16): checks, then synthesis, then one
-- release. RT-03.6 is a blocking acceptance test: a failed synthesis must
-- not consume premium TTS characters.
--
-- app_private.meter_tts_usage (0081) settles the character charge
-- unconditionally and immediately, before the provider call --
-- apps/api/src/routes/tts.ts calls meter() first (so a concurrent request
-- can never oversell the same monthly quota window), then calls
-- TtsService.synthesize(). On every synthesis-failure path after that point
-- (the provider throwing, or answering with a chime-mode result) the
-- already-settled charge was never returned to the creator's balance. That
-- is the defect this migration closes.
--
-- This adds only the release half of a reserve/release pair over the
-- existing app_private.alert_tts_usage_monthly counter. meter_tts_usage is
-- unchanged and remains the reserve step. No new ledger entry type is
-- added -- §10.2 lists grant, reserve, settle, release, refund and expiry
-- as the only ones, and this is a release over the existing counter, not a
-- new mechanism or a new table.
--
-- Depends on 0001-0127. Modifies no existing migration file; this is a new
-- forward migration only, and its own rollback (should one ever be needed)
-- must also be a new forward migration, never an edit of this file.

create or replace function app_private.release_tts_usage_reservation(
  target_event_id uuid,
  target_char_count integer
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  target_channel_id uuid;
  current_month date := date_trunc('month', current_timestamp)::date;
begin
  if target_char_count is null or target_char_count < 0 then
    raise exception 'invalid TTS character count' using errcode = '22023';
  end if;
  if target_char_count = 0 then
    return;
  end if;

  select event.channel_id into target_channel_id
    from public.alert_events event
   where event.id = target_event_id;
  if not found then
    raise exception 'alert event not found for TTS quota release' using errcode = '23503';
  end if;

  -- Same row lock discipline as meter_tts_usage, so a release racing a
  -- concurrent reserve or release for the same channel serializes correctly
  -- rather than lost-updating each other.
  perform 1 from public.channels where id = target_channel_id for update;

  -- A release for a billing month with no usage row at all (e.g. the month
  -- rolled over between reserve and release -- an accepted, extremely rare
  -- edge case) is a safe no-op: there is nothing to give back, and the
  -- creator keeps the charge for that one failed synthesis. Recorded as a
  -- known limitation rather than papered over.
  --
  -- The greatest(...,0) floor guarantees exactly one thing: the counter can
  -- never go negative. It is NOT an idempotency guarantee. Calling this
  -- twice for the same reservation while the month's counter holds other
  -- usage WOULD give back twice the characters and hand the creator quota
  -- they never reserved. The invariant that prevents it lives in the
  -- caller: apps/api/src/routes/tts.ts releases on mutually exclusive
  -- failure paths, at most once per metered request. Any future caller must
  -- hold the same invariant, or this function must first be given
  -- per-reservation state to be idempotent against.
  update public.alert_tts_usage_monthly
     set characters_used = greatest(characters_used - target_char_count, 0),
         updated_at = current_timestamp
   where channel_id = target_channel_id
     and billing_month = current_month;
end
$$;

revoke execute on function app_private.release_tts_usage_reservation(uuid, integer) from public;
grant execute on function app_private.release_tts_usage_reservation(uuid, integer) to bsa_app;
