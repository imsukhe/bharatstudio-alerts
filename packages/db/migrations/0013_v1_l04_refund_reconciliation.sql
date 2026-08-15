-- Refund reconciliation is provider-status recovery only. It never creates a
-- refund and never rewrites payment/event evidence.
create or replace function app_private.list_refund_reconciliation_candidates(
  target_limit integer
)
returns table (
  refund_id uuid,
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
  select refund.id, refund.provider_refund_id, payment.provider_payment_id,
         refund.amount_paise, payment.currency, refund.status
    from public.refunds refund
    join public.payments payment on payment.id = refund.payment_id
   where payment.provider = 'razorpay'
     and refund.status = 'requested'
   order by refund.updated_at asc, refund.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

create or replace function app_private.apply_refund_reconciliation(
  target_refund_id uuid,
  target_provider_refund_id text,
  target_provider_payment_id text,
  target_amount_paise bigint,
  target_currency text,
  target_provider_status text
)
returns table (refund_id uuid, refund_status text, payment_status text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  local_payment_id uuid;
  next_status text;
begin
  if target_refund_id is null
     or target_provider_refund_id is null
     or length(target_provider_refund_id) = 0
     or target_provider_payment_id is null
     or target_amount_paise <= 0
     or target_currency <> 'INR'
     or target_provider_status not in ('processed', 'failed', 'reversed') then
    raise exception 'invalid refund reconciliation' using errcode = '22023';
  end if;

  select refund.payment_id
    into local_payment_id
    from public.refunds refund
    join public.payments payment on payment.id = refund.payment_id
   where refund.id = target_refund_id
     and refund.provider_refund_id = target_provider_refund_id
     and refund.amount_paise = target_amount_paise
     and payment.provider_payment_id = target_provider_payment_id
     and payment.currency = target_currency
   for update;
  if local_payment_id is null then
    raise exception 'refund reconciliation identity mismatch' using errcode = '42501';
  end if;

  next_status := target_provider_status;
  update public.refunds
     set status = next_status, updated_at = current_timestamp
   where id = target_refund_id
  returning id, status into refund_id, refund_status;

  update public.payments payment
     set status = case
       when coalesce((select sum(refund.amount_paise) from public.refunds refund where refund.payment_id = payment.id and refund.status = 'processed'), 0) >= payment.gross_amount_paise then 'refunded'
       when exists (select 1 from public.refunds refund where refund.payment_id = payment.id and refund.status = 'processed') then 'partially_refunded'
       else payment.status
     end,
     updated_at = current_timestamp
   where payment.id = local_payment_id
  returning payment.status into payment_status;

  return next;
end
$$;

revoke execute on function app_private.list_refund_reconciliation_candidates(integer) from public;
revoke execute on function app_private.apply_refund_reconciliation(uuid, text, text, bigint, text, text) from public;
grant execute on function app_private.list_refund_reconciliation_candidates(integer) to bsa_payment;
grant execute on function app_private.apply_refund_reconciliation(uuid, text, text, bigint, text, text) to bsa_payment;
