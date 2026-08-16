-- L03/L04: downgrade enforcement — pause a channel's excess queues, oldest-
-- first retention, when its tier drops. Mirrors BharatStudio Alerts legacy's
-- downgrade-enforcement.ts (never deletes a resource, only pauses it, with a
-- machine-readable reason so it can be told apart from a creator's own
-- manual pause and excluded from re-pausing on a later unrelated downgrade).
--
-- Two things had to be fixed first, recorded in the "Entitlement values
-- addendum — 2026-08-16" in 01_MASTER_RELEASE_AUTHORITY.md, for this to have
-- anything real to enforce:
--   1. queueCount was never actually set in any published entitlement
--      version (free's '{}'::jsonb default, paid's merge in
--      publish_active_individual_entitlement) — the queue-creation
--      entitlement check added under L03 was consequently a no-op for
--      every tier. tier_queue_count() below is now the single source of
--      truth, used everywhere a queueCount value is needed.
--   2. Cancellation never reverted a channel's entitlement to free —
--      publish_active_individual_entitlement is only called from
--      apply_channel_subscription_state's target_status = 'active' branch.
--      publish_free_entitlement() + the new call in the 'cancelled' branch
--      below close that gap. This fires only once Razorpay's own
--      subscription.cancelled/completed webhook confirms the access window
--      is actually over (immediate hard-cancel, or cancel_at_cycle_end
--      reaching its natural end) — consistent with this codebase's existing
--      webhook-is-truth architecture; no cron/schedule is introduced, which
--      remains disabled per the non-negotiable release invariants.

alter table public.alert_queues
  add column paused_reason text check (paused_reason is null or paused_reason in ('manual', 'tier_downgrade')),
  add column paused_at timestamptz,
  add column updated_by text,
  add constraint alert_queues_pause_reason_consistency check (is_paused or (paused_reason is null and paused_at is null));

