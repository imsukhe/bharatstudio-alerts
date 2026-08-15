-- L04 platform-plan billing projection and price-protection boundary.
--
-- This migration stores the server-authoritative subscription price and
-- lifecycle facts needed by the approved v1 pricing rule. It does not create
-- a Razorpay subscription, call a provider, or infer provider dunning.

create table public.channel_subscriptions (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  provider text not null check (provider = 'razorpay'),
  environment text not null check (environment in ('test', 'live')),
  provider_account_ref text not null,
  provider_subscription_id text not null,
  tier text not null check (tier in ('pro', 'creator', 'studio')),
  billing_interval text not null check (billing_interval in ('monthly', 'annual')),
  charged_months smallint not null check (charged_months in (1, 10)),
  service_months smallint not null check (service_months in (1, 12)),
  recurring_price_paise bigint not null check (recurring_price_paise in (19900, 39900, 49900)),
  price_source text not null check (price_source in ('current', 'grandfathered')),
  status text not null check (status in ('active', 'past_due', 'cancelled')),
  auto_renew boolean not null,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  next_renewal_at timestamptz,
  price_protected_until timestamptz,
  grace_until timestamptz,
  cancelled_at timestamptz,
  last_provider_event_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (provider, environment, provider_subscription_id),
  check (current_period_end > current_period_start),
  check (billing_interval = 'monthly' and charged_months = 1 and service_months = 1
      or billing_interval = 'annual' and charged_months = 10 and service_months = 12),
  check (grace_until is null or grace_until >= current_period_end)
);

create index channel_subscriptions_channel_state_idx
  on public.channel_subscriptions (channel_id, status, updated_at desc);

alter table public.channel_subscriptions enable row level security;
revoke all on public.channel_subscriptions from public;
revoke all on public.channel_subscriptions from bsa_app;
revoke all on public.channel_subscriptions from bsa_payment;
grant select on public.channel_subscriptions to bsa_app;
grant select, insert, update on public.channel_subscriptions to bsa_payment;

create policy channel_subscription_member_select
  on public.channel_subscriptions for select to bsa_app
  using (app_private.can_access_channel(channel_id));

