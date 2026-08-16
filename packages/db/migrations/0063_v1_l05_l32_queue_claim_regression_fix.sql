-- L05/L32 compatibility repair. 0062 added policy gating by replacing the
-- claim function; this version preserves the already-shipped publication
-- marker and source rate-limit compare-and-swap invariants as well.

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
  delivery_id uuid, event_id uuid, channel_id uuid, outbox_id uuid,
  queue_id uuid, binding_id uuid, source_priority integer, override_values jsonb,
  trace_id text, attempt_number integer, state_version bigint
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  candidate record;
  binding record;
  rate_limit_value text;
  rate_limit integer;
  next_allowed_at timestamptz;
begin
  select delivery.id, delivery.event_id, event.channel_id, delivery.outbox_id,
         delivery.queue_id, delivery.binding_id, delivery.source_priority,
         delivery.override_values, event.trace_id, delivery.attempt_count,
         delivery.state_version
    into candidate
    from public.event_outbox_deliveries delivery
    join public.alert_events event on event.id = delivery.event_id
   where delivery.id = target_delivery_id
     and delivery.event_id = target_event_id
     and delivery.outbox_id = target_outbox_id
     and delivery.attempt_count + 1 = target_attempt_number
     and delivery.state_version = target_state_version
     and target_lease_until > current_timestamp
     and delivery.status in ('pending', 'ready', 'failed_retriable')
     and delivery.published_at is null
     and (delivery.lease_until is null or delivery.lease_until <= current_timestamp)
     and (delivery.next_action_at is null or delivery.next_action_at <= current_timestamp)
     and app_private.delivery_dispatch_allowed(delivery.event_id, delivery.config_snapshot_version)
     and exists (select 1 from public.alert_queues queue
                  where queue.id = delivery.queue_id
                    and queue.closed_at is null and queue.is_paused = false)
   for update of delivery;

  if not found then return; end if;

  rate_limit_value := coalesce(candidate.override_values ->> 'rateLimitPerMinute', candidate.override_values ->> 'rateLimitPerMin');
  if rate_limit_value ~ '^[0-9]{1,4}$' then rate_limit := rate_limit_value::integer; end if;
  if rate_limit is not null and rate_limit between 1 and 1000 then
    select source_binding.rate_limit_window_started_at, source_binding.rate_limit_dispatch_count
      into binding
      from public.queue_bindings source_binding
     where source_binding.id = candidate.binding_id and source_binding.closed_at is null
     for update;
    if found then
      if binding.rate_limit_window_started_at is null
         or binding.rate_limit_window_started_at + interval '1 minute' <= current_timestamp then
        update public.queue_bindings
           set rate_limit_window_started_at = current_timestamp, rate_limit_dispatch_count = 1
         where id = candidate.binding_id;
      elsif binding.rate_limit_dispatch_count >= rate_limit then
        next_allowed_at := binding.rate_limit_window_started_at + interval '1 minute';
        update public.event_outbox_deliveries
           set next_action_at = next_allowed_at, last_error_code = 'rate_limited',
               state_version = public.event_outbox_deliveries.state_version + 1, updated_at = current_timestamp
         where id = candidate.id;
        return;
      else
        update public.queue_bindings
           set rate_limit_dispatch_count = rate_limit_dispatch_count + 1
         where id = candidate.binding_id;
      end if;
    end if;
  end if;

  update public.event_outbox_deliveries delivery
     set status = 'ready', attempt_count = delivery.attempt_count + 1,
         state_version = delivery.state_version + 1, lease_token = target_lease_token,
         lease_until = target_lease_until, updated_at = current_timestamp
   where delivery.id = candidate.id;

  return query select candidate.id, candidate.event_id, candidate.channel_id,
    candidate.outbox_id, candidate.queue_id, candidate.binding_id,
    candidate.source_priority, candidate.override_values, candidate.trace_id,
    candidate.attempt_count + 1, candidate.state_version + 1;
end
$$;

revoke execute on function app_private.claim_event_delivery(uuid, uuid, uuid, integer, bigint, uuid, timestamptz) from public;
grant execute on function app_private.claim_event_delivery(uuid, uuid, uuid, integer, bigint, uuid, timestamptz) to bsa_alert_worker;

create or replace function app_private.list_ready_event_deliveries(target_limit integer)
returns table (delivery_id uuid, event_id uuid, outbox_id uuid, queue_id uuid, binding_id uuid,
  attempt_number integer, state_version bigint, trace_id text)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select delivery.id, delivery.event_id, delivery.outbox_id, delivery.queue_id,
         delivery.binding_id, delivery.attempt_count + 1, delivery.state_version, event.trace_id
    from public.event_outbox_deliveries delivery
    join public.alert_events event on event.id = delivery.event_id
    join public.alert_queues queue on queue.id = delivery.queue_id
       and queue.closed_at is null and queue.is_paused = false
   where delivery.status in ('pending', 'ready', 'failed_retriable')
     and delivery.published_at is null
     and (delivery.lease_until is null or delivery.lease_until <= current_timestamp)
     and (delivery.next_action_at is null or delivery.next_action_at <= current_timestamp)
     and app_private.delivery_dispatch_allowed(delivery.event_id, delivery.config_snapshot_version)
   order by delivery.next_action_at nulls first, delivery.created_at asc, delivery.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

revoke execute on function app_private.list_ready_event_deliveries(integer) from public;
grant execute on function app_private.list_ready_event_deliveries(integer) to bsa_alert_worker;
