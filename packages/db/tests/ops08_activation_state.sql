-- OPS-08: activation instrumentation (payout + OBS/overlay + first alert).
-- app_private.get_creator_activation_state is a pure derived read over
-- existing durable records (payment_account_audit, overlay_sessions,
-- alert_events) -- no new table, no counter. This file proves: (1) the
-- "nothing done yet" all-false case, (2) each of the three signals flips
-- independently and stays true once achieved even if the underlying live
-- state later reverts (payout revoked, overlay session expired), because
-- the signal is "ever happened", not "true right now", and (3) any active
-- channel member (not just owner/admin) can read it -- it carries no
-- amount.
--
-- Uses base_world channel '00000000-0000-4000-8000-000000000011' (owner
-- user 1, admin user 3, operator user 4, moderator user 5, viewer user 6).
-- Own fixture ids: '00000000-0000-4000-8000-0000000a08XX' (unused prefix,
-- verified by grep against every other file in this suite at the time of
-- writing).
\set ON_ERROR_STOP on

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

-- 1. Nothing done yet: all three signals false, all three timestamps null.
do $$
declare r record;
begin
  select * into r from app_private.get_creator_activation_state('00000000-0000-4000-8000-000000000011'::uuid);
  if r.payout_connected or r.overlay_connected or r.first_alert_fired then
    raise exception 'a channel with none of the three milestones must read all-false, got payout=%, overlay=%, alert=%', r.payout_connected, r.overlay_connected, r.first_alert_fired;
  end if;
  if r.payout_connected_at is not null or r.overlay_connected_at is not null or r.first_alert_fired_at is not null then
    raise exception 'an unset milestone must carry a null timestamp';
  end if;
end
$$;

-- 2. Payout milestone: an 'activated' audit row flips it true and stamps
-- the timestamp, and it STAYS true even after the account is later
-- revoked -- the milestone is "ever activated", not "currently active"
-- (get_companion_state already covers the live-status signal separately;
-- this one is deliberately sticky, matching a Stripe-style setup
-- checklist item).
insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at, revoked_at)
values ('00000000-0000-4000-8000-0000000a0801', '00000000-0000-4000-8000-000000000011', 'razorpay', 'test', 'acct_ops08', 'active', current_timestamp - interval '2 days', current_timestamp - interval '2 days', null);

insert into payment_account_audit (id, payment_account_id, channel_id, actor_service, action, previous_account_ref, next_account_ref, previous_status, next_status, created_at)
values ('00000000-0000-4000-8000-0000000a0802', '00000000-0000-4000-8000-0000000a0801', '00000000-0000-4000-8000-000000000011', 'ops08-test', 'activated', 'acct_ops08', 'acct_ops08', 'pending', 'active', current_timestamp - interval '2 days');

do $$
declare r record;
begin
  select * into r from app_private.get_creator_activation_state('00000000-0000-4000-8000-000000000011'::uuid);
  if not r.payout_connected then
    raise exception 'an activated payment account audit row must flip payout_connected true';
  end if;
  if r.payout_connected_at is null then
    raise exception 'payout_connected_at must be stamped once activated';
  end if;
  if r.overlay_connected or r.first_alert_fired then
    raise exception 'the other two milestones must remain false until their own evidence exists';
  end if;
end
$$;

-- Revoke it: payout_connected must NOT flip back to false. The
-- append-only audit trail still carries the 'activated' row.
update payment_accounts set status = 'revoked', revoked_at = current_timestamp, updated_at = current_timestamp
 where id = '00000000-0000-4000-8000-0000000a0801';
insert into payment_account_audit (id, payment_account_id, channel_id, actor_service, action, previous_account_ref, next_account_ref, previous_status, next_status, created_at)
values ('00000000-0000-4000-8000-0000000a0803', '00000000-0000-4000-8000-0000000a0801', '00000000-0000-4000-8000-000000000011', 'ops08-test', 'revoked', 'acct_ops08', 'acct_ops08', 'active', 'revoked', current_timestamp);

do $$
declare r record;
begin
  select * into r from app_private.get_creator_activation_state('00000000-0000-4000-8000-000000000011'::uuid);
  if not r.payout_connected then
    raise exception 'payout_connected is an activation MILESTONE, not a live status -- a later revoke must not un-set it';
  end if;
end
$$;

-- 3. Overlay milestone: any overlay_sessions row, even one already
-- revoked/expired, counts as "ever connected".
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, revoked_at, created_at)
values ('00000000-0000-4000-8000-0000000a0804', '00000000-0000-4000-8000-000000000011', 'fp_ops08_expired', current_timestamp - interval '1 hour', current_timestamp - interval '1 hour', current_timestamp - interval '1 day');

do $$
declare r record;
begin
  select * into r from app_private.get_creator_activation_state('00000000-0000-4000-8000-000000000011'::uuid);
  if not r.overlay_connected then
    raise exception 'an overlay session row, even expired/revoked, must count as the overlay-connected milestone';
  end if;
  if r.overlay_connected_at is null then
    raise exception 'overlay_connected_at must be stamped once any session exists';
  end if;
  if r.first_alert_fired then
    raise exception 'first_alert_fired must remain false until an alert_events row exists';
  end if;
end
$$;

-- 4. First-alert milestone: one alert_events row is enough.
insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values ('00000000-0000-4000-8000-0000000a0805', '00000000-0000-4000-8000-000000000011', null, 'manual', 'ops08-test', 'razorpay:ops08-test-trace', 1, '{}'::jsonb, current_timestamp);

do $$
declare r record;
begin
  select * into r from app_private.get_creator_activation_state('00000000-0000-4000-8000-000000000011'::uuid);
  if not (r.payout_connected and r.overlay_connected and r.first_alert_fired) then
    raise exception 'all three milestones must now read true, got payout=%, overlay=%, alert=%', r.payout_connected, r.overlay_connected, r.first_alert_fired;
  end if;
  if r.first_alert_fired_at is null then
    raise exception 'first_alert_fired_at must be stamped once an alert_events row exists';
  end if;
end
$$;

-- 5. A moderator (operational role, no financial visibility) can still
-- read activation state -- it carries no amount, so it is not gated like
-- the revenue-KPI function below.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
do $$
declare r record;
begin
  select * into r from app_private.get_creator_activation_state('00000000-0000-4000-8000-000000000011'::uuid);
  if not found or not r.payout_connected then
    raise exception 'a moderator must be able to read activation state (no amounts are carried)';
  end if;
end
$$;

-- 6. A user with no membership on this channel gets nothing back.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
do $$
declare r record;
begin
  select * into r from app_private.get_creator_activation_state('00000000-0000-4000-8000-000000000011'::uuid);
  if found then
    raise exception 'a non-member must get no row back from get_creator_activation_state';
  end if;
end
$$;
