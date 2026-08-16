-- Server-side queue mode ordering. Presentation still owns layout/animation,
-- but the durable pump must select work in a mode-aware, deterministic order.
-- This only changes selection order; rows outside the batch remain pending and
-- are never displaced or deleted.

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
    left join public.channel_configs config
      on config.channel_id = event.channel_id and config.version = delivery.config_snapshot_version
   where delivery.status in ('pending', 'ready', 'failed_retriable')
     and delivery.published_at is null
     and (delivery.lease_until is null or delivery.lease_until <= current_timestamp)
     and (delivery.next_action_at is null or delivery.next_action_at <= current_timestamp)
     and app_private.delivery_dispatch_allowed(delivery.event_id, delivery.config_snapshot_version)
   order by
     case when config.values #>> '{queue,mode}' = 'priority'
          then delivery.source_priority + floor(extract(epoch from (current_timestamp - delivery.created_at)) / 30)::integer
          else 0 end desc,
     delivery.created_at asc, delivery.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

revoke execute on function app_private.list_ready_event_deliveries(integer) from public;
grant execute on function app_private.list_ready_event_deliveries(integer) to bsa_alert_worker;
