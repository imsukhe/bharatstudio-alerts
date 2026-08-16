-- L04 acceptance: an unknown provider state is durably quarantined, excluded
-- from automated selection, and becomes eligible only after explicit review.

insert into payment_order_intents (
  id, channel_id, payment_account_id, provider, environment,
  connected_account_ref, idempotency_key, provider_receipt, provider_order_id,
  gross_amount_paise, currency, donor_display_name, donor_message, alert_consent,
  status, expires_at, created_at, updated_at
) values (
  '00000000-0000-4000-8000-0000000001f1',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000041',
  'razorpay', 'test', 'acct_synthetic_a', 'quarantine-intent-1',
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
values ('00000000-0000-4000-8000-0000000001f2', '00000000-0000-4000-8000-000000000131', 'rfnd_quarantine_1', 500, 'requested', current_timestamp, current_timestamp);

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

select 'L04_RECONCILIATION_QUARANTINE=PASS' as result;
