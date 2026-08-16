-- L04 acceptance: creator account registration is pending until the payment
-- service activates it; switching/revocation are audited and do not mutate
-- any already-created payment intent's frozen account snapshot.

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);

do $$
declare
  account_status text;
  account_ref text;
begin
  select status, connected_account_ref
    into account_status, account_ref
    from app_private.register_creator_payment_account(
      '00000000-0000-0000-0000-000000000045',
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000001',
      'live',
      'acct_l04_initial'
    );
  if account_status <> 'pending' or account_ref <> 'acct_l04_initial' then
    raise exception 'new creator account was not pending: status %, ref %', account_status, account_ref;
  end if;
end
$$;

reset role;
set local role bsa_payment;
do $$
begin
  if not app_private.activate_creator_payment_account(
    '00000000-0000-4000-8000-000000000011', 'live',
    'acct_l04_initial', 'payment-service-test', 'provider-check-l04-1'
  ) then
    raise exception 'payment service could not activate the registered creator account';
  end if;
end
$$;

reset role;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
do $$
declare
  account_status text;
begin
  select status
    into account_status
    from app_private.register_creator_payment_account(
      '00000000-0000-0000-0000-000000000046',
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000001',
      'live',
      'acct_l04_next'
    );
  if account_status <> 'pending' then
    raise exception 'switching a creator account did not return to pending: %', account_status;
  end if;
end
$$;

do $$
declare
  frozen_ref text;
begin
  select connected_account_ref
    into frozen_ref
    from payment_order_intents
   where id = '00000000-0000-0000-0000-000000000111';
  if frozen_ref <> 'acct_synthetic_a' then
    raise exception 'existing payment intent account snapshot changed: %', frozen_ref;
  end if;
end
$$;

do $$
begin
  if not app_private.revoke_creator_payment_account(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000001',
    'live'
  ) then
    raise exception 'creator account revocation did not report success';
  end if;
end
$$;

reset role;
set local role postgres;
do $$
declare
  audit_count integer;
  final_status text;
begin
  select status into final_status
    from payment_accounts
   where channel_id = '00000000-0000-4000-8000-000000000011'
     and environment = 'live';
  select count(*)::int into audit_count
    from payment_account_audit
   where channel_id = '00000000-0000-4000-8000-000000000011'
     and next_account_ref in ('acct_l04_initial', 'acct_l04_next');
  if final_status <> 'revoked' or audit_count <> 4 then
    raise exception 'creator account audit lifecycle incomplete: status %, audit rows %', final_status, audit_count;
  end if;
end
$$;

-- Payout onboarding gate (migration 0079): skipping is idempotent (a
-- second call keeps the first skip time, not a later one), restricted to
-- owner/admin same as every other payment-account mutation, and rejects
-- an unknown/closed channel.
reset role;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
do $$
declare
  first_skip timestamptz;
  second_skip timestamptz;
begin
  select app_private.skip_payout_onboarding(
    '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001'
  ) into first_skip;
  if first_skip is null then
    raise exception 'payout onboarding skip did not return a timestamp';
  end if;
  perform pg_sleep(0.01);
  select app_private.skip_payout_onboarding(
    '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001'
  ) into second_skip;
  if second_skip <> first_skip then
    raise exception 'payout onboarding skip is not idempotent: first %, second %', first_skip, second_skip;
  end if;
end
$$;

do $$
declare
  stored timestamptz;
begin
  select payout_onboarding_skipped_at into stored
    from channels
   where id = '00000000-0000-4000-8000-000000000011';
  if stored is null then
    raise exception 'payout_onboarding_skipped_at was not persisted';
  end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000006', true);
do $$
begin
  begin
    perform app_private.skip_payout_onboarding(
      '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000006'
    );
    raise exception 'viewer role was able to skip payout onboarding';
  exception when others then
    if sqlerrm !~ 'invalid payout-onboarding skip' then
      raise;
    end if;
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
do $$
begin
  begin
    perform app_private.skip_payout_onboarding(
      '00000000-0000-4000-8000-000000000099', '00000000-0000-4000-8000-000000000001'
    );
    raise exception 'skip succeeded against a nonexistent channel';
  exception when others then
    if sqlerrm !~ 'channel not found' and sqlerrm !~ 'invalid payout-onboarding skip' then
      raise;
    end if;
  end;
end
$$;

rollback;

select 'L04_PAYMENT_ACCOUNT_ONBOARDING=PASS' as result;
