-- L03: referral/growth engine (0076). Wrapped in begin;...rollback; so this
-- never leaves fixture data behind for later tests in the shared disposable
-- database, per this session's established lesson (l05_queue_policy_
-- enforcement.sql's earlier cross-test pollution incident).
begin;

insert into app_users (id, external_subject, display_name, created_at, updated_at) values
  ('0000000a-0000-4000-8000-000000000010', 'ext-ref-010', 'Referrer', now(), now()),
  ('0000000a-0000-4000-8000-000000000020', 'ext-ref-020', 'Referred', now(), now()),
  ('0000000a-0000-4000-8000-000000000030', 'ext-ref-030', 'Fraud A', now(), now()),
  ('0000000a-0000-4000-8000-000000000040', 'ext-ref-040', 'Fraud B', now(), now()),
  ('0000000a-0000-4000-8000-000000000050', 'ext-ref-050', 'Fraud C', now(), now());

select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000010'::uuid, '0000000a-0000-4000-8000-000000000010'::uuid, 'reftestref', 'Referrer Channel');
select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000020'::uuid, '0000000a-0000-4000-8000-000000000020'::uuid, 'reftestreferred', 'Referred Channel');
select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000030'::uuid, '0000000a-0000-4000-8000-000000000030'::uuid, 'reftestfraud1', 'Fraud Ref 1');
select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000040'::uuid, '0000000a-0000-4000-8000-000000000040'::uuid, 'reftestfraud2', 'Fraud Ref 2');
select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000050'::uuid, '0000000a-0000-4000-8000-000000000050'::uuid, 'reftestfraud3', 'Fraud Ref 3');

-- self-referral is rejected before ever hitting the CHECK constraint
do $$
declare v_result text; v_id uuid;
begin
  select result, referral_id into v_result, v_id
    from app_private.record_referral_attribution('0000000c-0000-4000-8000-000000000010'::uuid, 'reftestref', 'hash-self');
  assert v_result = 'self_referral_rejected', 'self-referral must be rejected, got: ' || v_result;
  assert v_id is null, 'self-referral must not create a row';
end
$$;

-- an unknown referrer code is reported, not silently accepted
do $$
declare v_result text;
begin
  select result into v_result
    from app_private.record_referral_attribution('0000000c-0000-4000-8000-000000000020'::uuid, 'no-such-handle-at-all', 'hash-1');
  assert v_result = 'unknown_referrer_code', 'unknown code must be reported, got: ' || v_result;
end
$$;

-- the real attribution, case-insensitive handle match
do $$
declare v_result text; v_id uuid;
begin
  select result, referral_id into v_result, v_id
    from app_private.record_referral_attribution('0000000c-0000-4000-8000-000000000020'::uuid, 'REFTESTREF', 'hash-1');
  assert v_result = 'attributed', 'attribution must succeed, got: ' || v_result;
  assert v_id is not null, 'attribution must return a referral id';
  perform 1 from referrals where id = v_id and status = 'pending' and referrer_channel_id = '0000000c-0000-4000-8000-000000000010'::uuid;
  assert found, 'referral row must be pending and attributed to the referrer';
end
$$;

-- re-attributing the same referred channel is idempotent, not a second row
do $$
declare v_result text;
begin
  select result into v_result
    from app_private.record_referral_attribution('0000000c-0000-4000-8000-000000000020'::uuid, 'reftestref', 'hash-1');
  assert v_result = 'already_referred', 'repeat attribution must be reported, got: ' || v_result;
  perform 1 from (select count(*) as c from referrals where referred_channel_id = '0000000c-0000-4000-8000-000000000020'::uuid) x where x.c = 1;
  assert found, 'exactly one referral row must exist for the referred channel';
end
$$;

