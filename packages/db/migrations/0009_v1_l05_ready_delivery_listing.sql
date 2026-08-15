-- BharatStudio Alerts v1 L05 ready-delivery task source.
--
-- Listing is intentionally read-only. Cloud Tasks task creation is idempotent
-- and the per-delivery claim function remains the mutation/duplicate guard.

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
   where delivery.status in ('pending', 'ready', 'failed_retriable')
     and (delivery.lease_until is null or delivery.lease_until <= current_timestamp)
     and (delivery.next_action_at is null or delivery.next_action_at <= current_timestamp)
   order by delivery.next_action_at nulls first,
            delivery.created_at asc,
            delivery.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

revoke execute on function app_private.list_ready_event_deliveries(integer) from public;
grant execute on function app_private.list_ready_event_deliveries(integer) to bsa_alert_worker;
grant usage on schema app_private to bsa_alert_worker;
