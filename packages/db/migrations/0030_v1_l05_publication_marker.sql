-- L05 publication marker.
--
-- A worker publication is a wake-up optimisation, not browser acknowledgement.
-- The delivery must remain replayable until the overlay acknowledges it, but a
-- successful publication must not be returned by every later pump scan.  This
-- marker separates those two facts without changing the durable replay path.

alter table public.event_outbox_deliveries
  add column if not exists published_at timestamptz;

create index if not exists event_outbox_deliveries_unpublished_ready_idx
  on public.event_outbox_deliveries (status, next_action_at, lease_until, created_at)
  where published_at is null;

create or replace function app_private.release_event_delivery(
  target_delivery_id uuid,
  target_lease_token uuid
)
returns table (delivery_id uuid, state_version bigint, status text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  local_outbox_id uuid;
begin
  update public.event_outbox_deliveries delivery
     set status = 'ready',
         published_at = coalesce(delivery.published_at, current_timestamp),
         next_action_at = null,
         last_error_code = null,
         state_version = delivery.state_version + 1,
         lease_token = null,
         lease_until = null,
         updated_at = current_timestamp
   where delivery.id = target_delivery_id
     and delivery.lease_token = target_lease_token
     and delivery.lease_until > current_timestamp
     and delivery.status = 'ready'
  returning delivery.id, delivery.outbox_id, delivery.state_version, delivery.status
    into delivery_id, local_outbox_id, state_version, status;

  if not found then
    return;
  end if;

  perform app_private.refresh_event_outbox_status(local_outbox_id);
  return next;
end
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
   where delivery.published_at is null
     and delivery.status in ('pending', 'ready', 'failed_retriable')
     and (delivery.lease_until is null or delivery.lease_until <= current_timestamp)
     and (delivery.next_action_at is null or delivery.next_action_at <= current_timestamp)
   order by delivery.next_action_at nulls first,
            delivery.created_at asc,
            delivery.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

revoke execute on function app_private.release_event_delivery(uuid, uuid) from public;
grant execute on function app_private.release_event_delivery(uuid, uuid) to bsa_alert_worker;
revoke execute on function app_private.list_ready_event_deliveries(integer) from public;
grant execute on function app_private.list_ready_event_deliveries(integer) to bsa_alert_worker;
