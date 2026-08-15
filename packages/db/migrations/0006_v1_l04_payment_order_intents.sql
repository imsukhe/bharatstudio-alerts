-- BharatStudio Alerts v1 L04 payment order-intent boundary.
--
-- Depends on 0001 through 0005. This migration records the local intent and
-- provider-account context before an external Razorpay call. It does not
-- perform network I/O and it does not acknowledge a webhook.

create table payment_accounts (
  id uuid primary key,
  channel_id uuid not null references channels(id),
  provider text not null check (provider = 'razorpay'),
  environment text not null check (environment in ('test', 'live')),
  connected_account_ref text not null,
  status text not null check (status in ('pending', 'active', 'revoked')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revoked_at timestamptz,
  unique (channel_id, provider, environment),
  unique (provider, environment, connected_account_ref)
);

create table payment_order_intents (
  id uuid primary key,
  channel_id uuid not null references channels(id),
  payment_account_id uuid not null references payment_accounts(id),
  provider text not null check (provider = 'razorpay'),
  environment text not null check (environment in ('test', 'live')),
  connected_account_ref text not null,
  idempotency_key text not null,
  provider_receipt text not null,
  provider_order_id text,
  provider_claim_token uuid,
  provider_claim_until timestamptz,
  gross_amount_paise bigint not null check (gross_amount_paise >= 1000),
  currency text not null check (currency = 'INR'),
  donor_display_name text not null default '' check (char_length(donor_display_name) <= 80),
  donor_message text not null default '' check (char_length(donor_message) <= 500),
  alert_consent boolean not null default true,
  status text not null check (status in ('provider_pending', 'provider_created', 'paid', 'expired', 'failed')),
  provider_created_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint payment_order_intents_idempotency_unique
    unique (channel_id, environment, idempotency_key),
  constraint payment_order_intents_receipt_unique
    unique (provider, environment, connected_account_ref, provider_receipt),
  constraint payment_order_intents_provider_order_unique
    unique (provider, environment, connected_account_ref, provider_order_id)
);

create index payment_order_intents_reconciliation_idx
  on payment_order_intents (status, updated_at);

drop function if exists app_private.create_payment_order_intent(uuid, uuid, text, text, text, bigint, timestamptz);
drop function if exists app_private.create_payment_order_intent(uuid, uuid, text, text, text, bigint, text, text, timestamptz);
create or replace function app_private.create_payment_order_intent(
  target_id uuid,
  target_channel_id uuid,
  target_environment text,
  target_idempotency_key text,
  target_provider_receipt text,
  target_amount_paise bigint,
  target_display_name text,
  target_message text,
  target_alert_consent boolean,
  target_expires_at timestamptz
)
returns table (
  intent_id uuid,
  channel_id uuid,
  provider text,
  environment text,
  connected_account_ref text,
  provider_receipt text,
  provider_order_id text,
  amount_paise bigint,
  currency text,
  donor_display_name text,
  donor_message text,
  alert_consent boolean,
  status text,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  account payment_accounts%rowtype;
  intent payment_order_intents%rowtype;
begin
  if target_environment not in ('test', 'live')
     or target_idempotency_key is null
     or length(target_idempotency_key) = 0
     or length(target_idempotency_key) > 128
     or target_provider_receipt is null
     or length(target_provider_receipt) = 0
     or length(target_provider_receipt) > 40
     or target_amount_paise < 1000
     or char_length(coalesce(target_display_name, '')) > 80
     or char_length(coalesce(target_message, '')) > 500
     or target_alert_consent is null
     or target_expires_at <= current_timestamp then
    raise exception 'invalid payment order intent' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.channels channel
     where channel.id = target_channel_id
       and channel.closed_at is null
       and channel.accepting_tips
  ) then
    raise exception 'channel is not accepting tips' using errcode = '42501';
  end if;

  -- A retry for an already-created local intent must remain recoverable even
  -- if the account was revoked after the first request. It must not create a
  -- second intent or depend on the account still being active.
  select order_intent.*
    into intent
    from public.payment_order_intents order_intent
   where order_intent.channel_id = target_channel_id
     and order_intent.environment = target_environment
     and order_intent.idempotency_key = target_idempotency_key;

  if found then
    if intent.gross_amount_paise <> target_amount_paise
       or intent.currency <> 'INR'
       or intent.provider_receipt <> target_provider_receipt
       or intent.donor_display_name <> coalesce(target_display_name, '')
       or intent.donor_message <> coalesce(target_message, '')
       or intent.alert_consent is distinct from target_alert_consent then
      raise exception 'payment order idempotency key reused with different intent' using errcode = '23505';
    end if;
    return query select intent.id, intent.channel_id, intent.provider,
                        intent.environment, intent.connected_account_ref,
                        intent.provider_receipt, intent.provider_order_id,
                        intent.gross_amount_paise, intent.currency,
                        intent.donor_display_name, intent.donor_message,
                        intent.alert_consent,
                        intent.status,
                        intent.expires_at;
    return;
  end if;

  select payment_account.*
    into account
    from public.payment_accounts payment_account
   where payment_account.channel_id = target_channel_id
     and payment_account.provider = 'razorpay'
     and payment_account.environment = target_environment
     and payment_account.status = 'active'
     and payment_account.revoked_at is null
   limit 1;

  if not found then
    raise exception 'payment account not configured' using errcode = '23514';
  end if;

  insert into public.payment_order_intents (
    id, channel_id, payment_account_id, provider, environment,
    connected_account_ref, idempotency_key, provider_receipt,
    gross_amount_paise, currency, donor_display_name, donor_message, alert_consent,
    status, expires_at, created_at, updated_at
  )
  values (
    target_id, target_channel_id, account.id, account.provider, account.environment,
    account.connected_account_ref, target_idempotency_key, target_provider_receipt,
    target_amount_paise, 'INR', coalesce(target_display_name, ''), coalesce(target_message, ''),
    target_alert_consent,
    'provider_pending', target_expires_at,
    current_timestamp, current_timestamp
  )
  on conflict on constraint payment_order_intents_idempotency_unique do nothing;

  select order_intent.*
    into intent
    from public.payment_order_intents order_intent
   where order_intent.channel_id = target_channel_id
     and order_intent.environment = target_environment
     and order_intent.idempotency_key = target_idempotency_key;

  if intent.gross_amount_paise <> target_amount_paise
     or intent.currency <> 'INR'
     or intent.provider_receipt <> target_provider_receipt
     or intent.donor_display_name <> coalesce(target_display_name, '')
     or intent.donor_message <> coalesce(target_message, '')
     or intent.alert_consent is distinct from target_alert_consent then
    raise exception 'payment order idempotency key reused with different intent' using errcode = '23505';
  end if;

  return query select intent.id, intent.channel_id, intent.provider,
                      intent.environment, intent.connected_account_ref,
                      intent.provider_receipt, intent.provider_order_id,
                      intent.gross_amount_paise, intent.currency,
                      intent.donor_display_name, intent.donor_message,
                      intent.alert_consent,
                      intent.status,
                      intent.expires_at;
end
$$;

create or replace function app_private.claim_payment_order_intent(
  target_intent_id uuid,
  target_claim_token uuid,
  target_claim_until timestamptz
)
returns table (intent_id uuid, amount_paise bigint, currency text, provider_receipt text, claim_token uuid, claim_until timestamptz)
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  update public.payment_order_intents intent
     set provider_claim_token = target_claim_token,
         provider_claim_until = target_claim_until,
         updated_at = current_timestamp
   where intent.id = target_intent_id
     and intent.status = 'provider_pending'
     and intent.provider_order_id is null
     and (intent.provider_claim_until is null or intent.provider_claim_until <= current_timestamp)
     and target_claim_token is not null
     and target_claim_until > current_timestamp
  returning intent.id, intent.gross_amount_paise, intent.currency,
            intent.provider_receipt, intent.provider_claim_token,
            intent.provider_claim_until
$$;

drop function if exists app_private.attach_provider_order(uuid, text, timestamptz);
create or replace function app_private.attach_provider_order(
  target_intent_id uuid,
  target_claim_token uuid,
  target_provider_order_id text,
  target_provider_created_at timestamptz
)
returns table (intent_id uuid, provider_order_id text, status text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_provider_order_id is null
     or length(target_provider_order_id) = 0
     or length(target_provider_order_id) > 128 then
    raise exception 'invalid provider order id' using errcode = '22023';
  end if;

  return query
  update public.payment_order_intents intent
     set provider_order_id = target_provider_order_id,
         provider_created_at = coalesce(target_provider_created_at, current_timestamp),
         provider_claim_token = null,
         provider_claim_until = null,
         status = case
                    when intent.status = 'paid' then 'paid'
                    else 'provider_created'
                  end,
         updated_at = current_timestamp
   where intent.id = target_intent_id
     and intent.status in ('provider_pending', 'provider_created', 'paid')
     and (intent.status in ('provider_created', 'paid') or intent.provider_claim_token = target_claim_token)
     and (intent.provider_order_id is null or intent.provider_order_id = target_provider_order_id)
  returning intent.id, intent.provider_order_id, intent.status;
end
$$;

alter table payment_accounts enable row level security;
alter table payment_order_intents enable row level security;

create policy payment_accounts_member_select
  on payment_accounts for select to bsa_app
  using (app_private.can_access_channel(channel_id));

create policy payment_order_intents_member_select
  on payment_order_intents for select to bsa_app
  using (app_private.can_access_channel(channel_id));

revoke execute on function app_private.create_payment_order_intent(uuid, uuid, text, text, text, bigint, text, text, boolean, timestamptz) from public;
revoke execute on function app_private.claim_payment_order_intent(uuid, uuid, timestamptz) from public;
revoke execute on function app_private.attach_provider_order(uuid, uuid, text, timestamptz) from public;
grant execute on function app_private.create_payment_order_intent(uuid, uuid, text, text, text, bigint, text, text, boolean, timestamptz) to bsa_app;
grant execute on function app_private.create_payment_order_intent(uuid, uuid, text, text, text, bigint, text, text, boolean, timestamptz) to bsa_payment;
grant execute on function app_private.claim_payment_order_intent(uuid, uuid, timestamptz) to bsa_payment;
grant execute on function app_private.attach_provider_order(uuid, uuid, text, timestamptz) to bsa_payment;

grant select on public.payment_accounts, public.payment_order_intents to bsa_app;
grant usage on schema app_private to bsa_payment;
