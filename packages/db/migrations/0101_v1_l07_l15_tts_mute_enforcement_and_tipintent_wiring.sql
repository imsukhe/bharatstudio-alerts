-- L07/L15 wiring gaps closed from this lane's owned surface only
-- (services/youtube-poller-go/** and this migration). Depends on
-- 0001-0100 (0100 owned/written by a concurrent lane; this file does not
-- read, assume, or depend on its content beyond "some migration numbered
-- 0100 exists or does not yet exist" -- it only adds new objects and
-- create-or-replaces functions this lane already owns the previous
-- version of). Modifies no existing migration file.
--
-- GAP 1 -- TTS MUTE WAS PERSISTED (0098: alert_queues.tts_muted_at) BUT
-- NEVER ENFORCED.
--
--   Where "speaking" actually happens: TTS synthesis
--   (POST /internal/v1/tts/events/:eventId, apps/api/src/routes/tts.ts,
--   apps/api owned -- read-only to this lane) is called once PER EVENT,
--   not per queue -- services/alert-worker-go/internal/handler/
--   cloud_tasks.go:168-169 calls Enricher.Enrich(ctx, delivery.EventID)
--   once per delivery task, keyed only by event id, and
--   app_private.get_alert_tts_input(target_event_id) (0081/0096, also
--   apps/api-adjacent SQL) has no queue/delivery parameter at all. A
--   channel event can fan out to several queues (several
--   event_outbox_deliveries rows, one per queue_bindings match); the
--   synthesized audio is cached once on the event
--   (alert_tts_audio/event.payload.ttsAudioArtifactId) and is legitimately
--   shared by every non-muted queue that also receives that event. So
--   "does this queue speak" can never be correctly decided at synthesis
--   time using only an event id -- muting queue A must not silence queue
--   B's playback of the same event, and the call that would need to know
--   which queue triggered it (alert-worker-go's Enrich call, or the
--   tts.ts route accepting a queue/delivery id) lives in two components
--   this lane does not own: services/alert-worker-go (another service)
--   and apps/api/src/routes/tts.ts (apps/, read-only). That part of the
--   fix is NOT implemented here -- it would require changing the Enricher
--   interface signature (cloud_tasks.go) and/or the tts.ts route contract
--   to carry a queue/delivery id, both out of this lane's ownership.
--
--   What IS correctly, fully enforceable from SQL alone: the per-queue,
--   per-delivery READ path that actually puts audio in front of a viewer.
--   app_private.get_overlay_events (0067/0096) already joins
--   public.alert_queues queue on delivery.queue_id for every delivery it
--   returns -- queue.tts_muted_at is already sitting right there. This
--   redefinition (create or replace; 0096's function is otherwise
--   untouched) nulls out ttsAudioUrl/ttsAudioDurationMs whenever the
--   delivering queue is currently muted, while leaving the delivery
--   itself (and its visual alert.ready/alert.hold event) untouched --
--   muting suppresses only the audio for that queue's viewers, exactly
--   the forward-looking, queue-scoped, visual-still-fires semantics 0098's
--   own column comment describes. Synthesis may still occur (paid for
--   another, non-muted queue sharing the event, or wasted if literally
--   every fanned-out queue happens to be muted); this migration cannot
--   change that without the apps/api-owned tts.ts route accepting queue
--   context, which is out of scope here (see above).
--
--   Cancel is deliberately NOT touched here: 0098 already made
--   'tts_cancelled' a terminal event_outbox_deliveries status, and
--   get_overlay_events already filters to
--   `delivery.status in ('ready', 'displayed')` -- a cancelled delivery
--   was already excluded before this migration. Cancel and mute stay on
--   two different mechanisms (delivery-status transition vs. a
--   queue-level read-time filter) exactly because they are different
--   operations on different targets, per this task's own instruction.
--
-- GAP 2 -- TIPINTENT HAD NO CALLER.
--
--   services/youtube-poller-go/internal/chatcommand parses `!tip` but the
--   poller never called it and never called
--   POST /v1/public/internal/tip-intents (0097, secret-authenticated --
--   see apps/api/src/routes/public.ts). Wired in this lane's Go code
--   (internal/tipintent, internal/store/tipintent.go, poller.go); the
--   piece that belongs here is the idempotency ledger: the endpoint's
--   request body (routes/public.ts, additionalProperties: false) carries
--   no chat-message-id field at all, so nothing in 0097's schema or
--   contract can dedupe "the same chat message reprocessed by overlapping
--   polling". That field cannot be added here (it is apps/'s request
--   schema, read-only to this lane), so the idempotency key is enforced
--   entirely on this lane's own side: a unique (channel_id,
--   source_chat_message_id) reservation, taken BEFORE the poller ever
--   calls the create endpoint. A second attempt for the same chat message
--   id (retry, overlapping page, reprocessed page after a held cursor)
--   loses the unique-insert race and the poller never calls create again
--   for it -- the same "database guarantee, not just a caller-side
--   check" property alert_events_external_source_unique (0091) gives
--   youtube_event_ingest_failures' sibling table,
--   app_private.record_youtube_alert_event.

-- ---------------------------------------------------------------------------
-- GAP 1. Mute enforcement at the overlay-read layer.
-- ---------------------------------------------------------------------------
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
           -- L07 mute (0098 alert_queues.tts_muted_at, enforced here --
           -- see this migration's header): a muted queue's overlay never
           -- receives a TTS url/duration for its own deliveries, even
           -- when the underlying event audio was synthesized for another,
           -- non-muted queue sharing the same event. The alert itself
           -- (this whole jsonb row) is otherwise unaffected -- mute is
           -- audio-only and forward-looking, never retroactive, never
           -- visual.
           'ttsAudioUrl', case
             when artifact.id is null or queue.tts_muted_at is not null then null
             else '/v1/overlay-audio/' || target_overlay_id::text || '/' || artifact.id::text
           end,
           'ttsAudioDurationMs', case when queue.tts_muted_at is not null then null else artifact.duration_ms end,
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

-- ---------------------------------------------------------------------------
-- GAP 2. Per-chat-message idempotency ledger for TipIntent creation.
--
-- Insert-only reservation, not a cache: a row existing at all (any status)
-- means "this lane already attempted to turn this exact chat message into
-- a TipIntent" and the poller must never attempt it again. 'failed' rows
-- are terminal -- a permanently-rejected message is not retried (matching
-- youtube_event_ingest_failures' own "recorded, not dropped, not retried"
-- shape); a row that never gets past 'pending' because the poller crashed
-- mid-call is reclaimed by release_youtube_tip_intent_reservation below,
-- not by a background sweep (none is added by this migration).
-- ---------------------------------------------------------------------------
create table public.youtube_tip_intent_dedup (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  source_platform text not null default 'youtube' check (source_platform in ('youtube')),
  source_chat_message_id text not null check (char_length(source_chat_message_id) between 1 and 128),
  status text not null default 'pending' check (status in ('pending', 'created', 'failed')),
  error_detail text check (error_detail is null or char_length(error_detail) <= 2000),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  -- The idempotency key itself: a database-level guarantee (ON CONFLICT DO
  -- NOTHING in reserve_youtube_tip_intent below), not merely a
  -- caller-side check -- the same property alert_events_external_source_unique
  -- (0091) gives record_youtube_alert_event.
  unique (channel_id, source_platform, source_chat_message_id)
);

create index youtube_tip_intent_dedup_channel_idx
  on public.youtube_tip_intent_dedup (channel_id, created_at desc);

alter table public.youtube_tip_intent_dedup enable row level security;
-- No RLS policy: every access goes through the SECURITY DEFINER functions
-- below, exempt from RLS as table owner -- same shape as tip_intents
-- (0097) and youtube_event_ingest_failures (0094). No role, not even
-- bsa_connector_poller, gets a raw grant on this table.
revoke all on public.youtube_tip_intent_dedup from public;
revoke all on public.youtube_tip_intent_dedup from bsa_app;
revoke all on public.youtube_tip_intent_dedup from bsa_connector_poller;

-- Reserve a chat message id for TipIntent creation. Returns reserved=false
-- (and no new row) when this (channel, message id) already has a row in
-- any status -- the caller (poller) must treat that as "already handled,
-- do not create a TipIntent", full stop, whether the earlier attempt
-- succeeded, failed permanently, or is another goroutine's in-flight
-- 'pending' row from an overlapping poll.
create or replace function app_private.reserve_youtube_tip_intent(
  target_id uuid,
  target_channel_id uuid,
  target_source_chat_message_id text
)
returns table (dedup_id uuid, reserved boolean)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  inserted_id uuid;
begin
  if target_id is null or target_channel_id is null or target_source_chat_message_id is null
     or length(target_source_chat_message_id) = 0 then
    raise exception 'invalid youtube tip intent reservation' using errcode = '22023';
  end if;

  insert into public.youtube_tip_intent_dedup (
    id, channel_id, source_platform, source_chat_message_id, status, created_at, updated_at
  ) values (
    target_id, target_channel_id, 'youtube', target_source_chat_message_id, 'pending', current_timestamp, current_timestamp
  )
  on conflict (channel_id, source_platform, source_chat_message_id) do nothing
  returning id into inserted_id;

  return query select target_id, (inserted_id is not null);
end
$$;

-- Successful creation: the reservation becomes permanent (never deleted,
-- never re-reserved for this chat message id again).
create or replace function app_private.mark_youtube_tip_intent_created(target_dedup_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  update public.youtube_tip_intent_dedup
     set status = 'created', updated_at = current_timestamp
   where id = target_dedup_id and status = 'pending';
end
$$;

-- Permanent failure (e.g. secret misconfigured, request rejected, service
-- gone -- see internal/tipintent's classifier): recorded and terminal,
-- exactly like record_youtube_ingest_failure. The reservation is kept so
-- this exact chat message id is never retried, but it does not block a
-- later, different !tip from the same viewer (a different message id).
create or replace function app_private.mark_youtube_tip_intent_failed(
  target_dedup_id uuid,
  target_error_detail text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  update public.youtube_tip_intent_dedup
     set status = 'failed', error_detail = left(coalesce(target_error_detail, ''), 2000), updated_at = current_timestamp
   where id = target_dedup_id and status = 'pending';
end
$$;

-- Transient failure: the reservation is released (deleted, not marked
-- failed) so the SAME chat message id can be re-attempted once the page
-- is re-fetched next cycle -- mirroring InsertLiveEvent's own transient
-- path, which never marks a message "handled" until it durably is one.
-- Only a still-'pending' row is released, so this can never undo an
-- already-'created' or already-'failed' terminal outcome recorded by a
-- concurrent caller.
create or replace function app_private.release_youtube_tip_intent_reservation(target_dedup_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  delete from public.youtube_tip_intent_dedup
   where id = target_dedup_id and status = 'pending';
end
$$;

revoke execute on function app_private.reserve_youtube_tip_intent(uuid, uuid, text) from public;
revoke execute on function app_private.mark_youtube_tip_intent_created(uuid) from public;
revoke execute on function app_private.mark_youtube_tip_intent_failed(uuid, text) from public;
revoke execute on function app_private.release_youtube_tip_intent_reservation(uuid) from public;

grant execute on function app_private.reserve_youtube_tip_intent(uuid, uuid, text) to bsa_connector_poller;
grant execute on function app_private.mark_youtube_tip_intent_created(uuid) to bsa_connector_poller;
grant execute on function app_private.mark_youtube_tip_intent_failed(uuid, text) to bsa_connector_poller;
grant execute on function app_private.release_youtube_tip_intent_reservation(uuid) to bsa_connector_poller;
