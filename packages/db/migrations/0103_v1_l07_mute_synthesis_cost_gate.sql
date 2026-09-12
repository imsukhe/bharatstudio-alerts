-- L07 follow-up to 0101's own header comment ("GAP 1"): mute enforcement at
-- PLAYBACK (get_overlay_events) is done, but paid synthesis still happens
-- even when every queue an event fans out to is muted, because
-- app_private.get_alert_tts_input(target_event_id) (0067/0096) has no
-- queue/delivery context -- alert-worker-go's Enricher.Enrich(ctx, eventId)
-- (services/alert-worker-go/internal/handler/cloud_tasks.go:168, called
-- once per queue-delivery Cloud Task, keyed only by event id) and the
-- apps/api tts.ts route it calls both take only an event id.
--
-- Two ways to close this:
--   (a) Thread queue/delivery context through Enricher.Enrich and the
--       tts.ts route/request contract, so a single call can ask "is THIS
--       queue muted".
--   (b) Teach get_alert_tts_input itself "are ALL of this event's fan-out
--       queues muted", using only the event id it already receives.
--
-- (b) is correct here. Synthesis is legitimately shared across every
-- non-muted queue's delivery of the same event (one alert_tts_audio row
-- per event, not per queue -- see 0101's header). "Should we pay for this"
-- is therefore never a per-queue question, only a per-event one: filter
-- exactly like get_overlay_events already does. (a) would require
-- widening a cross-service interface (Enricher, defined in
-- services/alert-worker-go, another lane's surface) and the Cloud Tasks
-- command payload that carries no queue id today (produced upstream of
-- this repo's owned surface) purely to reconstruct a fact -- "which
-- queues does this event fan out to" -- that SQL can already answer from
-- event_outbox_deliveries without any new parameter. (b) needs zero
-- interface changes anywhere: every existing caller (alert-worker-go's
-- Enrich, however many times it is invoked per event) already asks the
-- same event-scoped question and gets the same event-scoped answer.
--
-- eligible now additionally requires: at least one of this event's
-- fan-out deliveries targets a queue that is (1) not muted and (2) not
-- closed. Closed queues can never display the event at all (0101's own
-- get_overlay_events join requires queue.closed_at is null), so counting
-- a closed queue as "would have listened" would keep paying for audio
-- nobody could ever see or hear; deliberately NOT filtering on
-- queue.is_paused here, since pause is temporary/reversible and, unlike
-- mute/close, is not a signal that the queue is walking away from TTS --
-- an unpaused-by-playback-time queue must still get audio it was never
-- muted for. When there are no fan-out deliveries at all for the event
-- yet (should not happen -- delivery rows are created before the Cloud
-- Task that triggers Enrich ever fires -- see this migration's header),
-- eligibility falls back to true rather than silently blocking synthesis
-- on an absence this function has no business treating as "muted".
create or replace function app_private.get_alert_tts_input(target_event_id uuid)
returns table (
  event_id uuid,
  message text,
  locale text,
  voice_id text,
  model text,
  enabled boolean,
  eligible boolean
)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  with source_event as (
    select event.id, event.payload, event.channel_id, event.config_snapshot_version
      from public.alert_events event
     where event.id = target_event_id
  ), config as (
    select source_event.*, coalesce(channel_config.values, '{}'::jsonb) as values
      from source_event
      left join public.channel_configs channel_config
        on channel_config.channel_id = source_event.channel_id
       and channel_config.version = source_event.config_snapshot_version
  ), bracket as (
    select config.*, item as bracket
      from config
      left join lateral jsonb_array_elements(coalesce(config.values -> 'brackets', '[]'::jsonb)) item on true
     where (item is null
        or ((item ->> 'amountMinPaise') ~ '^[0-9]+$'
        and (config.payload ->> 'amountPaise') ~ '^[0-9]+$'
        and (item ->> 'amountMinPaise')::bigint <= (config.payload ->> 'amountPaise')::bigint
        and (item ->> 'amountMaxPaise') is null
        or ((item ->> 'amountMaxPaise') ~ '^[0-9]+$'
        and (config.payload ->> 'amountPaise') ~ '^[0-9]+$'
        and (item ->> 'amountMinPaise')::bigint <= (config.payload ->> 'amountPaise')::bigint
        and (item ->> 'amountMaxPaise')::bigint >= (config.payload ->> 'amountPaise')::bigint)))
     order by case when item is null then 0 else 1 end, (item ->> 'amountMinPaise')::bigint desc nulls last
     limit 1
  ), tier_limit as (
    select bracket.*,
           coalesce((
             select (entitlement.values ->> 'maxCharLimit')::integer
               from public.channel_entitlement_versions entitlement
              where entitlement.channel_id = bracket.channel_id
              order by entitlement.version desc
              limit 1
           ), 100) as tier_max_char_limit,
           case when (bracket.payload ->> 'amountPaise') ~ '^[0-9]+$'
                then (bracket.payload ->> 'amountPaise')::bigint
                else 0
           end as amount_paise
      from bracket
  ), fanout as (
    -- No fan-out rows at all -> nothing to disqualify synthesis, so this
    -- stays true (see header). At least one non-muted, non-closed target
    -- queue -> true. Every target queue muted or closed -> false, and
    -- that is the whole fix: no queue would ever have heard the audio, so
    -- it is never worth paying Sarvam or spending quota for it.
    select coalesce(bool_or(queue.tts_muted_at is null and queue.closed_at is null), true) as any_listening_queue
      from tier_limit
      left join public.event_outbox_deliveries delivery on delivery.event_id = tier_limit.id
      left join public.alert_queues queue on queue.id = delivery.queue_id
  )
  select tier_limit.id,
         left(
           coalesce(tier_limit.payload ->> 'message', ''),
           least(app_private.tts_amount_char_limit(tier_limit.amount_paise), tier_limit.tier_max_char_limit)
         ),
         coalesce(nullif(tier_limit.values ->> 'locale', ''), 'en-IN'),
         nullif(tier_limit.values -> 'tts' ->> 'voiceId', ''),
         nullif(tier_limit.values -> 'tts' ->> 'model', ''),
         coalesce((tier_limit.values -> 'tts' ->> 'enabled')::boolean, false),
         coalesce((tier_limit.bracket ->> 'ttsEligible')::boolean, true) and fanout.any_listening_queue
    from tier_limit, fanout
   where coalesce((tier_limit.values -> 'tts' ->> 'enabled')::boolean, false)
     and coalesce((tier_limit.bracket ->> 'ttsEligible')::boolean, true)
$$;

revoke execute on function app_private.get_alert_tts_input(uuid) from public;
grant execute on function app_private.get_alert_tts_input(uuid) to bsa_app;
