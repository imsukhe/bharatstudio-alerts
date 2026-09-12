-- L03: MASTER-PLAN §10.3 items 5, 6, 7 (§3.2 has the locked tier values this
-- migration builds on top of, unchanged: maxCharLimit 100/150/300/500,
-- ttsMonthlyCharQuota 0/20000/40000/60000).
--
-- Item 5 — browser/device TTS fallback: the overlay needs to know, per
-- delivered event, THAT premium TTS did not happen and WHY, so it can decide
-- to speak the already-present payload.message with the Web Speech API
-- instead of going silent. Nothing durable recorded that reason before this
-- migration — app_private.meter_tts_usage (0081) returns it transiently to
-- whatever calls app_private.meter_tts_usage, but never writes it back onto
-- the event, so the overlay stream (app_private.get_overlay_events, 0067)
-- had nothing to read. This migration adds
-- app_private.store_alert_tts_fallback_reason (mirrors
-- app_private.store_alert_tts_audio's write-back shape) and threads
-- ttsFallbackReason through get_overlay_events' payload. It never touches
-- alert_tts_usage_monthly or meter_tts_usage — recording why synthesis was
-- skipped is not metered usage, and must never become billable.
--
-- Item 6 — amount-tiered TTS character limits: a larger tip may read out
-- more text than a small one. The schema's only signal for "how big was
-- this tip" at TTS-input time is alert_events.payload->>'amountPaise'
-- (already used for the same purpose by the creator-configurable bracket
-- system in 0067/0080's config snapshot). This migration adds a SEPARATE,
-- platform-enforced ladder (app_private.tts_amount_char_limit) that a
-- creator's own bracket config cannot loosen, and folds it into
-- app_private.get_alert_tts_input (0067) so the server-side truncation that
-- actually bounds what gets sent to the paid provider — and therefore what
-- gets metered and billed — uses whichever of the amount ladder and the
-- entitlement's maxCharLimit (§3.2) is tighter. See the ladder's own comment
-- for the bands and the "tighter wins" comment on get_alert_tts_input for
-- why the minimum of the two, never either alone, is correct.
--
-- Item 7 — watermark on Free only: the overlay renders the BharatStudio
-- attribution itself (apps/web/app/overlay/[overlayId]/page.tsx, not this
-- repo's governance doc), but it only knows the delivery, not the channel's
-- current tier. get_overlay_events already joins the delivery back to
-- overlay_sessions.channel_id, so this migration adds one more lateral
-- lookup of that channel's latest channel_entitlement_versions.tier and
-- folds `watermark: tier = 'free'` into the same payload jsonb. Free is the
-- ONLY tier watermarked (MASTER-PLAN §3.4, 2026-09-02 owner decision,
-- amending active/launch/04_TEMPLATE_LIBRARY_AUTHORITY.md in the
-- bharatstudio-requirements repo — that file is not in this repo and is not
-- edited here; see this task's report for the amendment record).

-- Item 6: the amount ladder. Minimum tip is ₹10 = 1000 paise (§3.5); bands
-- below chosen so a small tip cannot burn a large synthesis, while a large
-- tip is allowed a materially longer read:
--
--   ₹10   – ₹99    (   1,000 –    9,900 paise)  ->  40 chars
--   ₹100  – ₹499   (  10,000 –   49,900 paise)  ->  80 chars
--   ₹500  – ₹999   (  50,000 –   99,900 paise)  -> 150 chars
--   ₹1,000– ₹4,999 ( 100,000 –  499,900 paise)  -> 250 chars
--   ₹5,000 and up  ( 500,000+ paise)            -> 400 chars
--
-- This is independent of, and never widens, the per-tier maxCharLimit
-- ceiling (100/150/300/500, §3.2) — see get_alert_tts_input below for how
-- the two compose.
create or replace function app_private.tts_amount_char_limit(target_amount_paise bigint)
returns integer
language plpgsql
immutable
as $$
begin
  if target_amount_paise is null or target_amount_paise < 10000 then
    return 40;
  elsif target_amount_paise < 50000 then
    return 80;
  elsif target_amount_paise < 100000 then
    return 150;
  elsif target_amount_paise < 500000 then
    return 250;
  else
    return 400;
  end if;
end
$$;

revoke execute on function app_private.tts_amount_char_limit(bigint) from public;
grant execute on function app_private.tts_amount_char_limit(bigint) to bsa_app;

-- Item 5: durable write-back of why a synthesis attempt produced no audio,
-- for the two reasons that mean "browser TTS may still speak this" (never
-- for plain ineligibility — an event whose creator never turned TTS on, or
-- whose bracket excludes it, was never going to speak at all, on any tier).
create or replace function app_private.store_alert_tts_fallback_reason(
  target_event_id uuid,
  target_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_event_id is null then
    raise exception 'missing TTS fallback event id' using errcode = '22023';
  end if;
  if target_reason not in ('tier_not_entitled', 'quota_exhausted') then
    raise exception 'invalid TTS fallback reason' using errcode = '22023';
  end if;

  update public.alert_events
     set payload = payload || jsonb_build_object('ttsFallbackReason', target_reason)
   where id = target_event_id;

  if not found then
    raise exception 'alert event not found for TTS fallback reason' using errcode = '23503';
  end if;
end
$$;

revoke execute on function app_private.store_alert_tts_fallback_reason(uuid, text) from public;
grant execute on function app_private.store_alert_tts_fallback_reason(uuid, text) to bsa_app;

-- Item 6 (continued): get_alert_tts_input (0067) now also resolves the
-- channel's current maxCharLimit and applies LEAST(amount ladder,
-- maxCharLimit) instead of the old flat `left(..., 500)`. 500 remains the
-- absolute outer bound only because it is Studio's own maxCharLimit — no
-- tier can exceed it, so no separate clamp is needed.
--
-- Tighter-wins rationale: maxCharLimit is a plan ceiling ("you paid for at
-- most this much overlay text, ever"); the amount ladder is a per-event
-- ceiling ("this specific tip earned at most this much of that ceiling").
-- Neither is allowed to widen the other — a Studio creator's ₹599 plan does
-- not entitle a ₹10 tip to a 500-character read, and a ₹50,000 super-tip on
-- Pro does not get more than Pro's 150-character ceiling. LEAST() is the
-- only combinator that preserves both constraints simultaneously.
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
  )
  select id,
         left(
           coalesce(payload ->> 'message', ''),
           least(app_private.tts_amount_char_limit(amount_paise), tier_max_char_limit)
         ),
         coalesce(nullif(values ->> 'locale', ''), 'en-IN'),
         nullif(values -> 'tts' ->> 'voiceId', ''),
         nullif(values -> 'tts' ->> 'model', ''),
         coalesce((values -> 'tts' ->> 'enabled')::boolean, false),
         coalesce((bracket ->> 'ttsEligible')::boolean, true)
    from tier_limit
   where coalesce((values -> 'tts' ->> 'enabled')::boolean, false)
     and coalesce((bracket ->> 'ttsEligible')::boolean, true)
$$;

-- Item 5 + 7 (continued): get_overlay_events (0067) now also folds
-- `ttsFallbackReason` (from the alert_events.payload write-back above, so
-- the overlay can distinguish "no audio because never eligible" from "no
-- audio because entitlement/quota says fall back to the browser voice") and
-- `watermark` (true only when the delivering channel's current tier is
-- 'free' — everything else, including an unknown/missing entitlement row,
-- which defaults to 'free' the same way every other §3.2 lookup in this
-- codebase does) into the same payload jsonb the overlay already reads.
create or replace function app_private.get_overlay_events(
  target_overlay_id uuid, target_after_created_at timestamptz,
  target_after_delivery_id uuid, target_limit integer
)
returns table (cursor text, event_id uuid, event_type text, trace_id text,
  created_at timestamptz, payload jsonb)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select to_char(delivery.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || delivery.id::text,
         event.id, case when delivery.status = 'held' then 'alert.hold' else 'alert.ready' end,
         event.trace_id, delivery.created_at,
         event.payload || jsonb_build_object('deliveryId', delivery.id, 'queueId', delivery.queue_id,
           'bindingId', delivery.binding_id, 'configSnapshotVersion', delivery.config_snapshot_version,
           'configSnapshot', coalesce(config.values, '{}'::jsonb), 'deliverySequence', delivery.delivery_sequence,
           'sourcePriority', delivery.source_priority, 'overrideValues', coalesce(delivery.override_values, '{}'::jsonb),
           'ttsAudioUrl', case when artifact.id is null then null else '/v1/overlay-audio/' || target_overlay_id::text || '/' || artifact.id::text end,
           'ttsAudioDurationMs', artifact.duration_ms,
           'ttsFallbackReason', event.payload ->> 'ttsFallbackReason',
           'watermark', coalesce(tier_lookup.tier, 'free') = 'free')
    from public.event_outbox_deliveries delivery
    join public.event_outbox outbox on outbox.id = delivery.outbox_id
    join public.alert_events event on event.id = delivery.event_id
    left join public.channel_configs config on config.channel_id = event.channel_id and config.version = delivery.config_snapshot_version
    left join public.alert_tts_audio artifact on artifact.id = case
      when event.payload ->> 'ttsAudioArtifactId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then (event.payload ->> 'ttsAudioArtifactId')::uuid
      else null
    end
    join public.overlay_sessions session on session.id = target_overlay_id
    join public.alert_queues queue on queue.id = delivery.queue_id and queue.closed_at is null and queue.is_paused = false
    left join lateral (
      select entitlement.tier
        from public.channel_entitlement_versions entitlement
       where entitlement.channel_id = event.channel_id
       order by entitlement.version desc
       limit 1
    ) tier_lookup on true
   where target_overlay_id = app_private.current_overlay_session_id()
     and session.id = target_overlay_id and event.channel_id = session.channel_id
   and session.revoked_at is null and session.expires_at > current_timestamp
     and delivery.status in ('ready', 'displayed')
   and app_private.delivery_dispatch_allowed(delivery.event_id, delivery.config_snapshot_version)
   order by delivery.created_at asc, delivery.id asc
   limit greatest(1, least(target_limit, 100))
$$;

revoke execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) from public;
grant execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) to bsa_app;
