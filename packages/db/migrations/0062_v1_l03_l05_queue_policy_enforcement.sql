-- L03/L05: enforce approved queue policy at the durable claim and overlay
-- projection boundaries. Quiet mode and approval can hold an accepted delivery;
-- they can never delete it or turn a payment into a failed payment.

alter table public.event_outbox_deliveries
  add column if not exists hold_reason text;

alter table public.event_outbox_deliveries
  drop constraint if exists event_outbox_deliveries_hold_reason_check;

alter table public.event_outbox_deliveries
  add constraint event_outbox_deliveries_hold_reason_check
  check (hold_reason is null or hold_reason in ('moderation', 'operator'));

create or replace function app_private.quiet_mode_active(
  target_config jsonb
)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, public, app_private
as $$
declare
  quiet jsonb;
  timezone_name text;
  start_text text;
  end_text text;
  local_time time;
  start_time time;
  end_time time;
begin
  quiet := target_config -> 'queue' -> 'quietMode';
  if quiet is null or coalesce((quiet ->> 'enabled')::boolean, false) = false then return false; end if;
  timezone_name := quiet ->> 'timezone';
  start_text := quiet ->> 'start';
  end_text := quiet ->> 'end';
  if timezone_name is null or start_text !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
     or end_text !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
     or not exists (select 1 from pg_timezone_names where name = timezone_name) then
    return true; -- fail closed for malformed active quiet policy
  end if;
  start_time := start_text::time;
  end_time := end_text::time;
  local_time := current_timestamp at time zone timezone_name;
  if start_time = end_time then return true; end if;
  if start_time < end_time then
    return local_time >= start_time and local_time < end_time;
  end if;
  return local_time >= start_time or local_time < end_time;
exception when others then
  return true;
end
$$;

