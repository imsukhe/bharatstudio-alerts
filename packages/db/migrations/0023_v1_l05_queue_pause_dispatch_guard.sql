-- L05 queue pause dispatch guard.
--
-- Pausing a queue must hold accepted deliveries, not discard them. Both the
-- ready-delivery pump and the per-task claim boundary therefore re-check the
-- queue state. A task already present in Cloud Tasks becomes a safe no-op
-- while paused; the durable row remains available after resume.

create or replace function app_private.claim_event_delivery(
  target_delivery_id uuid,
  target_event_id uuid,
  target_outbox_id uuid,
  target_attempt_number integer,
  target_state_version bigint,
  target_lease_token uuid,
  target_lease_until timestamptz
)
returns table (
  delivery_id uuid,
  event_id uuid,
  channel_id uuid,
  outbox_id uuid,
  queue_id uuid,
  binding_id uuid,
  source_priority integer,
  override_values jsonb,
  trace_id text,
  attempt_number integer,
  state_version bigint
)
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  update public.event_outbox_deliveries delivery
     set status = 'ready',
         attempt_count = delivery.attempt_count + 1,
         state_version = delivery.state_version + 1,
         lease_token = target_lease_token,
         lease_until = target_lease_until,
         updated_at = current_timestamp
   where delivery.id = target_delivery_id
     and delivery.event_id = target_event_id
     and delivery.outbox_id = target_outbox_id
     and delivery.attempt_count + 1 = target_attempt_number
     and delivery.state_version = target_state_version
     and target_lease_until > current_timestamp
     and delivery.status in ('pending', 'ready', 'failed_retriable')
     and (delivery.lease_until is null or delivery.lease_until <= current_timestamp)
     and (delivery.next_action_at is null or delivery.next_action_at <= current_timestamp)
     and exists (
       select 1
         from public.alert_queues queue
        where queue.id = delivery.queue_id
          and queue.closed_at is null
          and queue.is_paused = false
     )
  returning delivery.id,
            delivery.event_id,
            (select event.channel_id from public.alert_events event where event.id = delivery.event_id),
            delivery.outbox_id,
            delivery.queue_id,
            delivery.binding_id,
            delivery.source_priority,
            delivery.override_values,
            (select event.trace_id from public.alert_events event where event.id = delivery.event_id),
            delivery.attempt_count,
            delivery.state_version
$$;

create or replace function app_private.list_ready_event_deliveries(
  target_limit integer
)
returns table (
  delivery_id uuid,
  event_id uuid,
  outbox_id uuid,
  queue_id uuid,
  binding_id uuid,
  attempt_number integer,
  state_version bigint,
  trace_id text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select delivery.id,
         delivery.event_id,
         delivery.outbox_id,
         delivery.queue_id,
         delivery.binding_id,
         delivery.attempt_count + 1,
         delivery.state_version,
         event.trace_id
    from public.event_outbox_deliveries delivery
    join public.alert_events event on event.id = delivery.event_id
    join public.alert_queues queue
      on queue.id = delivery.queue_id
     and queue.closed_at is null
     and queue.is_paused = false
   where delivery.status in ('pending', 'ready', 'failed_retriable')
     and (delivery.lease_until is null or delivery.lease_until <= current_timestamp)
     and (delivery.next_action_at is null or delivery.next_action_at <= current_timestamp)
   order by delivery.next_action_at nulls first,
            delivery.created_at asc,
            delivery.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

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
           'deliverySequence', delivery.delivery_sequence,
           'sourcePriority', delivery.source_priority,
           'overrideValues', coalesce(delivery.override_values, '{}'::jsonb)
         )
    from public.event_outbox_deliveries delivery
    join public.event_outbox outbox on outbox.id = delivery.outbox_id
    join public.alert_events event on event.id = delivery.event_id
    join public.overlay_sessions session on session.id = target_overlay_id
    join public.alert_queues queue
      on queue.id = delivery.queue_id
     and queue.closed_at is null
     and queue.is_paused = false
   where target_overlay_id = app_private.current_overlay_session_id()
     and session.id = target_overlay_id
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

revoke execute on function app_private.claim_event_delivery(uuid, uuid, uuid, integer, bigint, uuid, timestamptz) from public;
revoke execute on function app_private.list_ready_event_deliveries(integer) from public;
grant execute on function app_private.claim_event_delivery(uuid, uuid, uuid, integer, bigint, uuid, timestamptz) to bsa_alert_worker;
grant execute on function app_private.list_ready_event_deliveries(integer) to bsa_alert_worker;
revoke execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) from public;
grant execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) to bsa_app;