-- Active provider state is also the only place where an individual paid plan
-- may publish a new entitlement version. Cancellation and dunning are not
-- inferred here: their access transition must be applied by the approved
-- provider-reconciliation path once its calendar/rule evidence exists.
create or replace function app_private.publish_active_individual_entitlement(
  target_channel_id uuid,
  target_tier text,
  target_subscription_id text,
  target_billing_interval text,
  target_price_paise bigint,
  target_effective_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  latest public.channel_entitlement_versions%rowtype;
  next_version bigint;
begin
  if target_tier not in ('pro', 'creator', 'studio')
     or target_billing_interval not in ('monthly', 'annual')
     or target_subscription_id is null
     or target_subscription_id = ''
     or target_effective_at is null then
    raise exception 'invalid active entitlement projection' using errcode = '22023';
  end if;

  -- Serialize version allocation per channel. Different provider
  -- subscriptions for the same channel may be observed concurrently during
  -- retries/reconciliation; MAX(version)+1 must not race into a duplicate
  -- primary-key value or publish an ambiguous entitlement order.
  perform 1
    from public.channels
   where id = target_channel_id
   for update;
  if not found then
    raise exception 'channel not found for active entitlement projection' using errcode = '23503';
  end if;

  -- Re-read after taking the channel lock. This makes the idempotency check
  -- linearizable with version allocation: concurrent retries for the same
  -- subscription cannot both decide that the latest version is different.
  select entitlement.* into latest
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id
   order by entitlement.version desc
   limit 1;

  if found
     and latest.tier = target_tier
     and latest.values ->> 'subscriptionId' = target_subscription_id then
    return;
  end if;

  select coalesce(max(entitlement.version), 0) + 1
    into next_version
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id;

  insert into public.channel_entitlement_versions (
    channel_id, version, tier, source, values, effective_at, created_at
  ) values (
    target_channel_id, next_version, target_tier, 'individual_plan',
    coalesce(latest.values, '{}'::jsonb) || jsonb_build_object(
      'subscriptionId', target_subscription_id,
      'billingInterval', target_billing_interval,
      'monthlyPricePaise', target_price_paise
    ),
    target_effective_at, current_timestamp
  );
end
$$;

-- Billing state is provider-owned and must not be writable by the request
-- role. The payment service calls this function only after signature
-- verification and event-id persistence; provider integration is a later
-- deployment gate.
create or replace function app_private.apply_channel_subscription_state(
  target_channel_id uuid,
  target_environment text,
  target_provider_account_ref text,
  target_provider_subscription_id text,
  target_tier text,
  target_billing_interval text,
  target_price_paise bigint,
  target_status text,
  target_auto_renew boolean,
  target_period_start timestamptz,
  target_period_end timestamptz,
  target_next_renewal_at timestamptz,
  target_event_at timestamptz
)
returns table (
  result text,
  subscription_id uuid,
  channel_id uuid,
  tier text,
  status text,
  recurring_price_paise bigint,
  price_source text,
  price_protected_until timestamptz,
  grace_until timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_row public.channel_subscriptions%rowtype;
  previous_cancelled boolean;
  new_id uuid;
  next_protection timestamptz;
  next_grace timestamptz;
  next_price_source text;
begin
  if target_environment not in ('test', 'live')
     or target_tier not in ('pro', 'creator', 'studio')
     or target_billing_interval not in ('monthly', 'annual')
     or target_status not in ('active', 'past_due', 'cancelled')
     or target_provider_account_ref = ''
     or target_provider_subscription_id = ''
     or target_event_at is null
     or target_period_end <= target_period_start then
    raise exception 'invalid subscription state' using errcode = '22023';
  end if;

  -- target_price_paise is the approved monthly-equivalent tier price. The
  -- annual plan charges ten such months for twelve months of service, but
  -- the stored price remains the server-authoritative tier price used for
  -- grandfathered renewal display and reconciliation.
  if target_price_paise <> (case target_tier
      when 'pro' then 19900
      when 'creator' then 39900
      when 'studio' then 49900
    end) then
    raise exception 'subscription price does not match approved tier' using errcode = '22023';
  end if;

  select * into current_row
    from public.channel_subscriptions
   where provider = 'razorpay'
     and environment = target_environment
     and provider_subscription_id = target_provider_subscription_id
   for update;

  -- Equal timestamps are a replay of the same provider state for this
  -- projection. The provider-event ledger remains the primary dedupe key;
  -- this boundary is idempotent even when called directly or retried.
  if found and target_event_at <= current_row.last_provider_event_at then
    return query select
      'stale'::text, current_row.id, current_row.channel_id, current_row.tier,
      current_row.status, current_row.recurring_price_paise,
      current_row.price_source, current_row.price_protected_until,
      current_row.grace_until;
    return;
  end if;

  if found then
    if current_row.channel_id <> target_channel_id
       or current_row.provider_account_ref <> target_provider_account_ref then
      raise exception 'subscription channel/account mismatch' using errcode = '23514';
    end if;
    if current_row.recurring_price_paise <> target_price_paise
       or current_row.tier <> target_tier
       or current_row.billing_interval <> target_billing_interval then
      raise exception 'subscription price or plan changed without a new subscription' using errcode = '23514';
    end if;

    next_protection := current_row.price_protected_until;
    next_grace := current_row.grace_until;
    next_price_source := current_row.price_source;
    if target_status = 'past_due' then
      next_grace := greatest(coalesce(next_grace, target_period_end + interval '30 days'), target_period_end + interval '30 days');
    elsif target_status = 'cancelled' then
      next_protection := least(coalesce(next_protection, target_event_at), target_event_at);
      next_grace := null;
    elsif target_status = 'active' then
      next_grace := null;
    end if;

    update public.channel_subscriptions
       set status = target_status,
           auto_renew = target_auto_renew,
           current_period_start = target_period_start,
           current_period_end = target_period_end,
           next_renewal_at = target_next_renewal_at,
           price_protected_until = next_protection,
           grace_until = next_grace,
           cancelled_at = case when target_status = 'cancelled' then coalesce(cancelled_at, target_event_at) else cancelled_at end,
           last_provider_event_at = target_event_at,
           updated_at = current_timestamp
     where id = current_row.id
     returning * into current_row;

    if target_status = 'active' then
      perform app_private.publish_active_individual_entitlement(
        current_row.channel_id, current_row.tier, current_row.provider_subscription_id,
        current_row.billing_interval, current_row.recurring_price_paise,
        current_row.current_period_start
      );
    end if;

    return query select
      'updated'::text, current_row.id, current_row.channel_id, current_row.tier,
      current_row.status, current_row.recurring_price_paise,
      current_row.price_source, current_row.price_protected_until,
      current_row.grace_until;
    return;
  end if;

  select exists (
    select 1 from public.channel_subscriptions prior
     where prior.channel_id = target_channel_id
       and prior.status = 'cancelled'
  ) into previous_cancelled;
  next_price_source := case when previous_cancelled or target_status = 'cancelled' then 'current' else 'grandfathered' end;
  next_protection := case when previous_cancelled or target_status = 'cancelled' then null else target_period_start + interval '12 months' end;
  next_grace := case when target_status = 'past_due' then target_period_end + interval '30 days' else null end;
  new_id := md5('subscription:' || target_environment || ':' || target_provider_subscription_id)::uuid;

  insert into public.channel_subscriptions (
    id, channel_id, provider, environment, provider_account_ref,
    provider_subscription_id, tier, billing_interval, charged_months,
    service_months, recurring_price_paise, price_source, status, auto_renew,
    current_period_start, current_period_end, next_renewal_at,
    price_protected_until, grace_until, cancelled_at, last_provider_event_at,
    created_at, updated_at
  ) values (
    new_id, target_channel_id, 'razorpay', target_environment,
    target_provider_account_ref, target_provider_subscription_id, target_tier,
    target_billing_interval,
    case when target_billing_interval = 'annual' then 10 else 1 end,
    case when target_billing_interval = 'annual' then 12 else 1 end,
    target_price_paise, next_price_source, target_status, target_auto_renew,
    target_period_start, target_period_end, target_next_renewal_at,
    next_protection, next_grace,
    case when target_status = 'cancelled' then target_event_at else null end,
    target_event_at, current_timestamp, current_timestamp
  ) returning * into current_row;

  if target_status = 'active' then
    perform app_private.publish_active_individual_entitlement(
      current_row.channel_id, current_row.tier, current_row.provider_subscription_id,
      current_row.billing_interval, current_row.recurring_price_paise,
      current_row.current_period_start
    );
  end if;

  return query select
    'created'::text, current_row.id, current_row.channel_id, current_row.tier,
    current_row.status, current_row.recurring_price_paise,
    current_row.price_source, current_row.price_protected_until,
    current_row.grace_until;
end
$$;

create or replace function app_private.get_billing_view(target_channel_id uuid)
returns table (
  channel_id uuid,
  tier text,
  monthly_price_paise bigint,
  annual_months_charged integer,
  annual_service_months integer,
  renewal_state text,
  next_renewal_at timestamptz,
  billing_interval text,
  auto_renew boolean,
  current_period_ends_at timestamptz,
  price_protected_until timestamptz,
  price_source text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with latest as (
    select subscription.*
     from public.channel_subscriptions subscription
     where subscription.channel_id = target_channel_id
     order by case when subscription.status in ('active', 'past_due') then 0 else 1 end,
              subscription.current_period_end desc,
              subscription.updated_at desc,
              subscription.id desc
     limit 1
  )
  select target_channel_id,
         coalesce(latest.tier, 'free'),
         coalesce(latest.recurring_price_paise, 0),
         coalesce(latest.charged_months, 10),
         coalesce(latest.service_months, 12),
         coalesce(latest.status, 'not_applicable'),
         latest.next_renewal_at,
         coalesce(latest.billing_interval, 'monthly'),
         coalesce(latest.auto_renew, false),
         latest.current_period_end,
         latest.price_protected_until,
         coalesce(latest.price_source, 'current')
    from (select 1) base
    left join latest on true
   where app_private.can_access_channel(target_channel_id)
$$;

revoke execute on function app_private.apply_channel_subscription_state(uuid, text, text, text, text, text, bigint, text, boolean, timestamptz, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function app_private.get_billing_view(uuid) from public;
revoke execute on function app_private.publish_active_individual_entitlement(uuid, text, text, text, bigint, timestamptz) from public;
grant execute on function app_private.apply_channel_subscription_state(uuid, text, text, text, text, text, bigint, text, boolean, timestamptz, timestamptz, timestamptz, timestamptz) to bsa_payment;
grant execute on function app_private.get_billing_view(uuid) to bsa_app;
grant execute on function app_private.publish_active_individual_entitlement(uuid, text, text, text, bigint, timestamptz) to bsa_payment;
