-- L32: expose the immutable per-delivery routing snapshot to the overlay.
-- The shared alert payload is event-level; queue/binding overrides are
-- delivery-level and must be projected separately for each permitted queue.
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
           when delivery.status in ('displayed', 'acknowledged') then 'alert.complete'
           else 'alert.ready'
         end,
         event.trace_id,
         delivery.created_at,
         event.payload || jsonb_build_object(
           'deliveryId', delivery.id,
           'queueId', delivery.queue_id,
           'bindingId', delivery.binding_id,
           'configSnapshotVersion', delivery.config_snapshot_version,
           'deliverySequence', delivery.delivery_sequence,
           'sourcePriority', delivery.source_priority,
           'overrideValues', coalesce(delivery.override_values, '{}'::jsonb)
         )
    from public.event_outbox_deliveries delivery
    join public.event_outbox outbox on outbox.id = delivery.outbox_id
    join public.alert_events event on event.id = delivery.event_id
    join public.overlay_sessions session on session.id = target_overlay_id
   where target_overlay_id = app_private.current_overlay_session_id()
     and session.id = target_overlay_id
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and delivery.status in ('ready', 'held', 'displayed', 'acknowledged')
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
