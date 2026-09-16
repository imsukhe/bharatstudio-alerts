-- RT-01/RT-02 follow-up, 2026-09-16: drop the two cursor parameters
-- `app_private.get_overlay_events` has not read since 0064, and carry the
-- reason they must NOT come back into the live definition.
--
-- WHY THEY ARE INERT -- this is the part that matters, and until now it lived
-- seventy-two migrations away in 0055's header, where the next person to
-- recreate this function would never see it:
--
--     "The cursor is an acknowledgement checkpoint, not an eligibility
--      filter: an older row that is still unacknowledged must remain
--      replayable or it can be skipped permanently after the newer cursor is
--      acknowledged."
--
-- Deliveries can be published out of order (task enqueueing, network delivery
-- and worker execution all complete out of order). So filtering this read by
-- cursor POSITION can strand an older, still-unacknowledged delivery forever
-- once a newer one is acknowledged. That is a correctness rule, not a
-- preference, and it is why the filter must not be "restored".
--
-- HOW THE RULE IS HONOURED NOW. Acknowledgement lives in
-- `event_outbox_deliveries.status`, and this query admits only
-- `('ready', 'displayed')` -- `acknowledged` is excluded outright.
-- Acknowledgement IS the eligibility filter, so a positional cursor filter is
-- redundant beside it and, per 0055, harmful. The parameters survived from the
-- 0062-era shape (which did admit `acknowledged` rows and therefore did need
-- the cursor) through four recreates: 0064, 0067, 0096 and 0127.
--
-- WHAT WAS ACTUALLY WRONG. Nothing about the behaviour. The signature lied to
-- its caller: `apps/api/src/db/overlay-store.ts`'s `replayRaw` parsed a cursor
-- out of `Last-Event-ID` and passed it into two parameters nothing reads, so
-- any reader of that call site would reasonably conclude replay resumes from
-- the cursor. It does not, and it must not.
--
-- The HTTP surface is unchanged by this migration: the replay endpoint still
-- accepts `Last-Event-ID` and still does not use it as a resume point. Whether
-- it should keep accepting it silently, reject it, or say so in the contract is
-- a contract decision referred to the owner, not settled here -- see
-- bharatstudio-requirements/reviews/2026-09-16-overlay-events-cursor-parameters.md
--
-- The body below is carried over from 0127 UNCHANGED except for the removed
-- parameters -- no predicate, join, ordering, limit or returned column differs.
--
-- Depends on 0001-0136. Modifies no existing migration file.

drop function if exists app_private.get_overlay_events(uuid, timestamptz, uuid, integer);

create function app_private.get_overlay_events(
  target_overlay_id uuid, target_limit integer
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
revoke execute on function app_private.get_overlay_events(uuid, integer) from public;
grant execute on function app_private.get_overlay_events(uuid, integer) to bsa_app;
