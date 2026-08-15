-- L03/L05 overlay replay tenant boundary.
--
-- The overlay token scopes the session, but the replay projection must also
-- bind every returned delivery to that session's channel. Without this
-- predicate, a valid session could enumerate delivery rows belonging to a
-- different channel because the projection joined the session by ID only.

create or replace function app_private.get_overlay_events(
  target_overlay_id uuid,
  target_after_created_at timestamptz,
  target_after_delivery_id uuid,
  target_limit integer
)
returns table (
  cursor text,
  event_id uuid,
  event_type text,
  trace_id text,
  created_at timestamptz,
  payload jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select to_char(delivery.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || delivery.id::text,
         event.id,
         case
           when delivery.status = 'held' then 'alert.hold'
           else 'alert.ready'
         end,
         event.trace_id,
         delivery.created_at,
         event.payload || jsonb_build_object(
           'deliveryId', delivery.id,
           'queueId', delivery.queue_id,
           'bindingId', delivery.binding_id,
           'configSnapshotVersion', delivery.config_snapshot_version,
           'configSnapshot', coalesce(config.values, '{}'::jsonb),
           'deliverySequence', delivery.delivery_sequence,
           'sourcePriority', delivery.source_priority,
           'overrideValues', coalesce(delivery.override_values, '{}'::jsonb)
         )
    from public.event_outbox_deliveries delivery
    join public.event_outbox outbox on outbox.id = delivery.outbox_id
    join public.alert_events event on event.id = delivery.event_id
    left join public.channel_configs config
      on config.channel_id = event.channel_id
     and config.version = delivery.config_snapshot_version
    join public.overlay_sessions session on session.id = target_overlay_id
    join public.alert_queues queue
      on queue.id = delivery.queue_id
     and queue.closed_at is null
     and queue.is_paused = false
   where target_overlay_id = app_private.current_overlay_session_id()
     and session.id = target_overlay_id
     and event.channel_id = session.channel_id
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and delivery.status in ('ready', 'held', 'displayed')
     and (
       target_after_created_at is null
       or delivery.created_at > target_after_created_at
       or (delivery.created_at = target_after_created_at and delivery.id > coalesce(target_after_delivery_id, '00000000-0000-0000-0000-000000000000'::uuid))
     )
   order by delivery.created_at asc, delivery.id asc
   limit greatest(1, least(target_limit, 100))
$$;

revoke execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) from public;
grant execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) to bsa_app;
