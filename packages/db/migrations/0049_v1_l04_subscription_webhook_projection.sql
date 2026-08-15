-- L04 subscription webhook projection boundary.
--
-- A provider subscription must be linked to a channel and an approved local
-- plan before a signed webhook can change billing state. This prevents a
-- provider-supplied subscription ID/plan from selecting a tenant or tier.

create table public.channel_subscription_links (
  channel_id uuid not null references public.channels(id),
  provider text not null check (provider = 'razorpay'),
  environment text not null check (environment in ('test', 'live')),
  provider_account_ref text not null,
  provider_subscription_id text not null,
  provider_plan_id text not null,
  tier text not null check (tier in ('pro', 'creator', 'studio')),
  billing_interval text not null check (billing_interval in ('monthly', 'annual')),
  recurring_price_paise bigint not null check (recurring_price_paise in (19900, 39900, 49900)),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (provider, environment, provider_account_ref, provider_subscription_id),
  unique (channel_id, provider, environment, provider_subscription_id),
  check (
    (billing_interval = 'monthly' and recurring_price_paise in (19900, 39900, 49900))
    or (billing_interval = 'annual' and recurring_price_paise in (19900, 39900, 49900))
  )
);

alter table public.channel_subscription_links enable row level security;
revoke all on public.channel_subscription_links from public;
revoke all on public.channel_subscription_links from bsa_app;
revoke all on public.channel_subscription_links from bsa_payment;
grant select on public.channel_subscription_links to bsa_payment;

