-- L03: creator-to-creator referral/growth engine — v1 scope addendum item.
--
-- Design authority: bharatstudio-requirements/active/launch/
-- 01_MASTER_RELEASE_AUTHORITY.md, "v1 scope addendum — 2026-08-16" (scope:
-- referral with fraud signals, credit FSM, self-serve dashboard) and
-- "Referral credit mechanism addendum — 2026-08-16" (owner decision: a
-- referral credit is a SERVICE-TIME CREDIT, not a refund — it extends the
-- beneficiary subscription's current_period_end by an owner-approved number
-- of days, applied through the existing entitlement-publish path, with
-- recurring_price_paise never touched). Legacy's refund-based "1 month free"
-- mechanism is not carried over — building it would add outbound
-- money-movement code to the payment boundary, directly against
-- non-negotiable invariant #2.
--
-- Parameters this migration fixes (left open by the addendum, recorded here
-- and in the L03 task record rather than carried over from legacy as
-- authority): reward = 30 service-time days per credited referral; a 14-day
-- post-conversion hold before a credit is granted (guards the same
-- cancel-immediately abuse pattern legacy's hold protected against, just
-- without a refund to claw back); a referral not converting within 90 days
-- expires; a granted-but-unconsumed (banked) credit itself expires after 180
-- days; at most 5 credited referrals per referrer per rolling 30 days; at
-- most 12 concurrently-banked (unconsumed) credits per referrer. A referral
-- past its monthly cap or banked-credit cap is not silently dropped — it is
-- recorded as 'flagged_fraud' or as a forfeited (status='expired') ledger
-- entry respectively, so every referral's fate is auditable.
--
-- Fraud signal set (v1): a same-IP-subnet-hash reuse check across a single
-- referrer's own referred channels (two or more referred signups sharing an
-- IP /24 strongly suggests one operator farming their own referral credits)
-- plus the unconditional CHECK against self-referral below. Device
-- fingerprinting and PAN-dedup (both present in legacy) are deferred — this
-- repo has no client-side fingerprint collection and no confirmed Razorpay
-- TP PAN-dedup API, so building either now would be speculative. IP subnet
-- hashing happens server-side from the request IP; no raw IP is ever stored.

create table public.referrals (
  id uuid primary key,
  referrer_channel_id uuid not null references public.channels(id),
  referred_channel_id uuid not null references public.channels(id),
  status text not null check (status in (
    'pending', 'paid_pending_hold', 'credited', 'flagged_fraud', 'revoked', 'expired'
  )) default 'pending',
  flags jsonb not null default '{}'::jsonb,
  ip_subnet_hash text,
  device_fingerprint_hash text,
  attributed_at timestamptz not null default current_timestamp,
  payment_captured_at timestamptz,
  hold_expires_at timestamptz,
  credited_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  expires_at timestamptz not null,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (referred_channel_id),
  check (referrer_channel_id <> referred_channel_id)
);

create index referrals_referrer_status_idx on public.referrals (referrer_channel_id, status, created_at desc);
create index referrals_hold_expiry_idx on public.referrals (status, hold_expires_at) where status = 'paid_pending_hold';
create index referrals_pending_expiry_idx on public.referrals (status, expires_at) where status = 'pending';

alter table public.referrals enable row level security;
revoke all on public.referrals from public;
revoke all on public.referrals from bsa_app;
revoke all on public.referrals from bsa_payment;

-- The service-time credit ledger. A row is the durable record of one
-- referral's reward: 'active' (earned, not yet applied to a subscription —
-- "banked"), 'consumed' (applied — current_period_end already extended),
-- or 'expired' (either it sat banked past its own expiry, or it was
-- forfeited at grant time by the concurrent-banked-credit cap).
create table public.referral_credits (
  id uuid primary key,
  referral_id uuid not null references public.referrals(id),
  referrer_channel_id uuid not null references public.channels(id),
  credit_days integer not null check (credit_days > 0),
  status text not null check (status in ('active', 'consumed', 'expired')) default 'active',
  earned_at timestamptz not null default current_timestamp,
  expires_at timestamptz not null,
  applied_at timestamptz,
  applied_to_subscription_id uuid references public.channel_subscriptions(id),
  period_end_before timestamptz,
  period_end_after timestamptz,
  created_at timestamptz not null default current_timestamp,
  unique (referral_id)
);

create index referral_credits_referrer_status_idx on public.referral_credits (referrer_channel_id, status);
create index referral_credits_active_expiry_idx on public.referral_credits (status, expires_at) where status = 'active';

alter table public.referral_credits enable row level security;
revoke all on public.referral_credits from public;
revoke all on public.referral_credits from bsa_app;
revoke all on public.referral_credits from bsa_payment;