-- three referred signups from the same referrer sharing one IP-subnet hash:
-- the first two are trusted (only one prior match each), the third — now
-- two prior matches — is auto-flagged as fraud.
do $$
declare v_result text;
begin
  select result into v_result from app_private.record_referral_attribution('0000000c-0000-4000-8000-000000000030'::uuid, 'reftestref', 'shared-subnet');
  assert v_result = 'attributed', 'first shared-subnet referral should not be flagged yet, got: ' || v_result;
  select result into v_result from app_private.record_referral_attribution('0000000c-0000-4000-8000-000000000040'::uuid, 'reftestref', 'shared-subnet');
  assert v_result = 'attributed', 'second shared-subnet referral should not be flagged yet, got: ' || v_result;
  select result into v_result from app_private.record_referral_attribution('0000000c-0000-4000-8000-000000000050'::uuid, 'reftestref', 'shared-subnet');
  assert v_result = 'flagged_fraud', 'third shared-subnet referral must be auto-flagged, got: ' || v_result;
  perform 1 from referrals where referred_channel_id = '0000000c-0000-4000-8000-000000000050'::uuid and status = 'flagged_fraud';
  assert found, 'the flagged referral row must actually carry flagged_fraud status';
end
$$;

-- the referred channel's first paid conversion starts the fraud-review hold
do $$
declare v_hold_expires timestamptz; v_status text;
begin
  perform app_private.apply_channel_subscription_state(
    '0000000c-0000-4000-8000-000000000020'::uuid, 'test', 'acct-referred', 'sub-referred-l03',
    'pro', 'monthly', 19900, 'active', true, current_timestamp, current_timestamp + interval '30 days',
    current_timestamp + interval '30 days', current_timestamp
  );
  select status, hold_expires_at into v_status, v_hold_expires
    from referrals where referred_channel_id = '0000000c-0000-4000-8000-000000000020'::uuid;
  assert v_status = 'paid_pending_hold', 'referral must move to paid_pending_hold on conversion, got: ' || v_status;
  assert v_hold_expires between current_timestamp + interval '13 days' and current_timestamp + interval '15 days',
    'hold must expire ~14 days out, got: ' || v_hold_expires::text;
end
$$;

-- hold expiry, referrer has no active subscription yet -> credit is banked
do $$
declare v_result text; v_credit_days integer; v_credit_status text;
begin
  update referrals set hold_expires_at = current_timestamp - interval '1 minute'
   where referred_channel_id = '0000000c-0000-4000-8000-000000000020'::uuid;

  select result, credit_days into v_result, v_credit_days
    from app_private.grant_referral_service_credit(
      (select id from referrals where referred_channel_id = '0000000c-0000-4000-8000-000000000020'::uuid)
    );
  assert v_result = 'credited', 'hold-expiry grant must succeed, got: ' || v_result;
  assert v_credit_days = 30, 'reward must be 30 days, got: ' || v_credit_days::text;

  select status into v_credit_status
    from referral_credits
   where referral_id = (select id from referrals where referred_channel_id = '0000000c-0000-4000-8000-000000000020'::uuid);
  assert v_credit_status = 'active', 'with no active subscription to apply to, the credit must be banked (active), got: ' || v_credit_status;
end
$$;

-- the referrer later converts to paid: the banked credit is swept and
-- applied within the SAME activation event, not a follow-up write.
do $$
declare v_period_end timestamptz; v_credit_status text;
begin
  perform app_private.apply_channel_subscription_state(
    '0000000c-0000-4000-8000-000000000010'::uuid, 'test', 'acct-referrer', 'sub-referrer-l03',
    'pro', 'monthly', 19900, 'active', true, current_timestamp, current_timestamp + interval '30 days',
    current_timestamp + interval '30 days', current_timestamp
  );
  select current_period_end into v_period_end
    from channel_subscriptions where channel_id = '0000000c-0000-4000-8000-000000000010'::uuid;
  -- base 30-day period + 30-day banked credit = ~60 days out
  assert v_period_end between current_timestamp + interval '58 days' and current_timestamp + interval '61 days',
    'banked credit must extend current_period_end by ~30 more days, got: ' || v_period_end::text;

  select status into v_credit_status
    from referral_credits
   where referral_id = (select id from referrals where referred_channel_id = '0000000c-0000-4000-8000-000000000020'::uuid);
  assert v_credit_status = 'consumed', 'the banked credit must now be consumed, got: ' || v_credit_status;
end
$$;

-- authorization: an unauthorized caller (no app.user_id set) must get an
-- EMPTY result from the overview, not a populated-but-zeroed row — this is
-- a regression test for a real leak caught during implementation, where
-- banked/lifetime totals were independent uncorrelated subqueries that
-- executed regardless of the has_channel_role gate.
do $$
declare v_row_count integer;
begin
  perform set_config('app.user_id', '', true);
  select count(*) into v_row_count from app_private.list_channel_referral_overview('0000000c-0000-4000-8000-000000000010'::uuid);
  assert v_row_count = 0, 'an unauthorized overview call must return zero rows, got: ' || v_row_count::text;
