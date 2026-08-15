-- Carry the payment's immutable linked-account reference into refund
-- reconciliation so provider reads cannot cross creator accounts.

drop function if exists app_private.list_refund_reconciliation_candidates(integer);
create function app_private.list_refund_reconciliation_candidates(
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
     and refund.status = 'requested'
   order by refund.updated_at asc, refund.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

revoke execute on function app_private.list_refund_reconciliation_candidates(integer) from public;
grant execute on function app_private.list_refund_reconciliation_candidates(integer) to bsa_payment;