-- Single source of truth for the reward size, so the maintenance-job
-- credit grant and any future read-side display use the same value.
create or replace function app_private.referral_reward_days()
returns integer
language sql
immutable
as $$
  select 30
$$;

revoke execute on function app_private.referral_reward_days() from public;
grant execute on function app_private.referral_reward_days() to bsa_app;

-- Attributes a brand-new channel to a referrer identified by handle. Called
-- by the API immediately after app_private.create_channel succeeds, in a
-- separate transaction (channel creation must never fail or roll back
-- because of a bad/missing referral code). Never raises for an expected
-- "no such code" / "self-referral" / "already referred" outcome — those are
-- reported via the result column so the caller can log without treating
-- them as errors.
create or replace function app_private.record_referral_attribution(
  target_referred_channel_id uuid,
  target_referrer_handle text,
  target_ip_subnet_hash text
)
returns table (result text, referral_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  v_referrer_channel_id uuid;
  v_prior_same_subnet_count integer := 0;
  v_initial_status text;
  v_referral_id uuid;
begin
  if target_referrer_handle is null or length(trim(target_referrer_handle)) = 0 then
    return query select 'unknown_referrer_code'::text, null::uuid;
    return;
  end if;

  select id into v_referrer_channel_id
    from public.channels
   where lower(handle) = lower(target_referrer_handle)
     and closed_at is null;

  if v_referrer_channel_id is null then
    return query select 'unknown_referrer_code'::text, null::uuid;
    return;
  end if;

  if v_referrer_channel_id = target_referred_channel_id then
    return query select 'self_referral_rejected'::text, null::uuid;
    return;
  end if;

  if exists (select 1 from public.referrals where referred_channel_id = target_referred_channel_id) then
    return query select 'already_referred'::text, null::uuid;
    return;
  end if;

  if target_ip_subnet_hash is not null then
    select count(*) into v_prior_same_subnet_count
      from public.referrals existing
     where existing.referrer_channel_id = v_referrer_channel_id
       and existing.ip_subnet_hash = target_ip_subnet_hash;
  end if;

  v_initial_status := case when v_prior_same_subnet_count >= 2 then 'flagged_fraud' else 'pending' end;
  v_referral_id := gen_random_uuid();

  insert into public.referrals (
    id, referrer_channel_id, referred_channel_id, status, flags,
    ip_subnet_hash, attributed_at, expires_at, created_at, updated_at
  ) values (
    v_referral_id, v_referrer_channel_id, target_referred_channel_id, v_initial_status,
    jsonb_build_object('priorSameSubnetReferrals', v_prior_same_subnet_count),
    target_ip_subnet_hash, current_timestamp, current_timestamp + interval '90 days',
    current_timestamp, current_timestamp
  );

  return query select
    (case when v_initial_status = 'flagged_fraud' then 'flagged_fraud' else 'attributed' end)::text,
    v_referral_id;
end
$$;

revoke execute on function app_private.record_referral_attribution(uuid, text, text) from public;
grant execute on function app_private.record_referral_attribution(uuid, text, text) to bsa_app;

-- Called from apply_channel_subscription_state whenever a channel's
-- subscription transitions to 'active'. Two independent effects, one per
-- role a channel can play in a referral:
--  (a) referred side — this channel's first paid conversion starts the
--      fraud-review hold on the referral that brought it in, if any;
--  (b) referrer side — any service-time credits this channel has already
--      earned as a referrer but could not apply (it had no active
--      subscription of its own yet) are swept and marked consumed; the
--      returned day count is added to the period end the caller is about
--      to write, so the credit takes effect in the very same event instead
--      of waiting for a later one.
-- security definer, so it can write both tables despite bsa_payment having
-- no grant on either — same trust boundary as the caller itself.
create or replace function app_private.handle_referral_subscription_activated(
  target_channel_id uuid,
  target_event_at timestamptz
)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  v_banked_days integer := 0;
begin
  update public.referrals
     set status = 'paid_pending_hold',
         payment_captured_at = target_event_at,
         hold_expires_at = target_event_at + interval '14 days',
         updated_at = current_timestamp
   where referred_channel_id = target_channel_id
     and status = 'pending';

  select coalesce(sum(credit_days), 0) into v_banked_days
    from public.referral_credits
   where referrer_channel_id = target_channel_id
     and status = 'active';

  if v_banked_days > 0 then
    update public.referral_credits
       set status = 'consumed',
           applied_at = current_timestamp
     where referrer_channel_id = target_channel_id
       and status = 'active';
  end if;

  return v_banked_days;
end
$$;

revoke execute on function app_private.handle_referral_subscription_activated(uuid, timestamptz) from public;
grant execute on function app_private.handle_referral_subscription_activated(uuid, timestamptz) to bsa_payment;

-- The hold-expiry credit grant. Re-verifies the referred channel is still
-- an active paying subscriber (the entire reason the hold exists — a
-- cancellation during the review window blocks the credit) and enforces
-- both credit caps before ever touching a subscription row. If the
-- referrer already has an active subscription, the credit is applied
-- immediately by extending current_period_end (and grace_until, if set, by
-- the same delta so the grace_until >= current_period_end CHECK is
-- preserved) and the ledger row is written 'consumed' with a full
-- before/after audit trail. Otherwise the credit is left 'active'
-- (banked) for handle_referral_subscription_activated to sweep later.
create or replace function app_private.grant_referral_service_credit(
  target_referral_id uuid
)
returns table (result text, referral_id uuid, credit_days integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  referral_row public.referrals%rowtype;
  v_reward_days integer := app_private.referral_reward_days();
  v_monthly_credited_count integer;
  v_banked_active_count integer;
  v_referred_still_active boolean;
  v_sub public.channel_subscriptions%rowtype;
  v_period_end_before timestamptz;
  v_credit_id uuid;
begin
  select * into referral_row
    from public.referrals
   where id = target_referral_id
     and status = 'paid_pending_hold'
   for update;

  if not found then
    return query select 'not_eligible'::text, target_referral_id, 0;
    return;
  end if;

  if referral_row.hold_expires_at is null or referral_row.hold_expires_at > current_timestamp then
    return query select 'hold_not_expired'::text, target_referral_id, 0;
    return;
  end if;

  select exists (
    select 1 from public.channel_subscriptions
     where channel_id = referral_row.referred_channel_id
       and status = 'active'
  ) into v_referred_still_active;

  if not v_referred_still_active then
    update public.referrals
       set status = 'revoked', revoked_at = current_timestamp,
           revoked_reason = 'referred_subscription_not_active_at_hold_expiry',
           updated_at = current_timestamp
     where id = referral_row.id;
    return query select 'revoked'::text, referral_row.id, 0;
    return;
  end if;

  select count(*) into v_monthly_credited_count
    from public.referrals
   where referrer_channel_id = referral_row.referrer_channel_id
     and status = 'credited'
     and credited_at >= current_timestamp - interval '30 days';

  if v_monthly_credited_count >= 5 then
    update public.referrals
       set status = 'flagged_fraud',
           flags = flags || jsonb_build_object('reason', 'monthly_credit_cap_exceeded'),
           updated_at = current_timestamp
     where id = referral_row.id;
    return query select 'capped'::text, referral_row.id, 0;
    return;
  end if;

  select count(*) into v_banked_active_count
    from public.referral_credits
   where referrer_channel_id = referral_row.referrer_channel_id
     and status = 'active';

  v_credit_id := gen_random_uuid();

  if v_banked_active_count >= 12 then
    insert into public.referral_credits (
      id, referral_id, referrer_channel_id, credit_days, status, earned_at, expires_at, created_at
    ) values (
      v_credit_id, referral_row.id, referral_row.referrer_channel_id, v_reward_days, 'expired',
      current_timestamp, current_timestamp, current_timestamp
    );
    update public.referrals
       set status = 'credited', credited_at = current_timestamp, updated_at = current_timestamp
     where id = referral_row.id;
    return query select 'credited_forfeited_cap'::text, referral_row.id, 0;
    return;
  end if;

  select * into v_sub
    from public.channel_subscriptions
   where channel_id = referral_row.referrer_channel_id
     and status = 'active'
   for update;

  if found then
    v_period_end_before := v_sub.current_period_end;
    update public.channel_subscriptions
       set current_period_end = current_period_end + (v_reward_days || ' days')::interval,
           grace_until = case when grace_until is not null
                              then grace_until + (v_reward_days || ' days')::interval
                              else grace_until end,
           updated_at = current_timestamp
     where id = v_sub.id
     returning * into v_sub;

    insert into public.referral_credits (
      id, referral_id, referrer_channel_id, credit_days, status,
      earned_at, expires_at, applied_at, applied_to_subscription_id,
      period_end_before, period_end_after, created_at
    ) values (
      v_credit_id, referral_row.id, referral_row.referrer_channel_id, v_reward_days, 'consumed',
      current_timestamp, current_timestamp + interval '180 days', current_timestamp, v_sub.id,
      v_period_end_before, v_sub.current_period_end, current_timestamp
    );
  else
    insert into public.referral_credits (
      id, referral_id, referrer_channel_id, credit_days, status, earned_at, expires_at, created_at
    ) values (
      v_credit_id, referral_row.id, referral_row.referrer_channel_id, v_reward_days, 'active',
      current_timestamp, current_timestamp + interval '180 days', current_timestamp
    );
  end if;

  update public.referrals
     set status = 'credited', credited_at = current_timestamp, updated_at = current_timestamp
   where id = referral_row.id;

  return query select 'credited'::text, referral_row.id, v_reward_days;
end
$$;

revoke execute on function app_private.grant_referral_service_credit(uuid) from public;
grant execute on function app_private.grant_referral_service_credit(uuid) to bsa_app;

-- Read side for the self-serve dashboard. Auth is an explicit
-- has_channel_role check (same idiom as list_channel_payments, 0071)
-- rather than reliance on RLS — a non-member gets an empty result, not an
-- error. Written as plpgsql with an early return specifically so the
-- banked/lifetime totals — each its own uncorrelated scalar subquery
-- against referral_credits — never execute at all for an unauthorized
-- caller; folding the same check into a single SQL statement's WHERE
-- clause only filters the referrals aggregate, not those subqueries, and
-- would leak the totals regardless of role.
create or replace function app_private.list_channel_referral_overview(
  target_channel_id uuid
)
returns table (
  pending_count integer,
  paid_pending_hold_count integer,
  credited_count integer,
  flagged_or_revoked_count integer,
  banked_credit_days integer,
  lifetime_credited_days integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    return;
  end if;

  return query
    select
      count(*) filter (where r.status = 'pending')::integer,
      count(*) filter (where r.status = 'paid_pending_hold')::integer,
      count(*) filter (where r.status = 'credited')::integer,
      count(*) filter (where r.status in ('flagged_fraud', 'revoked'))::integer,
      coalesce((
        select sum(credit_days)::integer from public.referral_credits
         where referrer_channel_id = target_channel_id and status = 'active'
      ), 0),
      coalesce((
        select sum(credit_days)::integer from public.referral_credits
         where referrer_channel_id = target_channel_id and status = 'consumed'
      ), 0)
      from public.referrals r
     where r.referrer_channel_id = target_channel_id;
end
$$;

revoke execute on function app_private.list_channel_referral_overview(uuid) from public;
grant execute on function app_private.list_channel_referral_overview(uuid) to bsa_app;

-- The referral history table backing the same dashboard. Not paginated —
-- the self-serve v1 surface is a recent-activity view (latest 100), not a
-- full ledger; a cursor-paginated version is deferred until real usage
-- shows it is needed, same reasoning as the entitlement history view.
create or replace function app_private.list_channel_referrals(
  target_channel_id uuid
)
returns table (
  referral_id uuid,
  status text,
  attributed_at timestamptz,
  credited_at timestamptz,
  credit_days integer
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select r.id, r.status, r.attributed_at, r.credited_at,
         (select credit_days from public.referral_credits where referral_id = r.id)
    from public.referrals r
   where r.referrer_channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
   order by r.created_at desc
   limit 100
$$;

revoke execute on function app_private.list_channel_referrals(uuid) from public;
grant execute on function app_private.list_channel_referrals(uuid) to bsa_app;

-- apply_channel_subscription_state, redefined a fourth time (0048 -> 0070 ->
-- 0075 -> here) to fold in referral service-time credits at the exact
-- moment a channel's subscription becomes active: any credits this channel
-- has already banked as a referrer are swept and added to the period end
-- being written (so they apply in the same webhook event, not a follow-up
-- write against a table bsa_payment cannot otherwise touch), and if this
-- channel is itself a referred channel converting for the first time, its
-- referral's fraud-review hold starts. Everything else is unchanged from
-- 0075's definition.
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
  v_referral_credit_days integer := 0;
  v_effective_period_end timestamptz;
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

  if target_status = 'active' then
    v_referral_credit_days := app_private.handle_referral_subscription_activated(target_channel_id, target_event_at);
  end if;
  v_effective_period_end := target_period_end + (v_referral_credit_days || ' days')::interval;

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
           current_period_end = v_effective_period_end,
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
    perform app_private.enqueue_invoice_subscription_email(
      current_row.channel_id, target_status, current_row.tier, current_row.recurring_price_paise,
      current_row.next_renewal_at, current_row.grace_until
    );

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
    target_period_start, v_effective_period_end, target_next_renewal_at,
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
  perform app_private.enqueue_invoice_subscription_email(
    current_row.channel_id, target_status, current_row.tier, current_row.recurring_price_paise,
    current_row.next_renewal_at, current_row.grace_until
  );

  return query select
    'created'::text, current_row.id, current_row.channel_id, current_row.tier,
    current_row.status, current_row.recurring_price_paise,
    current_row.price_source, current_row.price_protected_until,
    current_row.grace_until;
end
$$;

-- accept_maintenance_run, redefined again to admit the new job.
create or replace function app_private.accept_maintenance_run(
  target_job text,
  target_idempotency_key text,
  target_window text default null
)
returns table (run_id uuid, job text, status text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  inserted_id uuid;
  existing public.maintenance_runs%rowtype;
begin
  if target_job not in (
    'payment-reconcile', 'refund-reconcile', 'outbox-recover',
    'overlay-sessions', 'event-archive', 'audit-archive',
    'overlay-expiry-reminder', 'referral-lifecycle'
  ) then
    raise exception 'unsupported maintenance job';
  end if;
  if length(target_idempotency_key) < 16 or length(target_idempotency_key) > 160 then
    raise exception 'invalid maintenance idempotency key';
  end if;
  if target_window is not null and (length(target_window) < 1 or length(target_window) > 80) then
    raise exception 'invalid maintenance window';
  end if;

  inserted_id := md5('maintenance:' || target_job || ':' || target_idempotency_key)::uuid;

  insert into public.maintenance_runs (id, job, idempotency_key, requested_window)
  values (inserted_id, target_job, target_idempotency_key, target_window)
  on conflict on constraint maintenance_runs_job_idempotency_key_key do nothing;

  if found then
    return query select inserted_id, target_job, 'accepted'::text;
    return;
  end if;

  select mr.* into existing
    from public.maintenance_runs mr
   where mr.job = target_job
     and mr.idempotency_key = target_idempotency_key
   for update;
  if existing.status = 'completed' then
    return query select existing.id, existing.job, 'already_completed'::text;
  else
    return query select existing.id, existing.job, 'accepted'::text;
  end if;
end
$$;

alter table public.maintenance_runs drop constraint if exists maintenance_runs_job_check;
alter table public.maintenance_runs add constraint maintenance_runs_job_check
  check (job in (
    'payment-reconcile', 'refund-reconcile', 'outbox-recover',
    'overlay-sessions', 'event-archive', 'audit-archive',
    'overlay-expiry-reminder', 'referral-lifecycle'
  ));

-- The two-phase job implementation: sweeps hold-expired referrals into a
-- credit decision, expires stale pending referrals, and expires stale
-- banked credits. Follows the same accept -> run_<job>_maintenance(run_id)
-- protocol as every other maintenance job in this codebase.
create or replace function app_private.run_referral_lifecycle_maintenance(
  target_run_id uuid
)
returns table (run_id uuid, job text, status text, credited_count integer, expired_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  run_record public.maintenance_runs%rowtype;
  hold_row public.referrals%rowtype;
  v_credited_count integer := 0;
  v_expired_count integer := 0;
  v_grant_result record;
begin
  select mr.* into run_record from public.maintenance_runs mr where mr.id = target_run_id for update;
  if not found then
    raise exception 'maintenance run not found' using errcode = '23503';
  end if;
  if run_record.job <> 'referral-lifecycle' then
    raise exception 'maintenance run job mismatch' using errcode = '22023';
  end if;
  if run_record.status = 'completed' then
    return query select run_record.id, run_record.job, 'already_completed'::text, 0, 0;
    return;
  end if;

  for hold_row in
    select ref.* from public.referrals ref
     where ref.status = 'paid_pending_hold'
       and ref.hold_expires_at <= current_timestamp
     order by ref.hold_expires_at
     limit 500
  loop
    select * into v_grant_result from app_private.grant_referral_service_credit(hold_row.id);
    if v_grant_result.result in ('credited', 'credited_forfeited_cap') then
      v_credited_count := v_credited_count + 1;
    end if;
  end loop;

  update public.referrals ref
     set status = 'expired', updated_at = current_timestamp
   where ref.status = 'pending'
     and ref.expires_at <= current_timestamp;
  get diagnostics v_expired_count = row_count;

  update public.referral_credits rc
     set status = 'expired'
   where rc.status = 'active'
     and rc.expires_at <= current_timestamp;

  update public.maintenance_runs mr
     set status = 'completed', completed_at = current_timestamp
   where mr.id = run_record.id;

  return query select run_record.id, run_record.job, 'completed'::text, v_credited_count, v_expired_count;
end
$$;

revoke execute on function app_private.run_referral_lifecycle_maintenance(uuid) from public;
grant execute on function app_private.run_referral_lifecycle_maintenance(uuid) to bsa_app;
