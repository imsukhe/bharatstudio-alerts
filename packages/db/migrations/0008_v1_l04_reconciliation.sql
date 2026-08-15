-- BharatStudio Alerts v1 L04 reconciliation persistence.
--
-- The private payment service calls these functions after it fetches and
-- validates a provider order. They never perform provider I/O and never mark
-- a payment paid from an order-level status.

create or replace function app_private.list_payment_reconciliation_candidates(
  target_limit integer
)
returns table (
  intent_id uuid,
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
  select intent.id, intent.provider_order_id, intent.provider_receipt,
         intent.gross_amount_paise, intent.currency, intent.status, intent.expires_at
    from public.payment_order_intents intent
   where intent.provider = 'razorpay'
     and intent.provider_order_id is not null
     and intent.status in ('provider_pending', 'provider_created')
   order by intent.updated_at asc, intent.id asc
   limit greatest(1, least(coalesce(target_limit, 1), 500))
$$;

create or replace function app_private.expire_payment_order_intent(
  target_intent_id uuid,
  target_provider_status text
)
returns table (intent_id uuid, status text)
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  update public.payment_order_intents intent
     set status = 'expired', updated_at = current_timestamp,
         provider_claim_token = null, provider_claim_until = null
   where intent.id = target_intent_id
     and target_provider_status in ('created', 'attempted')
     and intent.status in ('provider_pending', 'provider_created')
     and intent.expires_at <= current_timestamp
  returning intent.id, intent.status
$$;

create or replace function app_private.enqueue_payment_recovery(
  target_intent_id uuid,
  target_provider_order_id text,
  target_observed_at timestamptz
)
returns table (work_item_id uuid, status text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  local_work_item_id uuid;
  local_status text;
begin
  if target_intent_id is null
     or target_provider_order_id is null
     or length(target_provider_order_id) = 0
     or length(target_provider_order_id) > 128
     or target_observed_at is null then
    raise exception 'invalid payment recovery request' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.payment_order_intents intent
     where intent.id = target_intent_id
       and intent.provider = 'razorpay'
       and intent.provider_order_id = target_provider_order_id
  ) then
    raise exception 'payment recovery intent/order mismatch' using errcode = '42501';
  end if;

  insert into public.reconciliation_work_items (
    id, kind, idempotency_key, status, payload, created_at, updated_at
  )
  values (
    md5('bharatstudio:payment-recovery:' || target_provider_order_id)::uuid,
    'payment-recovery',
    'razorpay-order:' || target_provider_order_id,
    'pending',
    jsonb_build_object(
      'intentId', target_intent_id,
      'provider', 'razorpay',
      'providerOrderId', target_provider_order_id,
      'observedAt', target_observed_at
    ),
    current_timestamp,
    current_timestamp
  )
  on conflict (kind, idempotency_key) do nothing
  returning id, reconciliation_work_items.status
  into local_work_item_id, local_status;

  if local_work_item_id is null then
    select item.id, item.status
      into local_work_item_id, local_status
      from public.reconciliation_work_items item
     where item.kind = 'payment-recovery'
       and item.idempotency_key = 'razorpay-order:' || target_provider_order_id;
  end if;

  return query select local_work_item_id, local_status;
end
$$;

revoke execute on function app_private.list_payment_reconciliation_candidates(integer) from public;
revoke execute on function app_private.expire_payment_order_intent(uuid, text) from public;
revoke execute on function app_private.enqueue_payment_recovery(uuid, text, timestamptz) from public;
grant execute on function app_private.list_payment_reconciliation_candidates(integer) to bsa_payment;
grant execute on function app_private.expire_payment_order_intent(uuid, text) to bsa_payment;
grant execute on function app_private.enqueue_payment_recovery(uuid, text, timestamptz) to bsa_payment;
grant usage on schema app_private to bsa_payment;
