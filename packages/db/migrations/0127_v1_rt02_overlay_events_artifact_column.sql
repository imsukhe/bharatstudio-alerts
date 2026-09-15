-- RT-02 channel-keyed fanout (FULL-PRODUCT-DEFINITION.md §19.0 RT-02, §19.4;
-- register row 31.18.0). Per-channel deduplicated replay means one durable
-- read is shared across every session of a channel at the same cursor. That
-- is only safe if the shared read never bakes a session-identifying value
-- into the row it hands out: app_private.get_overlay_events (0067, 0096,
-- 0101) has always composed `ttsAudioUrl` as
-- '/v1/overlay-audio/' || target_overlay_id || '/' || artifact.id, which is
-- correct for exactly the one overlay session that called it and wrong for
-- every other session on the same channel that a shared result would be
-- handed to — it would leak that first session's own overlayId into a
-- different session's SSE payload and point its audio fetch at the wrong
-- session entirely.
--
-- Fix: this function stops composing the URL. It now returns the resolved
-- artifact id as its own column (`tts_audio_artifact_id`), governed by the
-- exact same mute check (0101/0098) the URL used to be governed by, so a
-- retention-deleted artifact or a muted queue still yields null here exactly
-- as `ttsAudioUrl: null` did before. The caller (apps/api's overlay store,
-- `composeOverlayEvent`) composes the final `ttsAudioUrl` per session, from
-- this id and THAT session's own overlayId — never the id of whichever
-- session happened to run the shared query. `ttsAudioDurationMs` stays
-- computed here: it carries no identity, so there is nothing to leak.
--
-- PostgreSQL does not permit CREATE OR REPLACE to change a function's OUT
-- column shape (adding `tts_audio_artifact_id`), so this function is dropped
-- and recreated in this forward migration, matching the precedent in
-- 0113_v1_l14_public_profile_projection_minimization.sql. Its input
-- signature, every `where`/`join` clause, and its grants are otherwise
-- byte-for-byte unchanged from 0101's definition.

drop function app_private.get_overlay_events(uuid, timestamptz, uuid, integer);

create function app_private.get_overlay_events(
  target_overlay_id uuid, target_after_created_at timestamptz,
  target_after_delivery_id uuid, target_limit integer
)
returns table (cursor text, event_id uuid, event_type text, trace_id text,
  created_at timestamptz, payload jsonb, tts_audio_artifact_id uuid)
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
           -- ttsAudioUrl moved out of this jsonb in RT-02/0127 -- see this
           -- migration's header. `tts_audio_artifact_id` (its own returned
           -- column, same mute-aware null below) is the only source the
           -- caller has for composing it, per session.
           'ttsAudioDurationMs', case when queue.tts_muted_at is not null then null else artifact.duration_ms end,
           'ttsFallbackReason', event.payload ->> 'ttsFallbackReason',
           'watermark', coalesce(tier_lookup.tier, 'free') = 'free'),
         -- L07 mute (0098 alert_queues.tts_muted_at) applies here exactly as
         -- it applied to the old inline ttsAudioUrl: a muted queue's overlay
         -- never receives an artifact id for its own deliveries, even when
         -- the underlying event audio was synthesized for another,
         -- non-muted queue sharing the same event. A retention-deleted
         -- artifact (no matching row in alert_tts_audio) yields the same
         -- null artifact.id it always did.
         case when artifact.id is null or queue.tts_muted_at is not null then null else artifact.id end
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
