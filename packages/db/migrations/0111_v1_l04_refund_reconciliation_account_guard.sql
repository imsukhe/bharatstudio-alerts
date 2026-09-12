-- A refund cannot be reconciled against a provider account unless the captured
-- payment retained its immutable account context. Older/manual evidence can
-- legitimately predate account attribution; it must stay out of automated
-- provider calls rather than becoming a NULL scan or an accountless request.

create or replace function app_private.list_refund_reconciliation_candidates(
  target_limit integer
)
returns table (
  refund_id uuid,
  connected_account_ref text,
  provider_refund_id text,
  provider_payment_id text,
  amount_paise bigint,
  currency text,
  status text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select refund.id, payment.connected_account_ref,
         refund.provider_refund_id, payment.provider_payment_id,
         refund.amount_paise, payment.currency, refund.status
    from public.refunds refund
    join public.payments payment on payment.id = refund.payment_id
   where payment.provider = 'razorpay'
     and payment.environment in ('test', 'live')
     and payment.connected_account_ref is not null
     -- Keep this eligibility predicate aligned with the provider client's
     -- validConnectedAccountRef: a malformed legacy value must not create a
     -- retry loop or be emitted as an HTTP header.
     and payment.connected_account_ref ~ '^[A-Za-z0-9._:-]{1,64}$'
     and refund.status = 'requested'
     and not exists (
       select 1 from public.payment_reconciliation_manual_reviews review
        where review.kind = 'refund'
          and review.target_id = refund.id
          and review.status = 'open'
     )
   order by refund.updated_at asc, refund.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

revoke execute on function app_private.list_refund_reconciliation_candidates(integer) from public;
grant execute on function app_private.list_refund_reconciliation_candidates(integer) to bsa_payment;
