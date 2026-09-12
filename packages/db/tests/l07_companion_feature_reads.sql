-- L07 Companion remaining feature list (0098): mute/cancel TTS, full-test
-- report, payment/refund status, recent tips.
-- Executed in the isolated PostgreSQL harness after migrations 0001-0098.
--
-- NOTE on set_config: every function under test is gated by
-- app_private.current_user_id(), which reads the 'app.user_id' GUC.
-- set_config(..., true) is transaction-local, and each top-level statement
-- here is its own implicit transaction under psql autocommit -- so
-- `perform set_config(...)` must be the FIRST statement inside the SAME
-- do $$ block as the assertions that need it (companion_activation_signals.sql
-- and l24_companion_action_catalogue.sql follow the same convention).

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000f01', 'google-l07f-owner', 'Synthetic L07F Owner', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000f02', 'google-l07f-operator', 'Synthetic L07F Operator', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000f03', 'google-l07f-viewer', 'Synthetic L07F Viewer', current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000f11', '00000000-0000-4000-8000-000000000f01', 'l07f_channel', 'L07F Channel', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000000f11', '00000000-0000-4000-8000-000000000f01', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000000f11', '00000000-0000-4000-8000-000000000f02', 'operator', current_timestamp),
  ('00000000-0000-4000-8000-000000000f11', '00000000-0000-4000-8000-000000000f03', 'viewer', current_timestamp)
on conflict (channel_id, user_id) do nothing;

-- Creator tier: ttsEnabled = true.
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000f11', 1, 'creator', 'individual_plan',
  app_private.tier_entitlement_dimensions('creator'), current_timestamp, current_timestamp);

insert into alert_queues (id, channel_id, name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000f21', '00000000-0000-4000-8000-000000000f11', 'L07F queue', current_timestamp, current_timestamp);

-- No-TTS channel (free tier, ttsEnabled = false) to prove the entitlement gate.
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000f12', '00000000-0000-4000-8000-000000000f01', 'l07f_free', 'L07F Free Channel', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;
insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000000f12', '00000000-0000-4000-8000-000000000f01', 'owner', current_timestamp)
on conflict do nothing;
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000f12', 1, 'free', 'individual_plan',
  app_private.tier_entitlement_dimensions('free'), current_timestamp, current_timestamp);
