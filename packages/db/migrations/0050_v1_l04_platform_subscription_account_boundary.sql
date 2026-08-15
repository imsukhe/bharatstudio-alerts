-- L04 platform-plan subscription account boundary.
--
-- payment_accounts is intentionally channel-scoped and represents creator
-- connected accounts used for tip settlement. BharatStudio plan subscriptions
-- are platform revenue and must not require a creator to connect a tipping
-- account. Keep the two account scopes explicit at the subscription-link
-- boundary.

create table if not exists public.platform_payment_accounts (
  provider text not null check (provider = 'razorpay'),
  environment text not null check (environment in ('test', 'live')),
  provider_account_ref text not null,
  status text not null check (status in ('active', 'revoked')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revoked_at timestamptz,
  primary key (provider, environment, provider_account_ref)
);

alter table public.platform_payment_accounts enable row level security;
revoke all on public.platform_payment_accounts from public;
revoke all on public.platform_payment_accounts from bsa_app;
revoke all on public.platform_payment_accounts from bsa_payment;
grant select on public.platform_payment_accounts to bsa_payment;

alter table public.channel_subscription_links
  add column if not exists provider_account_scope text not null default 'connected';

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.channel_subscription_links'::regclass
       and conname = 'channel_subscription_links_account_scope_check'
  ) then
    alter table public.channel_subscription_links
      add constraint channel_subscription_links_account_scope_check
      check (provider_account_scope in ('platform', 'connected'));
  end if;
end
$$;

-- New callers must state whether the provider account is the platform account
-- or a creator-connected account. The earlier eight-argument function remains
-- available for existing connected-account callers and defaults to connected.
create or replace function app_private.register_channel_subscription_link(
  target_channel_id uuid,
  target_environment text,
  target_provider_account_scope text,
  target_provider_account_ref text,
  target_provider_subscription_id text,
  target_provider_plan_id text,
  target_tier text,
  target_billing_interval text,
  target_price_paise bigint
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.channel_subscription_links%rowtype;
begin
  if target_channel_id is null
     or target_environment not in ('test', 'live')
     or target_provider_account_scope not in ('platform', 'connected')
     or target_provider_account_ref !~ '^[A-Za-z0-9_-]{1,128}$'
     or target_provider_subscription_id !~ '^[A-Za-z0-9_-]{1,128}$'
     or target_provider_plan_id !~ '^[A-Za-z0-9_-]{1,128}$'
     or target_tier not in ('pro', 'creator', 'studio')
     or target_billing_interval not in ('monthly', 'annual')
     or target_price_paise <> (case target_tier
       when 'pro' then 19900
       when 'creator' then 39900
       when 'studio' then 49900
     end) then
    raise exception 'invalid subscription link' using errcode = '22023';
  end if;

  perform 1 from public.channels where id = target_channel_id for update;
  if not found then
    raise exception 'channel not found for subscription link' using errcode = '23503';
  end if;

  if target_provider_account_scope = 'connected' then
    if not exists (
      select 1
        from public.payment_accounts account
       where account.channel_id = target_channel_id
         and account.provider = 'razorpay'
         and account.environment = target_environment
         and account.connected_account_ref = target_provider_account_ref
         and account.status = 'active'
    ) then
      raise exception 'active connected payment account required for subscription link' using errcode = '42501';
    end if;
  elsif not exists (
    select 1
      from public.platform_payment_accounts account
     where account.provider = 'razorpay'
       and account.environment = target_environment
       and account.provider_account_ref = target_provider_account_ref
       and account.status = 'active'
  ) then
    raise exception 'active platform payment account required for subscription link' using errcode = '42501';
  end if;

  select link.* into existing
    from public.channel_subscription_links link
   where link.provider = 'razorpay'
     and link.environment = target_environment
     and link.provider_account_ref = target_provider_account_ref
     and link.provider_subscription_id = target_provider_subscription_id
   for update;

  if found then
    if existing.channel_id <> target_channel_id
       or existing.provider_account_scope <> target_provider_account_scope
       or existing.provider_plan_id <> target_provider_plan_id
       or existing.tier <> target_tier
       or existing.billing_interval <> target_billing_interval
       or existing.recurring_price_paise <> target_price_paise then
      raise exception 'subscription link identity or plan mismatch' using errcode = '23514';
    end if;
    return 'existing';
  end if;

  insert into public.channel_subscription_links (
    channel_id, provider, environment, provider_account_scope,
    provider_account_ref, provider_subscription_id, provider_plan_id, tier,
    billing_interval, recurring_price_paise, created_at, updated_at
  ) values (
    target_channel_id, 'razorpay', target_environment, target_provider_account_scope,
    target_provider_account_ref, target_provider_subscription_id, target_provider_plan_id,
    target_tier, target_billing_interval, target_price_paise,
    current_timestamp, current_timestamp
  );
  return 'created';
end
$$;

revoke execute on function app_private.register_channel_subscription_link(uuid, text, text, text, text, text, text, text, bigint) from public;
grant execute on function app_private.register_channel_subscription_link(uuid, text, text, text, text, text, text, text, bigint) to bsa_payment;
