-- BharatStudio Alerts v1 local checkout lifetime hardening.
--
-- Razorpay checkout expiry is controlled by the browser checkout timeout. The
-- provider order itself must not receive an unsupported `expire_by` field.
-- This database boundary prevents any internal caller from creating a local
-- intent that remains open longer than the approved fifteen-minute window.

alter table public.payment_order_intents
  drop constraint if exists payment_order_intents_expiry_cap;

alter table public.payment_order_intents
  add constraint payment_order_intents_expiry_cap
  check (expires_at <= created_at + interval '15 minutes');

-- Keep the check inside the security-definer write path as well so callers get
-- a stable validation error before an insert constraint violation.
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
     or target_expires_at <= current_timestamp
     or target_expires_at > current_timestamp + interval '15 minutes' then
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

  select order_intent.* into intent
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
                        intent.alert_consent, intent.status, intent.expires_at;
    return;
  end if;

  select payment_account.* into account
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
    target_alert_consent, 'provider_pending', target_expires_at,
    current_timestamp, current_timestamp
  )
  on conflict on constraint payment_order_intents_idempotency_unique do nothing;

  select order_intent.* into intent
    from public.payment_order_intents order_intent
   where order_intent.channel_id = target_channel_id
     and order_intent.environment = target_environment
     and order_intent.idempotency_key = target_idempotency_key;

  return query select intent.id, intent.channel_id, intent.provider,
                      intent.environment, intent.connected_account_ref,
                      intent.provider_receipt, intent.provider_order_id,
                      intent.gross_amount_paise, intent.currency,
                      intent.donor_display_name, intent.donor_message,
                      intent.alert_consent, intent.status, intent.expires_at;
end
$$;

revoke execute on function app_private.create_payment_order_intent(uuid, uuid, text, text, text, bigint, text, text, boolean, timestamptz) from public;
grant execute on function app_private.create_payment_order_intent(uuid, uuid, text, text, text, bigint, text, text, boolean, timestamptz) to bsa_app;
grant execute on function app_private.create_payment_order_intent(uuid, uuid, text, text, text, bigint, text, text, boolean, timestamptz) to bsa_payment;