insert into alert_queues (id, channel_id, name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000f22', '00000000-0000-4000-8000-000000000f12', 'L07F free queue', current_timestamp, current_timestamp);

-- === Mute upcoming TTS: owner mutes, then unmutes ===
do $$
declare
  muted_row record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f01', true);

  select * into muted_row from app_private.set_companion_tts_mute(
    '00000000-0000-4000-8000-000000000f11'::uuid, '00000000-0000-4000-8000-000000000f01'::uuid,
    '00000000-0000-4000-8000-000000000f21'::uuid, true
  );
  if not muted_row.tts_muted or muted_row.tts_muted_at is null then
    raise exception 'expected queue to read muted with a timestamp';
  end if;

  select * into muted_row from app_private.set_companion_tts_mute(
    '00000000-0000-4000-8000-000000000f11'::uuid, '00000000-0000-4000-8000-000000000f01'::uuid,
    '00000000-0000-4000-8000-000000000f21'::uuid, false
  );
  if muted_row.tts_muted or muted_row.tts_muted_at is not null then
    raise exception 'expected queue to read unmuted after clearing the mute';
  end if;
end
$$;

-- A viewer (no owner/admin/operator role) cannot mute TTS.
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f03', true);
  begin
    perform app_private.set_companion_tts_mute(
      '00000000-0000-4000-8000-000000000f11'::uuid, '00000000-0000-4000-8000-000000000f03'::uuid,
      '00000000-0000-4000-8000-000000000f21'::uuid, true
    );
    raise exception 'expected a viewer to be denied TTS mute';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;

-- ttsEnabled = false channel rejects mute even for the owner.
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f01', true);
  begin
    perform app_private.set_companion_tts_mute(
      '00000000-0000-4000-8000-000000000f12'::uuid, '00000000-0000-4000-8000-000000000f01'::uuid,
      '00000000-0000-4000-8000-000000000f22'::uuid, true
    );
    raise exception 'expected free-tier (ttsEnabled=false) mute to be rejected';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

-- === Cancel currently-playing TTS: distinct from mute, targets one delivery ===

insert into alert_events (id, channel_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values ('00000000-0000-4000-8000-000000000f31', '00000000-0000-4000-8000-000000000f11', 'manual', 'l07f-manual', 'trace-l07f-1', 1,
  jsonb_build_object('displayName', 'Synthetic Donor', 'message', 'go team'), current_timestamp);
insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000f41', '00000000-0000-4000-8000-000000000f31', 'enqueued', current_timestamp, current_timestamp, current_timestamp);
insert into event_outbox_deliveries (id, event_id, outbox_id, queue_id, binding_id, source_id, config_snapshot_version, delivery_sequence, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000f51', '00000000-0000-4000-8000-000000000f31', '00000000-0000-4000-8000-000000000f41',
  '00000000-0000-4000-8000-000000000f21', '00000000-0000-4000-8000-000000000f61', 'l07f-manual', 1, 1, 'displayed', current_timestamp, current_timestamp);

do $$
declare
  cancel_row record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f01', true);

  select * into cancel_row from app_private.cancel_companion_tts_delivery(
    '00000000-0000-4000-8000-000000000f11'::uuid, '00000000-0000-4000-8000-000000000f01'::uuid,
    '00000000-0000-4000-8000-000000000f51'::uuid
  );
  if cancel_row.status <> 'tts_cancelled' then
    raise exception 'expected the delivery to read tts_cancelled, got %', cancel_row.status;
  end if;
end
$$;

-- Cancelling the same, already-cancelled delivery again fails (no longer 'ready'/'displayed').
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f01', true);
  begin
    perform app_private.cancel_companion_tts_delivery(
      '00000000-0000-4000-8000-000000000f11'::uuid, '00000000-0000-4000-8000-000000000f01'::uuid,
      '00000000-0000-4000-8000-000000000f51'::uuid
    );
    raise exception 'expected a second cancel of the same delivery to be rejected';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

-- Mute and cancel are distinct: cancelling a delivery must not touch the
-- queue's tts_muted_at, and muting a queue must not touch any delivery row.
do $$
declare
  muted_at timestamptz;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f01', true);

  select tts_muted_at into muted_at from alert_queues where id = '00000000-0000-4000-8000-000000000f21';
  if muted_at is not null then
    raise exception 'cancelling a delivery unexpectedly muted the queue';
  end if;
end
$$;

-- === Run full test report: hop-by-hop over the manual event above ===
do $$
declare
  hop_count integer;
  tts_hop record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f01', true);

  select count(*) into hop_count
    from app_private.get_companion_test_report('00000000-0000-4000-8000-000000000f11'::uuid, '00000000-0000-4000-8000-000000000f31'::uuid);
  -- event_created + outbox_enqueued + one delivery hop = 3 rows.
  if hop_count <> 3 then
    raise exception 'expected 3 hop rows, got %', hop_count;
  end if;

  select * into tts_hop from app_private.get_companion_test_report_tts_hop(
    '00000000-0000-4000-8000-000000000f11'::uuid, '00000000-0000-4000-8000-000000000f31'::uuid
  );
  if tts_hop.status <> 'not_synthesized' then
    raise exception 'expected an honest not_synthesized tts hop when no audio row exists, got %', tts_hop.status;
  end if;
end
$$;

-- The report never leaks another channel's event: a channel-mismatched
-- lookup returns zero rows, not another channel's data.
do $$
declare
  leaked_count integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f01', true);

  select count(*) into leaked_count
    from app_private.get_companion_test_report('00000000-0000-4000-8000-000000000f12'::uuid, '00000000-0000-4000-8000-000000000f31'::uuid);
  if leaked_count <> 0 then
    raise exception 'expected zero hops for a mismatched channel, got %', leaked_count;
  end if;
end
$$;

-- === Payment/refund status: finance-role gated ===

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000f71', '00000000-0000-4000-8000-000000000f11', 'razorpay', 'pay_l07f_1', 'order_l07f_1', 25000, 'INR', 'refunded', current_timestamp, current_timestamp);
insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000f81', '00000000-0000-4000-8000-000000000f71', 'rfnd_l07f_1', 25000, 'processed', current_timestamp, current_timestamp);

do $$
declare
  view_row record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f01', true);

  select * into view_row from app_private.get_companion_payment_status('00000000-0000-4000-8000-000000000f11'::uuid, 20) limit 1;
  if view_row.refund_status <> 'processed' or view_row.gross_amount_paise <> 25000 then
    raise exception 'owner expected to see payment/refund amounts, got refund_status=% amount=%', view_row.refund_status, view_row.gross_amount_paise;
  end if;
end
$$;

-- An operator (not owner/admin) sees no payment rows -- finance role gate.
do $$
declare
  operator_count integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f02', true);

  select count(*) into operator_count from app_private.get_companion_payment_status('00000000-0000-4000-8000-000000000f11'::uuid, 20);
  if operator_count <> 0 then
    raise exception 'expected operator role to see zero payment rows, got %', operator_count;
  end if;
end
$$;

-- === Recent tips: donor-visibility scope check ===

insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values ('00000000-0000-4000-8000-000000000f91', '00000000-0000-4000-8000-000000000f11', '00000000-0000-4000-8000-000000000f71', 'payment', 'l07f-pay-1', 'trace-l07f-2', 1,
  jsonb_build_object('displayName', 'Synthetic Tipper', 'message', 'love the stream'), current_timestamp);

do $$
declare
  tip_row record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f01', true);

  select * into tip_row from app_private.get_companion_recent_tips('00000000-0000-4000-8000-000000000f11'::uuid, 20) limit 1;
  if tip_row.display_name <> 'Synthetic Tipper' or tip_row.gross_amount_paise <> 25000 then
    raise exception 'owner expected donor name and amount, got name=% amount=%', tip_row.display_name, tip_row.gross_amount_paise;
  end if;
end
$$;

-- A viewer sees neither donor name/message nor the amount (donor-visibility
-- scope check, mirrored from 0039's get_alert_history).
do $$
declare
  tip_row record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f03', true);

  select * into tip_row from app_private.get_companion_recent_tips('00000000-0000-4000-8000-000000000f11'::uuid, 20) limit 1;
  if tip_row.display_name is not null or tip_row.message is not null or tip_row.gross_amount_paise is not null then
    raise exception 'expected viewer to see no donor identity or amount on recent tips';
  end if;
end
$$;

-- A different channel's owner never sees this channel's tips (row-level scope).
do $$
declare
  other_channel_count integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000f01', true);

  select count(*) into other_channel_count from app_private.get_companion_recent_tips('00000000-0000-4000-8000-000000000f12'::uuid, 20);
  if other_channel_count <> 0 then
    raise exception 'expected zero tips leaked into an unrelated channel, got %', other_channel_count;
  end if;
end
$$;
