-- L03 acceptance: admin DLQ tooling is cross-channel, platform-admin-only,
-- never deletes/silently-acknowledges accepted evidence (replay/discard are
-- both a status marker plus an audit trail), and correctly distinguishes
-- the "content_flagged release" (admin_replay on a moderation-held
-- delivery) from a terminal discard. Runs inside begin/rollback.
-- Synthetic identifiers only.

\set ON_ERROR_STOP on

begin;

insert into app_users (id, external_subject, display_name, is_platform_admin, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000901', 'google-platform-admin', 'Synthetic Platform Admin', true, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000902', 'google-not-admin', 'Synthetic Non-Admin', false, current_timestamp, current_timestamp);

-- Two channels, each with their own held/suppressed delivery — proves the
-- listing is genuinely cross-channel (a member of neither channel, the
-- admin, can still see both).
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000902', 'dlq_channel_a', 'DLQ Channel A', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000912', '00000000-0000-4000-8000-000000000902', 'dlq_channel_b', 'DLQ Channel B', true, 1, current_timestamp, current_timestamp);

insert into channel_configs (channel_id, version, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000911', 1, '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000912', 1, '{}'::jsonb, current_timestamp, current_timestamp);

insert into alert_queues (id, channel_id, name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000921', '00000000-0000-4000-8000-000000000911', 'Queue A', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000922', '00000000-0000-4000-8000-000000000912', 'Queue B', current_timestamp, current_timestamp);

insert into alert_events (id, channel_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values
  ('00000000-0000-4000-8000-000000000931', '00000000-0000-4000-8000-000000000911', 'manual', 'dlq-held', 'trace-dlq-held', 1, '{"message":"held"}'::jsonb, current_timestamp),
  ('00000000-0000-4000-8000-000000000932', '00000000-0000-4000-8000-000000000912', 'manual', 'dlq-suppressed', 'trace-dlq-suppressed', 1, '{"message":"suppressed"}'::jsonb, current_timestamp);

insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000941', '00000000-0000-4000-8000-000000000931', 'pending', current_timestamp, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000942', '00000000-0000-4000-8000-000000000932', 'pending', current_timestamp, current_timestamp, current_timestamp);

insert into event_outbox_deliveries (id, event_id, outbox_id, queue_id, binding_id, source_id, config_snapshot_version, delivery_sequence, status, hold_reason, attempt_count, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000951', '00000000-0000-4000-8000-000000000931', '00000000-0000-4000-8000-000000000941', '00000000-0000-4000-8000-000000000921', '00000000-0000-4000-8000-000000000961', 'dlq-held', 1, 1, 'held', 'moderation', 0, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000952', '00000000-0000-4000-8000-000000000932', '00000000-0000-4000-8000-000000000942', '00000000-0000-4000-8000-000000000922', '00000000-0000-4000-8000-000000000962', 'dlq-suppressed', 1, 1, 'suppressed', 'moderation', 0, current_timestamp, current_timestamp);

do $$
declare
  admin_dlq_count integer;
  non_admin_error boolean := false;
  replay_status text;
  discard_status text;
  ledger_action text;
  audit_action text;
  outbox_status text;
begin
  set role bsa_app;

  -- Non-admin: is_platform_admin() is false, and list_admin_dlq raises.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000902', true);
  if app_private.is_platform_admin() then
    raise exception 'non-admin was reported as a platform admin';
  end if;
  begin
    perform app_private.list_admin_dlq('all', 50);
    raise exception 'non-admin was able to list the admin DLQ';
  exception when sqlstate '42501' then
    non_admin_error := true;
  end;
  if not non_admin_error then
    raise exception 'non-admin DLQ access did not raise the expected permission error';
  end if;

  -- Admin: cross-channel listing sees both channels' stuck deliveries.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000901', true);
  select count(*) into admin_dlq_count
    from app_private.list_admin_dlq('all', 50)
   where delivery_id in ('00000000-0000-4000-8000-000000000951', '00000000-0000-4000-8000-000000000952');
  if admin_dlq_count <> 2 then
    raise exception 'admin DLQ listing was not genuinely cross-channel: found %', admin_dlq_count;
  end if;

  -- Replay ("content_flagged release"): held -> ready, hold_reason cleared,
  -- ledger + audit rows written, outbox projection refreshed.
  select status into replay_status
    from app_private.admin_replay_delivery('00000000-0000-4000-8000-000000000951', '00000000-0000-4000-8000-000000000901', 'ops review: false positive');
  if replay_status <> 'ready' then
    raise exception 'admin replay did not transition the delivery to ready: %', replay_status;
  end if;

  -- Raw-table verification reads run as postgres (bsa_app has no direct
  -- grant on these tables — production code only ever reaches them through
  -- the security-definer functions above).
  reset role;
  if (select hold_reason from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000951') is not null then
    raise exception 'admin replay left hold_reason set';
  end if;
  select action into ledger_action from alert_moderation_actions where event_id = '00000000-0000-4000-8000-000000000931' order by created_at desc limit 1;
  if ledger_action <> 'admin_replay' then
    raise exception 'admin replay did not write an alert_moderation_actions row: %', ledger_action;
  end if;
  select action into audit_action from audit_events where target_id = '00000000-0000-4000-8000-000000000951'::text order by created_at desc limit 1;
  if audit_action <> 'admin.dlq.replay' then
    raise exception 'admin replay did not write an audit_events row: %', audit_action;
  end if;
  select status into outbox_status from event_outbox where id = '00000000-0000-4000-8000-000000000941';
  if outbox_status = 'quarantined' then
    raise exception 'admin replay left the outbox projection stale';
  end if;
  set role bsa_app;

  -- Replaying again must fail (no longer in a replayable state) —
  -- idempotency/no-double-action, not a delete.
  begin
    perform app_private.admin_replay_delivery('00000000-0000-4000-8000-000000000951', '00000000-0000-4000-8000-000000000901', 'second attempt');
    raise exception 'admin replay succeeded twice on the same delivery';
  exception when sqlstate '22023' then
    null;
  end;

  -- Discard: terminal status marker, never a delete — the underlying
  -- alert_events/payments rows are untouched (there are none to touch
  -- here, but the delivery row itself must still exist, just re-statused).
  select status into discard_status
    from app_private.admin_discard_delivery('00000000-0000-4000-8000-000000000952', '00000000-0000-4000-8000-000000000901', 'confirmed spam');
  if discard_status <> 'discarded' then
    raise exception 'admin discard did not transition the delivery to discarded: %', discard_status;
  end if;

  reset role;
  if (select count(*) from event_outbox_deliveries where id = '00000000-0000-4000-8000-000000000952') <> 1 then
    raise exception 'admin discard deleted the delivery row instead of marking it terminal';
  end if;
  select action into ledger_action from alert_moderation_actions where event_id = '00000000-0000-4000-8000-000000000932' order by created_at desc limit 1;
  if ledger_action <> 'admin_discard' then
    raise exception 'admin discard did not write an alert_moderation_actions row: %', ledger_action;
  end if;
  set role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000901', true);

  -- A discard reason is mandatory (unlike replay, which allows null).
  begin
    perform app_private.admin_discard_delivery('00000000-0000-4000-8000-000000000951', '00000000-0000-4000-8000-000000000901', '');
    raise exception 'admin discard accepted an empty reason';
  exception when sqlstate '22023' then
    null;
  end;

  -- Discarded deliveries no longer appear in the active DLQ listing.
  select count(*) into admin_dlq_count
    from app_private.list_admin_dlq('all', 50)
   where delivery_id = '00000000-0000-4000-8000-000000000952';
  if admin_dlq_count <> 0 then
    raise exception 'discarded delivery still appears in the active DLQ listing';
  end if;
exception when others then
  reset role;
  raise;
end
$$;
reset role;
rollback;

select 'L03_ADMIN_DLQ_TOOLING=PASS' as result;
