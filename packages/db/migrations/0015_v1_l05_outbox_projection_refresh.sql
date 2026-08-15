-- BharatStudio Alerts v1 global outbox projection refresh.
--
-- event_outbox.status is a read-model for history/Companion surfaces. It is
-- never used to decide whether an individual queue may progress. The durable
-- per-queue delivery rows remain the dispatch authority.

create or replace function app_private.refresh_event_outbox_status(target_outbox_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  next_status text;
begin
  perform 1
    from public.event_outbox outbox
   where outbox.id = target_outbox_id
   for update;
  if not found then
    return null;
  end if;

  select case
    when exists (select 1 from public.event_outbox_deliveries delivery
                  where delivery.outbox_id = target_outbox_id
                    and delivery.status in ('pending', 'ready', 'held')) then 'pending'
    when exists (select 1 from public.event_outbox_deliveries delivery
                  where delivery.outbox_id = target_outbox_id
                    and delivery.status = 'failed_retriable') then 'retryable_failure'
    when exists (select 1 from public.event_outbox_deliveries delivery
                  where delivery.outbox_id = target_outbox_id
                    and delivery.status = 'quarantined') then 'quarantined'
    else 'completed'
  end
    into next_status;

  update public.event_outbox
     set status = next_status,
         updated_at = current_timestamp
   where id = target_outbox_id;
  return next_status;
end
$$;

create or replace function app_private.retry_event_delivery(
  target_delivery_id uuid,
  target_lease_token uuid,
  target_next_action_at timestamptz,
  target_error_code text
)
returns table (delivery_id uuid, state_version bigint)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  local_outbox_id uuid;
begin
  update public.event_outbox_deliveries delivery
     set status = 'failed_retriable',
         next_action_at = target_next_action_at,
         last_error_code = nullif(left(target_error_code, 160), ''),
         state_version = delivery.state_version + 1,
         lease_token = null,
         lease_until = null,
         updated_at = current_timestamp
   where delivery.id = target_delivery_id
     and delivery.lease_token = target_lease_token
     and delivery.lease_until > current_timestamp
     and delivery.status in ('ready', 'failed_retriable')
  returning delivery.id, delivery.outbox_id, delivery.state_version
    into delivery_id, local_outbox_id, state_version;

  if not found then
    return;
  end if;

  perform app_private.refresh_event_outbox_status(local_outbox_id);
  return next;
end
$$;

create or replace function app_private.complete_event_delivery(
  target_delivery_id uuid,
  target_lease_token uuid,
  target_status text
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
     set status = target_status,
         state_version = delivery.state_version + 1,
         lease_token = null,
         lease_until = null,
         updated_at = current_timestamp
   where delivery.id = target_delivery_id
     and delivery.lease_token = target_lease_token
     and delivery.lease_until > current_timestamp
     and (
       (target_status = 'held' and delivery.status = 'ready')
       or (target_status = 'displayed' and delivery.status in ('ready', 'held'))
       or (target_status = 'acknowledged' and delivery.status = 'displayed')
       or (target_status = 'suppressed' and delivery.status in ('ready', 'held'))
       or (target_status = 'refunded_after_display' and delivery.status in ('displayed', 'acknowledged'))
     )
  returning delivery.id, delivery.outbox_id, delivery.state_version, delivery.status
    into delivery_id, local_outbox_id, state_version, status;

  if not found then
    return;
  end if;

  perform app_private.refresh_event_outbox_status(local_outbox_id);
  return next;
end
$$;

revoke execute on function app_private.refresh_event_outbox_status(uuid) from public;
revoke execute on function app_private.retry_event_delivery(uuid, uuid, timestamptz, text) from public;
revoke execute on function app_private.complete_event_delivery(uuid, uuid, text) from public;
grant execute on function app_private.refresh_event_outbox_status(uuid) to bsa_alert_worker;
grant execute on function app_private.retry_event_delivery(uuid, uuid, timestamptz, text) to bsa_alert_worker;
grant execute on function app_private.complete_event_delivery(uuid, uuid, text) to bsa_alert_worker;
