-- L04 acceptance: an unknown provider state is durably quarantined, excluded
-- from automated selection, and becomes eligible only after explicit review.
--
-- Self-contained fixture (ids block 00000000-...-0000000014xx, see the
-- allocation note in fixtures/00_base_world.sql): this test used to depend on
-- payment_account '...0041' and payment '...0131', which only
-- l03_application_behavior.sql created as side effects of trigger-tested
-- inserts. Pre-seeding those exact ids elsewhere made l03 fail instead (it
-- asserts on the trigger side effects of creating them). It must also not reuse
-- that shared channel: payment_accounts intentionally has one provider/env
-- slot per channel. This file therefore creates its own channel, account and
-- payment via plain inserts, with no default-binding/identity-guard trigger.

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values (
  '00000000-0000-4000-8000-000000001400',
  '00000000-0000-4000-8000-000000000001',
  'l04_reconciliation_fixture',
  'L04 Reconciliation Fixture',
  true,
  1,
  current_timestamp,
  current_timestamp
);

insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001401', '00000000-0000-4000-8000-000000001400', 'razorpay', 'test', 'acct_l04_fixture', 'active', current_timestamp, current_timestamp);

insert into payments (
  id, channel_id, provider, provider_payment_id, provider_order_id,
  gross_amount_paise, currency, status, environment, connected_account_ref,
  created_at, updated_at
)
values (
  '00000000-0000-4000-8000-000000001402',
  '00000000-0000-4000-8000-000000001400',
  'razorpay', 'pay_l04_fixture_1', 'order_l04_fixture_1', 5000, 'INR',
  'captured', 'test', 'acct_l04_fixture', current_timestamp, current_timestamp
);

insert into payment_order_intents (
  id, channel_id, payment_account_id, provider, environment,
  connected_account_ref, idempotency_key, provider_receipt, provider_order_id,
  gross_amount_paise, currency, donor_display_name, donor_message, alert_consent,
  status, expires_at, created_at, updated_at
) values (
  '00000000-0000-4000-8000-0000000001f1',
  '00000000-0000-4000-8000-000000001400',
  '00000000-0000-4000-8000-000000001401',
  'razorpay', 'test', 'acct_l04_fixture', 'quarantine-intent-1',
  'quarantine-receipt-1', 'order-quarantine-1', 5000, 'INR', '', '', true,
  'provider_created', current_timestamp + interval '10 minutes', current_timestamp, current_timestamp
);

begin;
set local role bsa_payment;
do $$
begin
  if (select count(*) from app_private.list_payment_reconciliation_candidates(20)
      where intent_id = '00000000-0000-4000-8000-0000000001f1') <> 1 then
    raise exception 'payment quarantine candidate was not initially selectable';
  end if;
  if not app_private.quarantine_payment_reconciliation(
    '00000000-0000-4000-8000-0000000001f1', 'unsupported provider status: cancelled'
  ) then
    raise exception 'payment quarantine did not return success';
  end if;
  if (select count(*) from app_private.list_payment_reconciliation_candidates(20)
      where intent_id = '00000000-0000-4000-8000-0000000001f1') <> 0 then
    raise exception 'open payment manual review remained selectable';
  end if;
  if not app_private.resolve_reconciliation_manual_review(
    'payment', '00000000-0000-4000-8000-0000000001f1', 'resolved',
    'synthetic-operator', 'Reviewed provider state'
  ) then
    raise exception 'payment manual review did not resolve';
  end if;
  if (select count(*) from app_private.list_payment_reconciliation_candidates(20)
      where intent_id = '00000000-0000-4000-8000-0000000001f1') <> 1 then
    raise exception 'resolved payment manual review did not re-open selection';
  end if;
end
$$;
commit;

insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000001f2', '00000000-0000-4000-8000-000000001402', 'rfnd_quarantine_1', 500, 'requested', current_timestamp, current_timestamp);

begin;
set local role bsa_payment;
do $$
begin
  if (select count(*) from app_private.list_refund_reconciliation_candidates(20)
      where refund_id = '00000000-0000-4000-8000-0000000001f2') <> 1 then
    raise exception 'refund quarantine candidate was not initially selectable';
  end if;
  if not app_private.quarantine_refund_reconciliation(
    '00000000-0000-4000-8000-0000000001f2', 'provider refund identity mismatch'
  ) then
    raise exception 'refund quarantine did not return success';
  end if;
  if (select count(*) from app_private.list_refund_reconciliation_candidates(20)
      where refund_id = '00000000-0000-4000-8000-0000000001f2') <> 0 then
    raise exception 'open refund manual review remained selectable';
  end if;
  if not app_private.resolve_reconciliation_manual_review(
    'refund', '00000000-0000-4000-8000-0000000001f2', 'rejected',
    'synthetic-operator', 'Provider evidence rejected'
  ) then
    raise exception 'refund manual review did not resolve';
  end if;
  if (select count(*) from app_private.list_refund_reconciliation_candidates(20)
      where refund_id = '00000000-0000-4000-8000-0000000001f2') <> 1 then
    raise exception 'resolved refund manual review did not re-open selection';
  end if;
end
$$;
commit;

-- Historical/manual payment evidence without an immutable provider-account
-- reference is never eligible for an automated provider fetch. It remains
-- durable evidence for manual handling, but must not turn into a NULL scan or
-- accountless reconciliation request.
insert into payments (
  id, channel_id, provider, provider_payment_id, provider_order_id,
  gross_amount_paise, currency, status, created_at, updated_at
)
values (
  '00000000-0000-4000-8000-000000001403',
  '00000000-0000-4000-8000-000000001400',
  'razorpay', 'pay_l04_legacy_without_account', 'order_l04_legacy_without_account',
  5000, 'INR', 'captured', current_timestamp, current_timestamp
);

insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values (
  '00000000-0000-4000-8000-000000001404',
  '00000000-0000-4000-8000-000000001403',
  'rfnd_l04_legacy_without_account', 500, 'requested', current_timestamp, current_timestamp
);

begin;
set local role bsa_payment;
do $$
begin
  if exists (
    select 1
      from app_private.list_refund_reconciliation_candidates(20)
     where refund_id = '00000000-0000-4000-8000-000000001404'
  ) then
    raise exception 'accountless historical refund was eligible for automated reconciliation';
  end if;
end
$$;
commit;

-- A nonempty legacy value with unsafe header characters is equally ineligible.
-- This mirrors the provider client's linked-account grammar at the database
-- selection boundary, before any network call can be attempted.
insert into payments (
  id, channel_id, provider, provider_payment_id, provider_order_id,
  gross_amount_paise, currency, status, environment, connected_account_ref,
  created_at, updated_at
)
values (
  '00000000-0000-4000-8000-000000001405',
  '00000000-0000-4000-8000-000000001400',
  'razorpay', 'pay_l04_legacy_malformed_account', 'order_l04_legacy_malformed_account',
  5000, 'INR', 'captured', 'test', 'acct_l04/unsafe', current_timestamp, current_timestamp
);

insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values (
  '00000000-0000-4000-8000-000000001406',
  '00000000-0000-4000-8000-000000001405',
  'rfnd_l04_legacy_malformed_account', 500, 'requested', current_timestamp, current_timestamp
);

begin;
set local role bsa_payment;
do $$
begin
  if exists (
    select 1
      from app_private.list_refund_reconciliation_candidates(20)
     where refund_id = '00000000-0000-4000-8000-000000001406'
  ) then
    raise exception 'malformed-account refund was eligible for automated reconciliation';
  end if;
end
$$;
commit;

select 'L04_RECONCILIATION_QUARANTINE=PASS' as result;