end
$$;

-- authorized as the referrer/owner, the real numbers appear
do $$
declare v_credited integer; v_lifetime integer;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000010', true);
  select credited_count, lifetime_credited_days into v_credited, v_lifetime
    from app_private.list_channel_referral_overview('0000000c-0000-4000-8000-000000000010'::uuid);
  assert v_credited = 1, 'owner must see exactly one credited referral, got: ' || v_credited::text;
  assert v_lifetime = 30, 'owner must see 30 lifetime credited days, got: ' || v_lifetime::text;
end
$$;

-- a referred channel that cancels during the hold window blocks the
-- credit — this is the entire reason the hold exists.
do $$
declare v_result text; v_status text; v_reason text;
begin
  insert into app_users (id, external_subject, display_name, created_at, updated_at)
  values ('0000000a-0000-4000-8000-000000000060', 'ext-ref-060', 'Cancels During Hold', current_timestamp, current_timestamp);
  perform channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000060'::uuid, '0000000a-0000-4000-8000-000000000060'::uuid, 'reftestcancels', 'Cancels During Hold');
  perform result from app_private.record_referral_attribution('0000000c-0000-4000-8000-000000000060'::uuid, 'reftestref', 'hash-cancel');

  perform app_private.apply_channel_subscription_state(
    '0000000c-0000-4000-8000-000000000060'::uuid, 'test', 'acct-cancels', 'sub-cancels-l03',
    'pro', 'monthly', 19900, 'active', true, current_timestamp, current_timestamp + interval '30 days',
    current_timestamp + interval '30 days', current_timestamp
  );
  perform app_private.apply_channel_subscription_state(
    '0000000c-0000-4000-8000-000000000060'::uuid, 'test', 'acct-cancels', 'sub-cancels-l03',
    'pro', 'monthly', 19900, 'cancelled', false, current_timestamp, current_timestamp + interval '30 days',
    null, current_timestamp + interval '1 second'
  );
  update referrals set hold_expires_at = current_timestamp - interval '1 minute'
   where referred_channel_id = '0000000c-0000-4000-8000-000000000060'::uuid;

  select result into v_result
    from app_private.grant_referral_service_credit(
      (select id from referrals where referred_channel_id = '0000000c-0000-4000-8000-000000000060'::uuid)
    );
  assert v_result = 'revoked', 'a referred cancellation during the hold must revoke the credit, got: ' || v_result;

  select status, revoked_reason into v_status, v_reason
    from referrals where referred_channel_id = '0000000c-0000-4000-8000-000000000060'::uuid;
  assert v_status = 'revoked', 'referral status must be revoked, got: ' || v_status;
  assert v_reason = 'referred_subscription_not_active_at_hold_expiry', 'revoked_reason must explain why, got: ' || coalesce(v_reason, '<null>');
end
$$;

