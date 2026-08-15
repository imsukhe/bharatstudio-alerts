-- L04 dispute evidence.
--
-- Dispute webhooks are append-only provider evidence. They do not rewrite the
-- original payment/tip/alert or move funds. A payment may be unknown when the
-- dispute arrives, so payment_id is nullable and can be linked by a later
-- reconciliation process.

create table if not exists public.payment_disputes (
  id uuid primary key,
  provider text not null check (provider = 'razorpay'),
  environment text not null check (environment in ('test', 'live')),
  connected_account_ref text not null,
  provider_dispute_id text not null,
  provider_payment_id text not null,
  payment_id uuid references public.payments(id),
  amount_paise bigint not null check (amount_paise > 0),
  currency text not null check (currency = 'INR'),
  status text not null check (status in ('open', 'under_review', 'action_required', 'won', 'lost', 'closed')),
  provider_event_name text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (provider, environment, connected_account_ref, provider_dispute_id)
);

create index if not exists payment_disputes_payment_idx
  on public.payment_disputes (payment_id, updated_at);

create index if not exists payment_disputes_provider_payment_idx
  on public.payment_disputes (provider, environment, connected_account_ref, provider_payment_id);

alter table public.payment_disputes enable row level security;
revoke all on public.payment_disputes from public;
revoke all on public.payment_disputes from bsa_app;
revoke all on public.payment_disputes from bsa_payment;

create or replace function app_private.record_verified_dispute_webhook(
  target_delivery_id uuid,
  target_environment text,
  target_connected_account_ref text,
  target_provider_event_id text,
  target_raw_body_hash text,
  target_signature_verified_at timestamptz,
  target_received_at timestamptz,
  target_normalized jsonb,
  target_dispute_id uuid
)
returns table (
  duplicate boolean,
  quarantined boolean,
  payment_id uuid,
  dispute_id uuid,
  delivery_status text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  normalized_event text := target_normalized ->> 'event';
  normalized_type text := target_normalized ->> 'entityType';
  normalized_entity_id text := target_normalized ->> 'entityId';
  normalized_payment_id text := target_normalized ->> 'paymentId';
  normalized_currency text := target_normalized ->> 'currency';
  normalized_amount bigint := nullif(target_normalized ->> 'amountPaise', '')::bigint;
  local_payment_id uuid;
  local_status text;
  existing_delivery_id uuid;
begin
  if target_environment not in ('test', 'live')
     or target_connected_account_ref is null
     or target_provider_event_id is null
     or length(target_provider_event_id) = 0
     or target_normalized is null
     or normalized_event not in (
       'payment.dispute.created',
       'payment.dispute.under_review',
       'payment.dispute.action_required',
       'payment.dispute.won',
       'payment.dispute.lost',
       'payment.dispute.closed'
     )
     or normalized_type <> 'dispute'
     or normalized_entity_id is null
     or normalized_payment_id is null
     or normalized_amount is null
     or normalized_amount <= 0
     or normalized_currency <> 'INR'
     or target_delivery_id is null
     or target_signature_verified_at is null
     or target_received_at is null
     or target_dispute_id is null then
    raise exception 'invalid normalized dispute webhook' using errcode = '22023';
  end if;

  insert into public.payment_webhook_deliveries (
    id, provider, environment, connected_account_ref, provider_event_id,
    provider_event_name, entity_type, entity_id, raw_body_hash,
    signature_verified_at, received_at, processing_status
  )
  values (
    target_delivery_id, 'razorpay', target_environment, target_connected_account_ref,
    target_provider_event_id, normalized_event, 'dispute', normalized_entity_id,
    target_raw_body_hash, target_signature_verified_at, target_received_at, 'received'
  )
  on conflict (provider, environment, connected_account_ref, provider_event_id)
  do nothing
  returning id into existing_delivery_id;

  if existing_delivery_id is null then
    return query select true, false, null::uuid, null::uuid, 'duplicate';
    return;
  end if;

  select payment.id
    into local_payment_id
    from public.payments payment
   where payment.provider = 'razorpay'
     and payment.environment = target_environment
     and payment.connected_account_ref = target_connected_account_ref
     and payment.provider_payment_id = normalized_payment_id
   limit 1;

  local_status := case normalized_event
    when 'payment.dispute.created' then 'open'
    when 'payment.dispute.under_review' then 'under_review'
    when 'payment.dispute.action_required' then 'action_required'
    when 'payment.dispute.won' then 'won'
    when 'payment.dispute.lost' then 'lost'
    when 'payment.dispute.closed' then 'closed'
  end;

  insert into public.payment_disputes (
    id, provider, environment, connected_account_ref,
    provider_dispute_id, provider_payment_id, payment_id,
    amount_paise, currency, status, provider_event_name,
    first_seen_at, last_seen_at, created_at, updated_at
  )
  values (
    target_dispute_id, 'razorpay', target_environment, target_connected_account_ref,
    normalized_entity_id, normalized_payment_id, local_payment_id,
    normalized_amount, normalized_currency, local_status, normalized_event,
    target_received_at, target_received_at, current_timestamp, current_timestamp
  )
  on conflict (provider, environment, connected_account_ref, provider_dispute_id)
  do update set
    payment_id = coalesce(public.payment_disputes.payment_id, excluded.payment_id),
    status = case
      when (
        case excluded.status
          when 'open' then 10
          when 'under_review' then 20
          when 'action_required' then 20
          when 'won' then 30
          when 'lost' then 30
          when 'closed' then 40
        end
      ) >= (
        case public.payment_disputes.status
          when 'open' then 10
          when 'under_review' then 20
          when 'action_required' then 20
          when 'won' then 30
          when 'lost' then 30
          when 'closed' then 40
        end
      ) then excluded.status
      else public.payment_disputes.status
    end,
    provider_event_name = excluded.provider_event_name,
    last_seen_at = excluded.last_seen_at,
    updated_at = current_timestamp;

  update public.payment_webhook_deliveries
     set processing_status = 'processed'
   where id = target_delivery_id;

  return query
    select false, false, local_payment_id, target_dispute_id, 'processed';
end
$$;

revoke execute on function app_private.record_verified_dispute_webhook(uuid, text, text, text, text, timestamptz, timestamptz, jsonb, uuid) from public;
grant execute on function app_private.record_verified_dispute_webhook(uuid, text, text, text, text, timestamptz, timestamptz, jsonb, uuid) to bsa_payment;
