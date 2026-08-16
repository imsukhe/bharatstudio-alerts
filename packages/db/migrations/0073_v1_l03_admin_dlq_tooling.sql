-- L03: admin DLQ tooling — cross-channel quarantined/held alert-event
-- review, replay (including content_flagged release) and terminal
-- discard, for platform admins.
--
-- "v1 scope addendum — 2026-08-16" in 01_MASTER_RELEASE_AUTHORITY.md.
-- API-only, no admin UI — matching BharatStudio Alerts legacy's own scope
-- boundary for this exact feature (its DLQ_OPERATIONS.md records the same
-- call deliberately).
--
-- Reachability, decided explicitly rather than papered over: this
-- codebase's event_outbox_deliveries.status='quarantined' and
-- hold_reason='operator' are declared in the CHECK constraint but nothing
-- anywhere writes them (verified by reading every writer: complete_event_
-- delivery, retry_event_delivery, apply_moderation_action). The reachable
-- "needs admin attention" states today are: status='held' (any
-- hold_reason), status='suppressed' with hold_reason='moderation', and
-- event_outbox.status='quarantined' (the zero-queue-binding case from
-- 0028). The admin list therefore reads those, not the unreachable
-- 'quarantined' delivery status — building a max-attempt-exhaustion writer
-- for that status is a separate delivery-semantics decision, out of scope
-- here per the non-negotiable invariant that no recovery action may be
-- invented without evidence it's needed.
--
-- "content_flagged release": that exact term does not exist in this
-- codebase (it is legacy vocabulary carried into the addendum's wording).
-- Its equivalent here is hold_reason='moderation' — admin_replay_delivery
-- releases it, which is deliberately a wider set of source states than the
-- creator-facing apply_moderation_action's own 'replay' action allows,
-- because an admin replaying via this endpoint IS the ops review the
-- creator-side action defers to (matching legacy dlq.ts's own comment).
--
-- "Terminal discard" is a status marker plus an audit trail, never a
-- delete — non-negotiable invariant #1 (accepted payment/alert evidence is
-- never dropped, deleted or silently acknowledged).

alter table public.app_users add column is_platform_admin boolean not null default false;

create or replace function app_private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select exists (
    select 1 from public.app_users
     where id = app_private.current_user_id()
       and is_platform_admin
       and closed_at is null
  )
$$;

revoke execute on function app_private.is_platform_admin() from public;
grant execute on function app_private.is_platform_admin() to bsa_app;

alter table public.event_outbox_deliveries
  drop constraint if exists event_outbox_deliveries_status_check;

alter table public.event_outbox_deliveries
  add constraint event_outbox_deliveries_status_check
  check (status in ('pending', 'ready', 'held', 'displayed', 'acknowledged', 'failed_retriable', 'quarantined', 'suppressed', 'refunded_after_display', 'discarded'));

-- Append-only actor/action/reason ledger, extended for the two new
-- admin-only actions. Existing rows/checks for creator-facing actions are
-- untouched.
alter table public.alert_moderation_actions
  drop constraint if exists alert_moderation_actions_action_check;

alter table public.alert_moderation_actions
  add constraint alert_moderation_actions_action_check
  check (action in ('approve', 'hold', 'suppress', 'replay', 'admin_replay', 'admin_discard'));

-- Cross-channel read: joined to channels for the handle an admin needs to
-- triage by. Deliberately does not project donor/message content — an
-- admin needs to know WHAT is stuck and WHERE, not read tip messages;
-- get_alert_history already exists for a channel member who needs content.
create or replace function app_private.list_admin_dlq(
  target_status text,
  target_limit integer
)
returns table (
  delivery_id uuid,
  event_id uuid,
  channel_id uuid,
  channel_handle text,
  queue_id uuid,
  status text,
  hold_reason text,
  attempt_count integer,
  last_error_code text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform admin required' using errcode = '42501';
  end if;
  if target_status not in ('held', 'suppressed', 'quarantined_outbox', 'all') then
    raise exception 'invalid admin dlq status filter: %', target_status using errcode = '22023';
  end if;

  return query
    select delivery.id, delivery.event_id, event.channel_id, channel.handle,
           delivery.queue_id, delivery.status, delivery.hold_reason,
           delivery.attempt_count, delivery.last_error_code,
           delivery.created_at, delivery.updated_at
      from public.event_outbox_deliveries delivery
      join public.alert_events event on event.id = delivery.event_id
      join public.channels channel on channel.id = event.channel_id
     where (
       (target_status = 'held' and delivery.status = 'held')
       or (target_status = 'suppressed' and delivery.status = 'suppressed' and delivery.hold_reason = 'moderation')
       or (target_status = 'all' and delivery.status in ('held', 'suppressed', 'failed_retriable'))
     )
     order by delivery.updated_at desc, delivery.id desc
     limit greatest(least(coalesce(target_limit, 50), 200), 1);

  if target_status in ('quarantined_outbox', 'all') then
    return query
      select delivery.id, delivery.event_id, event.channel_id, channel.handle,
             delivery.queue_id, 'quarantined_outbox'::text, null::text,
             delivery.attempt_count, delivery.last_error_code,
             delivery.created_at, delivery.updated_at
        from public.event_outbox outbox
        join public.alert_events event on event.id = outbox.event_id
        join public.channels channel on channel.id = event.channel_id
        join public.event_outbox_deliveries delivery on delivery.outbox_id = outbox.id
       where outbox.status = 'quarantined'
       order by delivery.updated_at desc, delivery.id desc
       limit greatest(least(coalesce(target_limit, 50), 200), 1);
  end if;
end
$$;

-- Releases a held/suppressed(moderation)/failed_retriable delivery back to
-- 'ready' for immediate redelivery — the "content_flagged release" the
-- addendum names. Refreshes the outbox read-model in the same transaction
-- so get_alert_history reflects the change immediately.
create or replace function app_private.admin_replay_delivery(
  target_delivery_id uuid,
  target_admin_user_id uuid,
  target_reason text
)
returns table (delivery_id uuid, status text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_row public.event_outbox_deliveries%rowtype;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform admin required' using errcode = '42501';
  end if;
  if target_admin_user_id <> app_private.current_user_id() then
    raise exception 'actor mismatch' using errcode = '42501';
  end if;

  select delivery.* into current_row
    from public.event_outbox_deliveries delivery
   where delivery.id = target_delivery_id
     and delivery.status in ('held', 'suppressed', 'failed_retriable')
   for update;
  if not found then
    raise exception 'delivery is not in a replayable state' using errcode = '22023';
  end if;

  update public.event_outbox_deliveries
     set status = 'ready',
         hold_reason = null,
         next_action_at = current_timestamp,
         state_version = state_version + 1,
         updated_at = current_timestamp
   where id = target_delivery_id
  returning * into current_row;

  insert into public.alert_moderation_actions (id, event_id, channel_id, actor_user_id, action, reason, created_at)
  select gen_random_uuid(), current_row.event_id, event.channel_id, target_admin_user_id, 'admin_replay', nullif(left(target_reason, 500), ''), current_timestamp
    from public.alert_events event where event.id = current_row.event_id;

  insert into public.audit_events (id, channel_id, actor_user_id, action, target_type, target_id, metadata, created_at)
  select gen_random_uuid(), event.channel_id, target_admin_user_id, 'admin.dlq.replay', 'event_outbox_delivery', target_delivery_id::text,
         jsonb_build_object('reason', target_reason), current_timestamp
    from public.alert_events event where event.id = current_row.event_id;

  perform app_private.refresh_event_outbox_status(current_row.outbox_id);

  return query select current_row.id, current_row.status;
end
$$;

-- Terminal discard: a status marker plus an audit row, never a delete.
-- alert_events/payments/payment_webhook_deliveries are untouched.
create or replace function app_private.admin_discard_delivery(
  target_delivery_id uuid,
  target_admin_user_id uuid,
  target_reason text
)
returns table (delivery_id uuid, status text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_row public.event_outbox_deliveries%rowtype;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform admin required' using errcode = '42501';
  end if;
  if target_admin_user_id <> app_private.current_user_id() then
    raise exception 'actor mismatch' using errcode = '42501';
  end if;
  if target_reason is null or char_length(trim(target_reason)) = 0 then
    raise exception 'a discard reason is required' using errcode = '22023';
  end if;

  select delivery.* into current_row
    from public.event_outbox_deliveries delivery
   where delivery.id = target_delivery_id
     and delivery.status in ('held', 'suppressed', 'failed_retriable')
   for update;
  if not found then
    raise exception 'delivery is not in a discardable state' using errcode = '22023';
  end if;

  update public.event_outbox_deliveries
     set status = 'discarded',
         state_version = state_version + 1,
         updated_at = current_timestamp
   where id = target_delivery_id
  returning * into current_row;

  insert into public.alert_moderation_actions (id, event_id, channel_id, actor_user_id, action, reason, created_at)
  select gen_random_uuid(), current_row.event_id, event.channel_id, target_admin_user_id, 'admin_discard', left(target_reason, 500), current_timestamp
    from public.alert_events event where event.id = current_row.event_id;

  insert into public.audit_events (id, channel_id, actor_user_id, action, target_type, target_id, metadata, created_at)
  select gen_random_uuid(), event.channel_id, target_admin_user_id, 'admin.dlq.discard', 'event_outbox_delivery', target_delivery_id::text,
         jsonb_build_object('reason', target_reason), current_timestamp
    from public.alert_events event where event.id = current_row.event_id;

  perform app_private.refresh_event_outbox_status(current_row.outbox_id);

  return query select current_row.id, current_row.status;
end
$$;

revoke execute on function app_private.list_admin_dlq(text, integer) from public;
revoke execute on function app_private.admin_replay_delivery(uuid, uuid, text) from public;
revoke execute on function app_private.admin_discard_delivery(uuid, uuid, text) from public;
grant execute on function app_private.list_admin_dlq(text, integer) to bsa_app;
grant execute on function app_private.admin_replay_delivery(uuid, uuid, text) to bsa_app;
grant execute on function app_private.admin_discard_delivery(uuid, uuid, text) to bsa_app;