create or replace function app_private.register_channel_subscription_link(
  target_channel_id uuid,
  target_environment text,
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
     or target_provider_account_ref = ''
     or target_provider_subscription_id = ''
     or target_provider_plan_id = ''
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
  if not exists (
    select 1
      from public.payment_accounts account
     where account.channel_id = target_channel_id
       and account.provider = 'razorpay'
       and account.environment = target_environment
       and account.connected_account_ref = target_provider_account_ref
       and account.status = 'active'
  ) then
    raise exception 'active payment account required for subscription link' using errcode = '42501';
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
       or existing.provider_plan_id <> target_provider_plan_id
       or existing.tier <> target_tier
       or existing.billing_interval <> target_billing_interval
       or existing.recurring_price_paise <> target_price_paise then
      raise exception 'subscription link identity or plan mismatch' using errcode = '23514';
    end if;
    return 'existing';
  end if;

  insert into public.channel_subscription_links (
    channel_id, provider, environment, provider_account_ref,
    provider_subscription_id, provider_plan_id, tier, billing_interval,
    recurring_price_paise, created_at, updated_at
  ) values (
    target_channel_id, 'razorpay', target_environment, target_provider_account_ref,
    target_provider_subscription_id, target_provider_plan_id, target_tier,
    target_billing_interval, target_price_paise, current_timestamp, current_timestamp
  );
  return 'created';
end
$$;

-- This function records the signed subscription event and then applies only
-- the server-owned link's tier/price/channel. Events without a link or with
-- incomplete period evidence remain durable quarantine evidence and cannot
-- grant or revoke access.
create or replace function app_private.record_verified_subscription_webhook(
  target_delivery_id uuid,
  target_environment text,
  target_connected_account_ref text,
  target_provider_event_id text,
  target_raw_body_hash text,
  target_signature_verified_at timestamptz,
  target_received_at timestamptz,
  target_normalized jsonb
)
returns table (
  duplicate boolean,
  quarantined boolean,
  subscription_id uuid,
  channel_id uuid,
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
  normalized_status text := target_normalized ->> 'status';
  normalized_start bigint := nullif(target_normalized ->> 'currentStart', '')::bigint;
  normalized_end bigint := nullif(target_normalized ->> 'currentEnd', '')::bigint;
  normalized_charge bigint := nullif(target_normalized ->> 'chargeAt', '')::bigint;
  local_link public.channel_subscription_links%rowtype;
  local_subscription public.channel_subscriptions%rowtype;
  target_status text;
  period_start timestamptz;
  period_end timestamptz;
  renewal_at timestamptz;
  apply_result text;
  inserted_delivery_id uuid;
  has_local_subscription boolean;
begin
  if target_environment not in ('test', 'live')
     or target_connected_account_ref = ''
     or target_provider_event_id = ''
     or target_normalized is null
     or normalized_type <> 'subscription'
     or normalized_entity_id = ''
     or target_delivery_id is null
     or target_signature_verified_at is null
     or target_received_at is null then
    raise exception 'invalid normalized subscription webhook' using errcode = '22023';
  end if;

  insert into public.payment_webhook_deliveries (
    id, provider, environment, connected_account_ref, provider_event_id,
    provider_event_name, entity_type, entity_id, raw_body_hash,
    signature_verified_at, received_at, processing_status
  ) values (
    target_delivery_id, 'razorpay', target_environment, target_connected_account_ref,
    target_provider_event_id, normalized_event, 'subscription', normalized_entity_id,
    target_raw_body_hash, target_signature_verified_at, target_received_at, 'received'
  )
  on conflict (provider, environment, connected_account_ref, provider_event_id)
  do nothing
  returning id into inserted_delivery_id;

  if inserted_delivery_id is null then
    return query select true, false, null::uuid, null::uuid, 'duplicate';
    return;
  end if;

  select link.* into local_link
    from public.channel_subscription_links link
   where link.provider = 'razorpay'
     and link.environment = target_environment
     and link.provider_account_ref = target_connected_account_ref
     and link.provider_subscription_id = normalized_entity_id
   for update;

  if not found then
    update public.payment_webhook_deliveries
       set processing_status = 'quarantined'
     where id = target_delivery_id;
    return query select false, true, null::uuid, null::uuid, 'quarantined';
    return;
  end if;

  if coalesce(target_normalized ->> 'planId', '') <> local_link.provider_plan_id then
    update public.payment_webhook_deliveries
       set processing_status = 'quarantined'
     where id = target_delivery_id;
    return query select false, true, null::uuid, local_link.channel_id, 'quarantined';
    return;
  end if;

  -- Razorpay's authenticated event can legitimately have null period fields.
  -- Do not activate access from that event. Wait for a complete active event
  -- or an authenticated reconciliation result.
  if normalized_event = 'subscription.authenticated'
     or normalized_status in ('authenticated', 'created') then
    update public.payment_webhook_deliveries
       set processing_status = 'quarantined'
     where id = target_delivery_id;
    return query select false, true, null::uuid, local_link.channel_id, 'quarantined';
    return;
  end if;

  target_status := case
    when normalized_status in ('cancelled', 'completed')
      or normalized_event in ('subscription.cancelled', 'subscription.completed') then 'cancelled'
    when normalized_status in ('pending', 'halted')
      or normalized_event in ('subscription.pending', 'subscription.halted') then 'past_due'
    when normalized_status in ('active', 'authenticated')
      or normalized_event in ('subscription.activated', 'subscription.charged', 'subscription.updated') then 'active'
    else null
  end;

  if target_status is null then
    update public.payment_webhook_deliveries
       set processing_status = 'quarantined'
     where id = target_delivery_id;
    return query select false, true, null::uuid, local_link.channel_id, 'quarantined';
    return;
  end if;

  select subscription.* into local_subscription
    from public.channel_subscriptions subscription
   where subscription.provider = 'razorpay'
     and subscription.environment = target_environment
     and subscription.provider_account_ref = target_connected_account_ref
     and subscription.provider_subscription_id = normalized_entity_id
   for update;
  has_local_subscription := found;

  period_start := case when normalized_start is null then null else to_timestamp(normalized_start) end;
  period_end := case when normalized_end is null then null else to_timestamp(normalized_end) end;
  if period_start is null and has_local_subscription then period_start := local_subscription.current_period_start; end if;
  if period_end is null and has_local_subscription then period_end := local_subscription.current_period_end; end if;
  if period_start is null or period_end is null or period_end <= period_start then
    update public.payment_webhook_deliveries
       set processing_status = 'quarantined'
     where id = target_delivery_id;
    return query select false, true, null::uuid, local_link.channel_id, 'quarantined';
    return;
  end if;
  renewal_at := case when normalized_charge is null then null else to_timestamp(normalized_charge) end;

  select result into apply_result
    from app_private.apply_channel_subscription_state(
      local_link.channel_id, target_environment, target_connected_account_ref,
      normalized_entity_id, local_link.tier, local_link.billing_interval,
      local_link.recurring_price_paise, target_status,
      target_status <> 'cancelled', period_start, period_end, renewal_at,
      target_received_at
    );

  update public.payment_webhook_deliveries
     set processing_status = 'processed'
   where id = target_delivery_id;
  return query select false, false,
    case when apply_result = 'stale' then local_subscription.id else md5('subscription:' || target_environment || ':' || normalized_entity_id)::uuid end,
    local_link.channel_id, 'processed';
end
$$;

revoke execute on function app_private.register_channel_subscription_link(uuid, text, text, text, text, text, text, bigint) from public;
revoke execute on function app_private.record_verified_subscription_webhook(uuid, text, text, text, text, timestamptz, timestamptz, jsonb) from public;
grant execute on function app_private.register_channel_subscription_link(uuid, text, text, text, text, text, text, bigint) to bsa_payment;
grant execute on function app_private.record_verified_subscription_webhook(uuid, text, text, text, text, timestamptz, timestamptz, jsonb) to bsa_payment;
