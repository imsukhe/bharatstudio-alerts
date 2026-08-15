-- Carry the immutable Razorpay linked-account reference into reconciliation.
-- A process-wide account environment variable is not safe once more than one
-- creator channel is active.

drop function if exists app_private.list_payment_reconciliation_candidates(integer);
create function app_private.list_payment_reconciliation_candidates(
  target_limit integer
)
returns table (
  intent_id uuid,
  connected_account_ref text,
  provider_order_id text,
  provider_receipt text,
  amount_paise bigint,
  currency text,
  status text,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select intent.id, intent.connected_account_ref, intent.provider_order_id,
         intent.provider_receipt, intent.gross_amount_paise, intent.currency,
         intent.status, intent.expires_at
    from public.payment_order_intents intent
   where intent.provider = 'razorpay'
     and intent.provider_order_id is not null
     and intent.status in ('provider_pending', 'provider_created')
   order by intent.updated_at asc, intent.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

revoke execute on function app_private.list_payment_reconciliation_candidates(integer) from public;
grant execute on function app_private.list_payment_reconciliation_candidates(integer) to bsa_payment;