create or replace function app_private.delivery_dispatch_allowed(
  target_event_id uuid,
  target_config_version bigint
)
returns boolean
language sql
stable
set search_path = pg_catalog, public, app_private
as $$
  with policy as (
    select coalesce(config.values, '{}'::jsonb) as values
      from public.alert_events event
      left join public.channel_configs config
        on config.channel_id = event.channel_id
       and config.version = target_config_version
     where event.id = target_event_id
  ), latest_action as (
    select action.action
      from public.alert_moderation_actions action
     where action.event_id = target_event_id
     order by action.created_at desc, action.id desc
     limit 1
  )
  select not app_private.quiet_mode_active(policy.values)
     and (
       coalesce((policy.values #>> '{queue,approvalRequired}')::boolean, false) = false
       or (select action from latest_action) = 'approve'
     )
     and coalesce((select action from latest_action), '') <> 'suppress'
     and coalesce((select action from latest_action), '') <> 'hold'
    from policy
$$;

create or replace function app_private.apply_moderation_action(
  target_event_id uuid,
  target_channel_id uuid,
  target_user_id uuid,
  target_action text,
  target_reason text
)
returns table (event_id uuid, action text, applied_at timestamptz, affected_deliveries integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  applied timestamptz := current_timestamp;
  changed integer := 0;
begin
  if target_user_id is null or target_user_id <> app_private.current_user_id()
     or target_action not in ('approve', 'hold', 'suppress', 'replay')
     or char_length(coalesce(target_reason, '')) > 500
     or not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[])
     or not exists (select 1 from public.alert_events event where event.id = target_event_id and event.channel_id = target_channel_id) then
    raise exception 'invalid moderation action' using errcode = '42501';
  end if;
  insert into public.alert_moderation_actions (id, event_id, channel_id, actor_user_id, action, reason, created_at)
  values (gen_random_uuid(), target_event_id, target_channel_id, target_user_id, target_action, nullif(left(target_reason, 500), ''), applied);

  if target_action = 'approve' then
    update public.event_outbox_deliveries as delivery
       set status = 'ready', hold_reason = null, next_action_at = current_timestamp,
           state_version = delivery.state_version + 1, updated_at = current_timestamp
     where delivery.event_id = target_event_id and delivery.status in ('pending', 'ready', 'held', 'failed_retriable')
       and (delivery.hold_reason = 'moderation' or delivery.status <> 'held');
  elsif target_action = 'hold' then
    update public.event_outbox_deliveries as delivery
       set status = 'held', hold_reason = 'moderation', next_action_at = null,
           state_version = delivery.state_version + 1, updated_at = current_timestamp
     where delivery.event_id = target_event_id and delivery.status in ('pending', 'ready', 'failed_retriable');
  elsif target_action = 'suppress' then
    update public.event_outbox_deliveries as delivery
       set status = 'suppressed', hold_reason = 'moderation', next_action_at = null,
           state_version = delivery.state_version + 1, updated_at = current_timestamp
     where delivery.event_id = target_event_id and delivery.status in ('pending', 'ready', 'held', 'failed_retriable');
  elsif target_action = 'replay' then
    update public.event_outbox_deliveries as delivery
       set status = 'ready', hold_reason = null, next_action_at = current_timestamp,
           state_version = delivery.state_version + 1, updated_at = current_timestamp
     where delivery.event_id = target_event_id and delivery.status in ('displayed', 'acknowledged', 'failed_retriable', 'held', 'suppressed');
  end if;
  get diagnostics changed = row_count;
  return query select target_event_id, target_action, applied, changed;
end
$$;

-- The claim/list/projection functions below remain append-only and use the
-- existing lease/state-version compare-and-swap fields. Only dispatchability
-- predicates are added here.
create or replace function app_private.claim_event_delivery(
  target_delivery_id uuid, target_event_id uuid, target_outbox_id uuid,
  target_attempt_number integer, target_state_version bigint,
  target_lease_token uuid, target_lease_until timestamptz
)
returns table (delivery_id uuid, event_id uuid, channel_id uuid, outbox_id uuid,
  queue_id uuid, binding_id uuid, source_priority integer, override_values jsonb,
  trace_id text, attempt_number integer, state_version bigint)
language sql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
  update public.event_outbox_deliveries delivery
     set status = 'ready', attempt_count = delivery.attempt_count + 1,
         state_version = delivery.state_version + 1, lease_token = target_lease_token,
         lease_until = target_lease_until, updated_at = current_timestamp
   where delivery.id = target_delivery_id and delivery.event_id = target_event_id
     and delivery.outbox_id = target_outbox_id
     and delivery.attempt_count + 1 = target_attempt_number
     and delivery.state_version = target_state_version
     and target_lease_until > current_timestamp
     and delivery.status in ('pending', 'ready', 'failed_retriable')
     and (delivery.lease_until is null or delivery.lease_until <= current_timestamp)
     and (delivery.next_action_at is null or delivery.next_action_at <= current_timestamp)
     and app_private.delivery_dispatch_allowed(delivery.event_id, delivery.config_snapshot_version)
     and exists (select 1 from public.alert_queues queue where queue.id = delivery.queue_id and queue.closed_at is null and queue.is_paused = false)
  returning delivery.id, delivery.event_id,
    (select event.channel_id from public.alert_events event where event.id = delivery.event_id),
    delivery.outbox_id, delivery.queue_id, delivery.binding_id, delivery.source_priority,
    delivery.override_values,
    (select event.trace_id from public.alert_events event where event.id = delivery.event_id),
    delivery.attempt_count, delivery.state_version
$$;

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
    join public.alert_queues queue on queue.id = delivery.queue_id and queue.closed_at is null and queue.is_paused = false
   where delivery.status in ('pending', 'ready', 'failed_retriable')
     and (delivery.lease_until is null or delivery.lease_until <= current_timestamp)
     and (delivery.next_action_at is null or delivery.next_action_at <= current_timestamp)
     and app_private.delivery_dispatch_allowed(delivery.event_id, delivery.config_snapshot_version)
   order by delivery.next_action_at nulls first, delivery.created_at asc, delivery.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

create or replace function app_private.get_overlay_events(
  target_overlay_id uuid, target_after_created_at timestamptz,
  target_after_delivery_id uuid, target_limit integer
)
returns table (cursor text, event_id uuid, event_type text, trace_id text,
  created_at timestamptz, payload jsonb)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select to_char(delivery.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || delivery.id::text,
         event.id, case when delivery.status = 'held' then 'alert.hold' else 'alert.ready' end,
         event.trace_id, delivery.created_at,
         event.payload || jsonb_build_object('deliveryId', delivery.id, 'queueId', delivery.queue_id,
           'bindingId', delivery.binding_id, 'configSnapshotVersion', delivery.config_snapshot_version,
           'configSnapshot', coalesce(config.values, '{}'::jsonb), 'deliverySequence', delivery.delivery_sequence,
           'sourcePriority', delivery.source_priority, 'overrideValues', coalesce(delivery.override_values, '{}'::jsonb))
    from public.event_outbox_deliveries delivery
    join public.event_outbox outbox on outbox.id = delivery.outbox_id
    join public.alert_events event on event.id = delivery.event_id
    left join public.channel_configs config on config.channel_id = event.channel_id and config.version = delivery.config_snapshot_version
    join public.overlay_sessions session on session.id = target_overlay_id
    join public.alert_queues queue on queue.id = delivery.queue_id and queue.closed_at is null and queue.is_paused = false
   where target_overlay_id = app_private.current_overlay_session_id()
     and session.id = target_overlay_id and event.channel_id = session.channel_id
     and session.revoked_at is null and session.expires_at > current_timestamp
     and delivery.status in ('ready', 'displayed', 'acknowledged')
     and app_private.delivery_dispatch_allowed(delivery.event_id, delivery.config_snapshot_version)
     and (target_after_created_at is null or delivery.created_at > target_after_created_at or
          (delivery.created_at = target_after_created_at and delivery.id > coalesce(target_after_delivery_id, '00000000-0000-0000-0000-000000000000'::uuid)))
   order by delivery.created_at asc, delivery.id asc
   limit greatest(1, least(target_limit, 100))
$$;

revoke execute on function app_private.quiet_mode_active(jsonb) from public;
revoke execute on function app_private.delivery_dispatch_allowed(uuid, bigint) from public;
revoke execute on function app_private.apply_moderation_action(uuid, uuid, uuid, text, text) from public;
revoke execute on function app_private.claim_event_delivery(uuid, uuid, uuid, integer, bigint, uuid, timestamptz) from public;
revoke execute on function app_private.list_ready_event_deliveries(integer) from public;
revoke execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) from public;
grant execute on function app_private.apply_moderation_action(uuid, uuid, uuid, text, text) to bsa_app;
grant execute on function app_private.claim_event_delivery(uuid, uuid, uuid, integer, bigint, uuid, timestamptz) to bsa_alert_worker;
grant execute on function app_private.list_ready_event_deliveries(integer) to bsa_alert_worker;
grant execute on function app_private.get_overlay_events(uuid, timestamptz, uuid, integer) to bsa_app;
