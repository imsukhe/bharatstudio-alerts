-- Close a payment-recovery work item only after payment-level evidence has
-- been persisted through record_verified_payment_webhook.
create or replace function app_private.complete_payment_recovery(
  target_provider_order_id text
)
returns table (work_item_id uuid, status text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_provider_order_id is null or length(target_provider_order_id) = 0 or length(target_provider_order_id) > 128 then
    raise exception 'invalid payment recovery completion' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.payments payment
     where payment.provider = 'razorpay'
       and payment.provider_order_id = target_provider_order_id
       and payment.status in ('captured', 'partially_refunded', 'refunded')
  ) then
    raise exception 'payment-level recovery evidence not persisted' using errcode = '55000';
  end if;

  update public.reconciliation_work_items item
     set status = 'completed', updated_at = current_timestamp
   where item.kind = 'payment-recovery'
     and item.idempotency_key = 'razorpay-order:' || target_provider_order_id
     and item.status in ('pending', 'running', 'retryable_failure')
  returning item.id, item.status into work_item_id, status;

  if work_item_id is null then
    select item.id, item.status into work_item_id, status
      from public.reconciliation_work_items item
     where item.kind = 'payment-recovery'
       and item.idempotency_key = 'razorpay-order:' || target_provider_order_id;
  end if;
  if work_item_id is null then
    raise exception 'payment recovery work item not found' using errcode = 'P0002';
  end if;
  return next;
end
$$;

revoke execute on function app_private.complete_payment_recovery(text) from public;
grant execute on function app_private.complete_payment_recovery(text) to bsa_payment;
