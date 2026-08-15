-- BharatStudio Alerts v1 per-queue worker delivery lease protocol — DRAFT.
-- Depends on 0001, 0002 and 0003. This is the durable state boundary for the
-- Go worker; Cloud Tasks remains only a retry/wake-up transport.

alter table public.event_outbox_deliveries
  add column if not exists state_version bigint not null default 1;

alter table public.event_outbox_deliveries
  add column if not exists lease_token uuid;

alter table public.event_outbox_deliveries
  add column if not exists lease_until timestamptz;

-- Routing snapshots are part of the accepted delivery identity. They must be
-- present before the claim function is created because PostgreSQL validates
-- its SQL body during migration.
alter table public.event_outbox_deliveries
  add column if not exists source_priority integer not null default 0
    check (source_priority between 0 and 100000);

alter table public.event_outbox_deliveries
  add column if not exists override_values jsonb;

create index if not exists event_outbox_deliveries_claim_idx
  on public.event_outbox_deliveries (status, next_action_at, lease_until, updated_at);

drop function if exists app_private.claim_event_delivery(uuid, uuid, timestamptz);
drop function if exists app_private.claim_event_delivery(uuid, uuid, uuid, integer, bigint, uuid, timestamptz);

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

create or replace function app_private.retry_event_delivery(
  target_delivery_id uuid,
  target_lease_token uuid,
  target_next_action_at timestamptz,
  target_error_code text
)
returns table (delivery_id uuid, state_version bigint)
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
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
  returning delivery.id, delivery.state_version
$$;

create or replace function app_private.complete_event_delivery(
  target_delivery_id uuid,
  target_lease_token uuid,
  target_status text
)
returns table (delivery_id uuid, state_version bigint, status text)
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
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
  returning delivery.id, delivery.state_version, delivery.status
$$;

revoke execute on function app_private.claim_event_delivery(uuid, uuid, uuid, integer, bigint, uuid, timestamptz) from public;
revoke execute on function app_private.retry_event_delivery(uuid, uuid, timestamptz, text) from public;
revoke execute on function app_private.complete_event_delivery(uuid, uuid, text) from public;
grant execute on function app_private.claim_event_delivery(uuid, uuid, uuid, integer, bigint, uuid, timestamptz) to bsa_alert_worker;
grant execute on function app_private.retry_event_delivery(uuid, uuid, timestamptz, text) to bsa_alert_worker;
grant execute on function app_private.complete_event_delivery(uuid, uuid, text) to bsa_alert_worker;
