-- L04 paid-plan subscription creation intent boundary.
--
-- A provider subscription is never created from a browser-selected plan or
-- account. The payment service records the approved immutable request first,
-- claims provider I/O once, attaches the validated provider identity, and
-- registers the link that authorizes later signed webhooks.

create table public.subscription_creation_intents (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  user_id uuid not null references public.app_users(id),
  provider text not null check (provider = 'razorpay'),
  environment text not null check (environment in ('test', 'live')),
  idempotency_key text not null,
  provider_account_scope text not null check (provider_account_scope in ('platform', 'connected')),
  provider_account_ref text not null,
  provider_plan_id text not null,
  tier text not null check (tier in ('pro', 'creator', 'studio')),
  billing_interval text not null check (billing_interval in ('monthly', 'annual')),
  recurring_price_paise bigint not null check (recurring_price_paise in (19900, 39900, 49900)),
  provider_subscription_id text,
  provider_status text,
  checkout_url text,
  provider_claim_token uuid,
  provider_claim_until timestamptz,
  status text not null check (status in ('requested', 'provider_pending', 'provider_created', 'linked', 'recovery_required', 'quarantined', 'cancelled')),
  last_error_code text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  provider_created_at timestamptz,
  linked_at timestamptz,
  constraint subscription_creation_intents_idempotency_unique
    unique (channel_id, environment, idempotency_key),
  constraint subscription_creation_intents_provider_unique
    unique (provider, environment, provider_account_ref, provider_subscription_id),
  constraint subscription_creation_intents_idempotency_format
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  constraint subscription_creation_intents_account_format
    check (provider_account_ref ~ '^[A-Za-z0-9_-]{1,128}$'),
  constraint subscription_creation_intents_plan_format
    check (provider_plan_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  constraint subscription_creation_intents_subscription_format
    check (provider_subscription_id is null or provider_subscription_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  constraint subscription_creation_intents_price_tier
    check (recurring_price_paise = case tier when 'pro' then 19900 when 'creator' then 39900 when 'studio' then 49900 end),
  constraint subscription_creation_intents_checkout_url_format
    check (checkout_url is null or checkout_url ~ '^https://')
);

alter table public.subscription_creation_intents enable row level security;
revoke all on public.subscription_creation_intents from public;
revoke all on public.subscription_creation_intents from bsa_app;
revoke all on public.subscription_creation_intents from bsa_payment;
grant select on public.subscription_creation_intents to bsa_payment;

create index subscription_creation_intents_recovery_idx
  on public.subscription_creation_intents (status, updated_at);

create or replace function app_private.create_subscription_creation_intent(
  target_id uuid,
  target_user_id uuid,
  target_channel_id uuid,
  target_environment text,
  target_idempotency_key text,
  target_provider_account_scope text,
  target_provider_account_ref text,
  target_provider_plan_id text,
  target_tier text,
  target_billing_interval text,
  target_price_paise bigint
)
returns setof public.subscription_creation_intents
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.subscription_creation_intents%rowtype;
begin
  if target_id is null
     or target_user_id is null
     or target_channel_id is null
     or target_environment not in ('test', 'live')
     or target_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     or target_provider_account_scope not in ('platform', 'connected')
     or target_provider_account_ref !~ '^[A-Za-z0-9_-]{1,128}$'
     or target_provider_plan_id !~ '^[A-Za-z0-9_-]{1,128}$'
     or target_tier not in ('pro', 'creator', 'studio')
     or target_billing_interval not in ('monthly', 'annual')
     or target_price_paise <> (case target_tier
       when 'pro' then 19900
       when 'creator' then 39900
       when 'studio' then 49900
     end) then
    raise exception 'invalid subscription creation intent' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.channel_memberships membership
     where membership.channel_id = target_channel_id
       and membership.user_id = target_user_id
       and membership.role in ('owner', 'admin')
       and membership.revoked_at is null
  ) then
    raise exception 'subscription channel access denied' using errcode = '42501';
  end if;

  perform 1 from public.channels where id = target_channel_id for update;
  if not found then
    raise exception 'subscription channel not found' using errcode = '23503';
  end if;

  if target_provider_account_scope = 'platform' then
    if not exists (
      select 1
        from public.platform_payment_accounts account
       where account.provider = 'razorpay'
         and account.environment = target_environment
         and account.provider_account_ref = target_provider_account_ref
         and account.status = 'active'
    ) then
      raise exception 'active platform payment account required' using errcode = '42501';
    end if;
  elsif not exists (
    select 1
      from public.payment_accounts account
     where account.channel_id = target_channel_id
       and account.provider = 'razorpay'
       and account.environment = target_environment
       and account.connected_account_ref = target_provider_account_ref
       and account.status = 'active'
  ) then
    raise exception 'active connected payment account required' using errcode = '42501';
  end if;

  select intent.*
    into existing
    from public.subscription_creation_intents intent
   where intent.channel_id = target_channel_id
     and intent.environment = target_environment
     and intent.idempotency_key = target_idempotency_key
   for update;

  if found then
    if existing.provider_account_scope <> target_provider_account_scope
       or existing.provider_account_ref <> target_provider_account_ref
       or existing.provider_plan_id <> target_provider_plan_id
       or existing.tier <> target_tier
       or existing.billing_interval <> target_billing_interval
       or existing.recurring_price_paise <> target_price_paise then
      raise exception 'subscription intent idempotency mismatch' using errcode = '23514';
    end if;
    return next existing;
    return;
  end if;

  insert into public.subscription_creation_intents (
    id, channel_id, user_id, provider, environment, idempotency_key,
    provider_account_scope, provider_account_ref, provider_plan_id, tier,
    billing_interval, recurring_price_paise, status, created_at, updated_at
  ) values (
    target_id, target_channel_id, target_user_id, 'razorpay', target_environment,
    target_idempotency_key, target_provider_account_scope, target_provider_account_ref,
    target_provider_plan_id, target_tier, target_billing_interval, target_price_paise,
    'requested', current_timestamp, current_timestamp
  )
  returning * into existing;

  return next existing;
end
$$;

create or replace function app_private.claim_subscription_provider_creation(
  target_intent_id uuid,
  target_claim_token uuid,
  target_claim_until timestamptz
)
returns setof public.subscription_creation_intents
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.subscription_creation_intents%rowtype;
begin
  if target_intent_id is null or target_claim_token is null or target_claim_until <= current_timestamp then
    raise exception 'invalid subscription provider claim' using errcode = '22023';
  end if;

  select intent.* into existing
    from public.subscription_creation_intents intent
   where intent.id = target_intent_id
   for update;
  if not found then
    return;
  end if;

  -- Only an intent that has never reached provider I/O may be claimed. A
  -- timeout after provider creation is ambiguous and must be repaired or
  -- reconciled, never blindly recreated.
  if existing.status <> 'requested' or existing.provider_subscription_id is not null then
    return next existing;
    return;
  end if;

  update public.subscription_creation_intents
     set status = 'provider_pending',
         provider_claim_token = target_claim_token,
         provider_claim_until = target_claim_until,
         updated_at = current_timestamp
   where id = target_intent_id
  returning * into existing;
  return next existing;
end
$$;

create or replace function app_private.attach_subscription_provider(
  target_intent_id uuid,
  target_claim_token uuid,
  target_provider_subscription_id text,
  target_provider_status text,
  target_checkout_url text,
  target_provider_created_at timestamptz
)
returns setof public.subscription_creation_intents
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.subscription_creation_intents%rowtype;
begin
  if target_intent_id is null
     or target_claim_token is null
     or target_provider_subscription_id !~ '^[A-Za-z0-9_-]{1,128}$'
     or target_provider_status is null
     or target_provider_status = ''
     or target_checkout_url is not null and target_checkout_url !~ '^https://'
     or target_provider_created_at is null then
    raise exception 'invalid subscription provider attachment' using errcode = '22023';
  end if;

  select intent.* into existing
    from public.subscription_creation_intents intent
   where intent.id = target_intent_id
   for update;
  if not found then
    raise exception 'subscription creation intent not found' using errcode = '23503';
  end if;

  if existing.provider_subscription_id is not null then
    if existing.provider_subscription_id <> target_provider_subscription_id then
      raise exception 'subscription provider identity mismatch' using errcode = '23514';
    end if;
    return next existing;
    return;
  end if;

  if existing.status <> 'provider_pending' or existing.provider_claim_token <> target_claim_token then
    raise exception 'subscription provider claim is stale' using errcode = '40001';
  end if;

  update public.subscription_creation_intents
     set provider_subscription_id = target_provider_subscription_id,
         provider_status = target_provider_status,
         checkout_url = target_checkout_url,
         status = 'provider_created',
         provider_claim_token = null,
         provider_claim_until = null,
         provider_created_at = target_provider_created_at,
         updated_at = current_timestamp
   where id = target_intent_id
  returning * into existing;
  return next existing;
end
$$;

create or replace function app_private.link_subscription_creation_intent(
  target_intent_id uuid
)
returns setof public.subscription_creation_intents
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.subscription_creation_intents%rowtype;
begin
  select intent.* into existing
    from public.subscription_creation_intents intent
   where intent.id = target_intent_id
   for update;
  if not found then
    raise exception 'subscription creation intent not found' using errcode = '23503';
  end if;

  if existing.status = 'linked' then
    return next existing;
    return;
  end if;
  if existing.provider_subscription_id is null
     or existing.status not in ('provider_created', 'recovery_required') then
    raise exception 'subscription provider identity is not ready' using errcode = '40001';
  end if;

  perform app_private.register_channel_subscription_link(
    existing.channel_id, existing.environment, existing.provider_account_scope,
    existing.provider_account_ref, existing.provider_subscription_id,
    existing.provider_plan_id, existing.tier, existing.billing_interval,
    existing.recurring_price_paise
  );

  update public.subscription_creation_intents
     set status = 'linked', linked_at = coalesce(linked_at, current_timestamp),
         last_error_code = null, updated_at = current_timestamp
   where id = target_intent_id
  returning * into existing;
  return next existing;
end
$$;

create or replace function app_private.mark_subscription_creation_recovery(
  target_intent_id uuid,
  target_error_code text
)
returns setof public.subscription_creation_intents
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.subscription_creation_intents%rowtype;
begin
  if target_error_code is null or target_error_code !~ '^[a-z0-9_:-]{1,64}$' then
    raise exception 'invalid subscription recovery code' using errcode = '22023';
  end if;
  update public.subscription_creation_intents
     set status = case when provider_subscription_id is null then 'recovery_required' else 'provider_created' end,
         provider_claim_token = null,
         provider_claim_until = null,
         last_error_code = target_error_code,
         updated_at = current_timestamp
   where id = target_intent_id
  returning * into existing;
  if not found then
    raise exception 'subscription creation intent not found' using errcode = '23503';
  end if;
  return next existing;
end
$$;

revoke execute on function app_private.create_subscription_creation_intent(uuid, uuid, uuid, text, text, text, text, text, text, text, bigint) from public;
revoke execute on function app_private.claim_subscription_provider_creation(uuid, uuid, timestamptz) from public;
revoke execute on function app_private.attach_subscription_provider(uuid, uuid, text, text, text, timestamptz) from public;
revoke execute on function app_private.link_subscription_creation_intent(uuid) from public;
revoke execute on function app_private.mark_subscription_creation_recovery(uuid, text) from public;
grant execute on function app_private.create_subscription_creation_intent(uuid, uuid, uuid, text, text, text, text, text, text, text, bigint) to bsa_payment;
grant execute on function app_private.claim_subscription_provider_creation(uuid, uuid, timestamptz) to bsa_payment;
grant execute on function app_private.attach_subscription_provider(uuid, uuid, text, text, text, timestamptz) to bsa_payment;
grant execute on function app_private.link_subscription_creation_intent(uuid) to bsa_payment;
grant execute on function app_private.mark_subscription_creation_recovery(uuid, text) to bsa_payment;