-- Single source of truth for the queueCount entitlement value per tier. See
-- the "Entitlement values addendum — 2026-08-16" for the approved figures
-- and their provenance (BharatStudio Alerts legacy, FRD-011 §4.1/§5.2).
-- Fails closed (raises) on an unrecognised tier rather than silently
-- returning an unlimited/null value.
create or replace function app_private.tier_queue_count(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 1;
    when 'pro' then return 3;
    when 'creator' then return 5;
    when 'studio' then return 10;
    else raise exception 'unknown entitlement tier: %', target_tier using errcode = '22023';
  end case;
end
$$;

-- Pauses the newest currently-active queues beyond new_tier's queueCount
-- limit, oldest-first retention (a creator's longest-standing queues are
-- most likely to be load-bearing — bound sources, in-flight events — so the
-- newest excess queues are the ones paused). Idempotent: only ever touches
-- queues that are currently open and unpaused, so a queue already paused —
-- whether by a creator or an earlier downgrade — is never re-paused, never
-- double-counted against the limit, and never has its reason overwritten.
-- Never deletes or closes a queue.
create or replace function app_private.enforce_queue_count_entitlement(
  target_channel_id uuid,
  target_tier text
)
returns table (paused_queue_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  queue_limit integer;
begin
  queue_limit := app_private.tier_queue_count(target_tier);

  perform 1 from public.channels where id = target_channel_id for update;
  if not found then
    raise exception 'channel not found for downgrade enforcement' using errcode = '23503';
  end if;

  return query
    with active_queues as (
      select queue.id, row_number() over (order by queue.created_at asc, queue.id asc) as retention_order
        from public.alert_queues queue
       where queue.channel_id = target_channel_id
         and queue.closed_at is null
         and queue.is_paused = false
    ), excess as (
      select id from active_queues where retention_order > queue_limit
    ), paused as (
      update public.alert_queues
         set is_paused = true,
             paused_reason = 'tier_downgrade',
             paused_at = current_timestamp,
             updated_by = 'system:downgrade_enforcement',
             updated_at = current_timestamp
       where id in (select id from excess)
      returning id
    )
    select id from paused;
end
$$;

-- Publishes a 'free' entitlement version once a subscription's cancellation
-- is confirmed. Mirrors publish_active_individual_entitlement's
-- version-allocation/idempotency pattern but clears the paid values instead
-- of merging provider identifiers into them, and is driven by cancellation
-- confirmation rather than a provider plan/price.
create or replace function app_private.publish_free_entitlement(
  target_channel_id uuid,
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
  perform 1 from public.channels where id = target_channel_id for update;
  if not found then
    raise exception 'channel not found for free entitlement projection' using errcode = '23503';
  end if;

  select entitlement.* into latest
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id
   order by entitlement.version desc
   limit 1;

  if found and latest.tier = 'free' then
    return;
  end if;

  select coalesce(max(entitlement.version), 0) + 1
    into next_version
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id;

  insert into public.channel_entitlement_versions (
    channel_id, version, tier, source, values, effective_at, created_at
  ) values (
    target_channel_id, next_version, 'free', 'individual_plan',
    jsonb_build_object('queueCount', app_private.tier_queue_count('free')),
    coalesce(target_effective_at, current_timestamp), current_timestamp
  );

  perform app_private.enforce_queue_count_entitlement(target_channel_id, 'free');
end
$$;

-- Now that queueCount has a real per-tier value, every published paid
-- entitlement version must actually carry it (previously only
-- subscriptionId/billingInterval/monthlyPricePaise were merged in), and an
-- upgrade/lateral change must re-run enforcement — a no-op when the new
-- limit has room, but the same idempotent pass a downgrade uses.
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

  perform 1
    from public.channels
   where id = target_channel_id
   for update;
  if not found then
    raise exception 'channel not found for active entitlement projection' using errcode = '23503';
  end if;

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
      'monthlyPricePaise', target_price_paise,
      'queueCount', app_private.tier_queue_count(target_tier)
    ),
    target_effective_at, current_timestamp
  );

  perform app_private.enforce_queue_count_entitlement(target_channel_id, target_tier);
end
$$;

-- A brand-new channel's free entitlement now carries a real queueCount
-- instead of an unenforceable '{}'::jsonb — everything else in this
-- function is unchanged from 0025's definition.
create or replace function app_private.create_channel(
  target_channel_id uuid,
  target_user_id uuid,
  target_handle text,
  target_display_name text
)
returns table (channel_id uuid)
language sql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
  with inserted_channel as (
    insert into public.channels (id, owner_user_id, handle, display_name, created_at, updated_at)
    values (target_channel_id, target_user_id, target_handle, target_display_name, current_timestamp, current_timestamp)
    returning id
  ), inserted_membership as (
    insert into public.channel_memberships (channel_id, user_id, role, created_at)
    select inserted_channel.id, target_user_id, 'owner', current_timestamp
      from inserted_channel
    returning channel_id
  ), inserted_config as (
    insert into public.channel_configs (channel_id, version, values, effective_at, created_at)
    select inserted_channel.id, 1, '{}'::jsonb, current_timestamp, current_timestamp
      from inserted_channel
    returning channel_id
  ), inserted_entitlement as (
    insert into public.channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
    select inserted_channel.id, 1, 'free', 'individual_plan',
           jsonb_build_object('queueCount', app_private.tier_queue_count('free')),
           current_timestamp, current_timestamp
      from inserted_channel
    returning channel_id
  ), inserted_queue as (
    insert into public.alert_queues (id, channel_id, name, created_at, updated_at)
    select md5('default-alert-queue:' || inserted_channel.id::text)::uuid,
           inserted_channel.id,
           'Main alerts',
           current_timestamp,
           current_timestamp
      from inserted_channel
    returning channel_id
  ), inserted_payment_binding as (
    insert into public.queue_bindings (
      id, channel_id, queue_id, source_type, source_id, allow_duplicates,
      priority, created_at
    )
    select md5('default-payment-binding:' || inserted_channel.id::text)::uuid,
           inserted_channel.id,
           md5('default-alert-queue:' || inserted_channel.id::text)::uuid,
           'payment',
           '__channel_default__',
           false,
           0,
           current_timestamp
      from inserted_channel
    returning channel_id
  )
  select channel_id from inserted_membership
$$;

-- Cancellation confirmation now also drops the channel's entitlement back to
-- free and enforces queueCount against it — previously only target_status =
-- 'active' published anything, so a cancelled channel kept its last paid
-- entitlement forever.
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
    elsif target_status = 'cancelled' then
      perform app_private.publish_free_entitlement(current_row.channel_id, target_event_at);
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
  elsif target_status = 'cancelled' then
    perform app_private.publish_free_entitlement(current_row.channel_id, target_event_at);
  end if;

  return query select
    'created'::text, current_row.id, current_row.channel_id, current_row.tier,
    current_row.status, current_row.recurring_price_paise,
    current_row.price_source, current_row.price_protected_until,
    current_row.grace_until;
end
$$;

revoke execute on function app_private.tier_queue_count(text) from public;
revoke execute on function app_private.enforce_queue_count_entitlement(uuid, text) from public;
revoke execute on function app_private.publish_free_entitlement(uuid, timestamptz) from public;
grant execute on function app_private.tier_queue_count(text) to bsa_app, bsa_payment;
grant execute on function app_private.enforce_queue_count_entitlement(uuid, text) to bsa_payment;
grant execute on function app_private.publish_free_entitlement(uuid, timestamptz) to bsa_payment;
