-- BharatStudio Alerts v1 L19d dynamic UPI QR codes.
--
-- Depends on 0001 through 0122 (in particular 0006's payment_order_intents).
-- This migration adds a new, decoupled table for Razorpay QR-code entities
-- rather than altering payment_order_intents: a QR is a separate provider
-- object with its own id space and status vocabulary (see
-- services/payment-webhook-go/internal/provider/razorpay_qr.go), not a
-- column on the order row. One intent has at most one QR (unique
-- intent_id): a QR is an alternative payment surface offered for an
-- intent that has not yet been paid, never a second, independent path to
-- money for an intent that has.
--
-- This does not create or touch creator_balance, withdrawable_amount,
-- bharatstudio_held_funds or payout_request (master plan 1.4) and it does
-- not persist any card/UPI-instrument data: only an id, an image URL and a
-- status cross this boundary.

create table payment_order_qr_codes (
  id uuid primary key,
  intent_id uuid not null references payment_order_intents(id),
  channel_id uuid not null references channels(id),
  provider text not null check (provider = 'razorpay'),
  environment text not null check (environment in ('test', 'live')),
  connected_account_ref text not null,
  amount_paise bigint not null check (amount_paise >= 1000),
  currency text not null check (currency = 'INR'),
  provider_receipt text not null,
  provider_qr_id text,
  provider_claim_token uuid,
  provider_claim_until timestamptz,
  qr_image_url text,
  status text not null check (status in ('provider_pending', 'provider_created', 'expired', 'closed')),
  provider_created_at timestamptz,
  close_by timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint payment_order_qr_codes_intent_unique
    unique (intent_id),
  constraint payment_order_qr_codes_provider_qr_unique
    unique (provider, environment, connected_account_ref, provider_qr_id)
);

create index payment_order_qr_codes_status_idx
  on payment_order_qr_codes (status, updated_at);

-- Returns the immutable fields needed to create a QR for an intent that is
-- still open (provider_pending or provider_created — i.e. not yet paid,
-- expired, or failed). Callers must never be able to widen eligibility by
-- passing a different status themselves; this function is the single place
-- that decides eligibility from the authoritative intent row.
create or replace function app_private.get_eligible_payment_order_intent(
  target_intent_id uuid,
  target_channel_id uuid,
  target_environment text
)
returns table (
  intent_id uuid,
  connected_account_ref text,
  amount_paise bigint,
  currency text,
  provider_receipt text,
  status text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select intent.id, intent.connected_account_ref, intent.gross_amount_paise,
         intent.currency, intent.provider_receipt, intent.status
    from public.payment_order_intents intent
   where intent.id = target_intent_id
     and intent.channel_id = target_channel_id
     and intent.environment = target_environment
     and intent.status in ('provider_pending', 'provider_created')
$$;

-- Idempotent per intent: a retry with the same intent id returns the
-- existing row unchanged rather than creating a second QR for it.
create or replace function app_private.create_payment_order_qr(
  target_id uuid,
  target_intent_id uuid,
  target_close_by timestamptz
)
returns table (
  qr_id uuid,
  connected_account_ref text,
  amount_paise bigint,
  currency text,
  provider_receipt text,
  provider_qr_id text,
  qr_image_url text,
  close_by timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  intent payment_order_intents%rowtype;
  qr payment_order_qr_codes%rowtype;
begin
  if target_close_by is null or target_close_by <= current_timestamp then
    raise exception 'invalid qr close_by' using errcode = '22023';
  end if;

  select order_intent.*
    into intent
    from public.payment_order_intents order_intent
   where order_intent.id = target_intent_id
     and order_intent.status in ('provider_pending', 'provider_created');

  if not found then
    raise exception 'intent is not eligible for qr creation' using errcode = '42501';
  end if;

  select existing.*
    into qr
    from public.payment_order_qr_codes existing
   where existing.intent_id = target_intent_id;

  if found then
    return query select qr.id, qr.connected_account_ref, qr.amount_paise,
                        qr.currency, qr.provider_receipt, qr.provider_qr_id,
                        qr.qr_image_url, qr.close_by;
    return;
  end if;

  insert into public.payment_order_qr_codes (
    id, intent_id, channel_id, provider, environment, connected_account_ref,
    amount_paise, currency, provider_receipt, status, close_by, created_at, updated_at
  )
  values (
    target_id, intent.id, intent.channel_id, intent.provider, intent.environment,
    intent.connected_account_ref, intent.gross_amount_paise, intent.currency,
    intent.provider_receipt, 'provider_pending', target_close_by,
    current_timestamp, current_timestamp
  )
  on conflict on constraint payment_order_qr_codes_intent_unique do nothing;

  select existing.*
    into qr
    from public.payment_order_qr_codes existing
   where existing.intent_id = target_intent_id;

  return query select qr.id, qr.connected_account_ref, qr.amount_paise,
                      qr.currency, qr.provider_receipt, qr.provider_qr_id,
                      qr.qr_image_url, qr.close_by;
end
$$;

create or replace function app_private.claim_payment_order_qr(
  target_qr_id uuid,
  target_claim_token uuid,
  target_claim_until timestamptz
)
returns table (qr_id uuid, amount_paise bigint, currency text, provider_receipt text)
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  update public.payment_order_qr_codes qr
     set provider_claim_token = target_claim_token,
         provider_claim_until = target_claim_until,
         updated_at = current_timestamp
   where qr.id = target_qr_id
     and qr.status = 'provider_pending'
     and qr.provider_qr_id is null
     and (qr.provider_claim_until is null or qr.provider_claim_until <= current_timestamp)
     and target_claim_token is not null
     and target_claim_until > current_timestamp
  returning qr.id, qr.amount_paise, qr.currency, qr.provider_receipt
$$;

create or replace function app_private.attach_provider_qr(
  target_qr_id uuid,
  target_claim_token uuid,
  target_provider_qr_id text,
  target_qr_image_url text,
  target_provider_created_at timestamptz
)
returns table (qr_id uuid, provider_qr_id text, qr_image_url text, status text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_provider_qr_id is null or length(target_provider_qr_id) = 0 or length(target_provider_qr_id) > 128
     or target_qr_image_url is null or length(target_qr_image_url) = 0 or left(target_qr_image_url, 8) <> 'https://' then
    raise exception 'invalid provider qr attachment' using errcode = '22023';
  end if;

  return query
  update public.payment_order_qr_codes qr
     set provider_qr_id = target_provider_qr_id,
         qr_image_url = target_qr_image_url,
         provider_created_at = coalesce(target_provider_created_at, current_timestamp),
         provider_claim_token = null,
         provider_claim_until = null,
         status = 'provider_created',
         updated_at = current_timestamp
   where qr.id = target_qr_id
     and qr.status in ('provider_pending', 'provider_created')
     and (qr.status = 'provider_created' or qr.provider_claim_token = target_claim_token)
     and (qr.provider_qr_id is null or qr.provider_qr_id = target_provider_qr_id)
  returning qr.id, qr.provider_qr_id, qr.qr_image_url, qr.status;
end
$$;

alter table payment_order_qr_codes enable row level security;

create policy payment_order_qr_codes_member_select
  on payment_order_qr_codes for select to bsa_app
  using (app_private.can_access_channel(channel_id));

revoke execute on function app_private.get_eligible_payment_order_intent(uuid, uuid, text) from public;
revoke execute on function app_private.create_payment_order_qr(uuid, uuid, timestamptz) from public;
revoke execute on function app_private.claim_payment_order_qr(uuid, uuid, timestamptz) from public;
revoke execute on function app_private.attach_provider_qr(uuid, uuid, text, text, timestamptz) from public;
grant execute on function app_private.get_eligible_payment_order_intent(uuid, uuid, text) to bsa_payment;
grant execute on function app_private.create_payment_order_qr(uuid, uuid, timestamptz) to bsa_payment;
grant execute on function app_private.claim_payment_order_qr(uuid, uuid, timestamptz) to bsa_payment;
grant execute on function app_private.attach_provider_qr(uuid, uuid, text, text, timestamptz) to bsa_payment;

grant select on public.payment_order_qr_codes to bsa_app;