-- the monthly credit cap (5 per rolling 30 days) flags the referral as
-- fraud rather than silently dropping or silently over-crediting it.
do $$
declare v_result text; i integer; v_referred_id uuid; v_user_id uuid;
begin
  -- five already-credited referrals this month for the same referrer.
  for i in 1..5 loop
    v_user_id := ('0000000a-0000-4000-8000-0000000000b' || i)::uuid;
    insert into app_users (id, external_subject, display_name, created_at, updated_at)
    values (v_user_id, 'ext-cap-' || i, 'Cap Filler ' || i, current_timestamp, current_timestamp);
    v_referred_id := ('0000000c-0000-4000-8000-0000000000d' || i)::uuid;
    perform channel_id from app_private.create_channel(v_referred_id, v_user_id, 'reftestcap' || i, 'Cap Filler Channel ' || i);
    insert into referrals (id, referrer_channel_id, referred_channel_id, status, credited_at, expires_at)
    values (gen_random_uuid(), '0000000c-0000-4000-8000-000000000010'::uuid, v_referred_id, 'credited', current_timestamp, current_timestamp + interval '90 days');
  end loop;

  -- a sixth referral, past the monthly cap, hits its hold expiry.
  insert into app_users (id, external_subject, display_name, created_at, updated_at)
  values ('0000000a-0000-4000-8000-000000000070', 'ext-ref-070', 'Cap Breaker', current_timestamp, current_timestamp);
  perform channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000070'::uuid, '0000000a-0000-4000-8000-000000000070'::uuid, 'reftestcapbreak', 'Cap Breaker');
  perform result from app_private.record_referral_attribution('0000000c-0000-4000-8000-000000000070'::uuid, 'reftestref', 'hash-cap-breaker');
  perform app_private.apply_channel_subscription_state(
    '0000000c-0000-4000-8000-000000000070'::uuid, 'test', 'acct-cap-breaker', 'sub-cap-breaker-l03',
    'pro', 'monthly', 19900, 'active', true, current_timestamp, current_timestamp + interval '30 days',
    current_timestamp + interval '30 days', current_timestamp
  );
  update referrals set hold_expires_at = current_timestamp - interval '1 minute'
   where referred_channel_id = '0000000c-0000-4000-8000-000000000070'::uuid;

  select result into v_result
    from app_private.grant_referral_service_credit(
      (select id from referrals where referred_channel_id = '0000000c-0000-4000-8000-000000000070'::uuid)
    );
  assert v_result = 'capped', 'a sixth referral in 30 days must hit the monthly cap, got: ' || v_result;

  perform 1 from referrals where referred_channel_id = '0000000c-0000-4000-8000-000000000070'::uuid and status = 'flagged_fraud';
  assert found, 'a capped referral must be recorded as flagged_fraud, not silently dropped';
end
$$;

-- the two-phase maintenance job: accept_maintenance_run recognizes the new
-- job, and run_referral_lifecycle_maintenance actually sweeps a
-- hold-expired referral end to end via the maintenance protocol (not the
-- direct function call used above). Uses its own fresh referrer (not
-- 'reftestref') so the prior monthly-cap test's fixture data — which
-- deliberately pushed reftestref's referrer channel over its 30-day
-- credited-referral cap — cannot also cap this independent scenario.
do $$
declare v_run_id uuid; v_status text; v_credited integer;
declare v_referred_id uuid := '0000000c-0000-4000-8000-000000000080'::uuid;
begin
  insert into app_users (id, external_subject, display_name, created_at, updated_at) values
    ('0000000a-0000-4000-8000-000000000090', 'ext-ref-090', 'Maintenance Referrer', current_timestamp, current_timestamp),
    ('0000000a-0000-4000-8000-000000000080', 'ext-ref-080', 'Maintenance Path', current_timestamp, current_timestamp);
  perform channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000090'::uuid, '0000000a-0000-4000-8000-000000000090'::uuid, 'reftestmaintref', 'Maintenance Referrer Channel');
  perform channel_id from app_private.create_channel(v_referred_id, '0000000a-0000-4000-8000-000000000080'::uuid, 'reftestmaint', 'Maintenance Path');
  perform result from app_private.record_referral_attribution(v_referred_id, 'reftestmaintref', 'hash-maint');
  perform app_private.apply_channel_subscription_state(
    v_referred_id, 'test', 'acct-maint', 'sub-maint-l03',
    'pro', 'monthly', 19900, 'active', true, current_timestamp, current_timestamp + interval '30 days',
    current_timestamp + interval '30 days', current_timestamp
  );
  update referrals set hold_expires_at = current_timestamp - interval '1 minute' where referred_channel_id = v_referred_id;

  select run_id, status into v_run_id, v_status
    from app_private.accept_maintenance_run('referral-lifecycle', 'l03-test-referral-lifecycle-key-001');
  assert v_status = 'accepted', 'accept_maintenance_run must accept the new job, got: ' || v_status;

  select status, credited_count into v_status, v_credited
    from app_private.run_referral_lifecycle_maintenance(v_run_id);
  assert v_status = 'completed', 'the maintenance run must complete, got: ' || v_status;
  assert v_credited >= 1, 'the maintenance sweep must have credited at least the fixture referral, got: ' || v_credited::text;

  perform 1 from referrals where referred_channel_id = v_referred_id and status = 'credited';
  assert found, 'the swept referral must now be credited';

  -- replay must report already_completed, not redo the work
  select status into v_status
    from app_private.run_referral_lifecycle_maintenance(v_run_id);
  assert v_status = 'already_completed', 'a replayed run must report already_completed, got: ' || v_status;
end
$$;

rollback;
