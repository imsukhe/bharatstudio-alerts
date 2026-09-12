-- L03 TTS character metering (MASTER-PLAN §3.2/§10.3 item 4 — "Meter TTS
-- spend. Nothing does today. Ship this before the first paid creator.").
--
-- Nothing today counts characters sent to the paid TTS provider — 0067 only
-- has size CHECK constraints on the stored audio artifact, not a spend
-- counter. This migration adds a per-channel, per-billing-month character
-- counter with an atomic check-and-increment (hard stop): a caller can never
-- push usage past quota, because the increment happens inside the same
-- row-locked transaction as the quota check (app_private.meter_tts_usage).
--
-- Billing month = calendar month in UTC (date_trunc('month', now())::date).
-- Chosen over anchoring to each channel_subscriptions.current_period_start
-- because the TTS quota is a flat monthly plan allowance, not a
-- billing-cycle-prorated one (§3.2's "Overage behaviour" is a hard stop +
-- upgrade prompt, not a prorated carry-over), so a plain calendar month is
-- simpler and deterministic without joining subscription state on every
-- synthesis call. If a future decision anchors this to the billing cycle
-- instead, only meter_tts_usage/get_tts_quota_remaining need to change —
-- the table shape (channel_id, billing_month) already supports either.

create table if not exists public.alert_tts_usage_monthly (
  channel_id uuid not null references public.channels(id),
  billing_month date not null,
  characters_used integer not null default 0 check (characters_used >= 0),
  updated_at timestamptz not null default current_timestamp,
  primary key (channel_id, billing_month)
);

alter table public.alert_tts_usage_monthly enable row level security;
revoke all on public.alert_tts_usage_monthly from public;
revoke all on public.alert_tts_usage_monthly from bsa_app;

-- Single source of truth for the monthly premium-TTS character quota per
-- tier (MASTER-PLAN §3.2). Same shape/fail-closed exception as
-- tier_queue_count (0080) and tier_entitlement_dimensions (0080/below).
create or replace function app_private.tier_tts_monthly_quota(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 0;
    when 'pro' then return 20000;
    when 'creator' then return 40000;
    when 'studio' then return 60000;
    else raise exception 'unknown entitlement tier: %', target_tier using errcode = '22023';
  end case;
end
$$;

-- Now that the quota figure has a source of truth, fold it into the
-- eight-dimension jsonb as the hidden `ttsMonthlyCharQuota` key (see 0080's
-- comment on this function) and refresh every channel's already-published
-- latest entitlement row with it, same non-destructive backfill approach
-- 0080 used for the retier.
create or replace function app_private.tier_entitlement_dimensions(target_tier text)
returns jsonb
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then
      return jsonb_build_object(
        'queueCount', 1,
        'ttsEnabled', false,
        'allowedQueueModes', jsonb_build_array('fifo'),
        'maxVisibleItems', 3,
        'maxCharLimit', 100,
        'maxDisplayMs', 6000,
        'quietMode', false,
        'approvalRequired', false,
        'ttsMonthlyCharQuota', app_private.tier_tts_monthly_quota('free')
      );
    when 'pro' then
      return jsonb_build_object(
        'queueCount', 2,
        'ttsEnabled', true,
        'allowedQueueModes', jsonb_build_array('fifo', 'stacked', 'aggregated'),
        'maxVisibleItems', 5,
        'maxCharLimit', 150,
        'maxDisplayMs', 8000,
        'quietMode', true,
        'approvalRequired', false,
        'ttsMonthlyCharQuota', app_private.tier_tts_monthly_quota('pro')
      );
    when 'creator' then
      return jsonb_build_object(
        'queueCount', 3,
        'ttsEnabled', true,
        'allowedQueueModes', jsonb_build_array('fifo', 'stacked', 'aggregated', 'priority'),
        'maxVisibleItems', 8,
        'maxCharLimit', 300,
        'maxDisplayMs', 12000,
        'quietMode', true,
        'approvalRequired', true,
        'ttsMonthlyCharQuota', app_private.tier_tts_monthly_quota('creator')
      );
    when 'studio' then
      return jsonb_build_object(
        'queueCount', 5,
        'ttsEnabled', true,
        'allowedQueueModes', jsonb_build_array('fifo', 'stacked', 'aggregated', 'priority', 'approval'),
        'maxVisibleItems', 12,
        'maxCharLimit', 500,
        'maxDisplayMs', 20000,
        'quietMode', true,
        'approvalRequired', true,
        'ttsMonthlyCharQuota', app_private.tier_tts_monthly_quota('studio')
      );
    else raise exception 'unknown entitlement tier: %', target_tier using errcode = '22023';
  end case;
end
$$;

do $$
declare
  channel_row record;
begin
  for channel_row in
    select distinct on (entitlement.channel_id)
           entitlement.channel_id, entitlement.tier, entitlement.version
      from public.channel_entitlement_versions entitlement
     order by entitlement.channel_id, entitlement.version desc
  loop
    update public.channel_entitlement_versions
       set values = values || app_private.tier_entitlement_dimensions(channel_row.tier)
     where channel_id = channel_row.channel_id
       and version = channel_row.version;
  end loop;
end
$$;

-- Remaining quota for a channel right now: tier, monthly quota, characters
-- used this billing month, and what's left (never negative).
create or replace function app_private.get_tts_quota_remaining(target_channel_id uuid)
returns table (
  channel_id uuid,
  tier text,
  monthly_quota integer,
  characters_used integer,
  remaining integer
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with entitlement as (
    select coalesce(
      (select entitlement.tier from public.channel_entitlement_versions entitlement
        where entitlement.channel_id = target_channel_id
        order by entitlement.version desc limit 1),
      'free'
    ) as tier
  ), quota as (
    select entitlement.tier, app_private.tier_tts_monthly_quota(entitlement.tier) as monthly_quota
      from entitlement
  ), usage as (
    select coalesce(usage_row.characters_used, 0) as characters_used
      from quota
      left join public.alert_tts_usage_monthly usage_row
        on usage_row.channel_id = target_channel_id
       and usage_row.billing_month = date_trunc('month', current_timestamp)::date
  )
  select target_channel_id, quota.tier, quota.monthly_quota, usage.characters_used,
         greatest(quota.monthly_quota - usage.characters_used, 0)
    from quota, usage
$$;

-- Atomic check-and-increment hard stop, driven by an already-durable alert
-- event (never by caller-supplied channel/tier, so a caller cannot forge a
-- cheaper tier). Row-locks the channel and the usage-month row so concurrent
-- synthesis calls for the same channel serialize instead of both slipping
-- past the quota check ("TOCTOU" race) — same lock-then-check-then-write
-- shape app_private.update_companion_layout (0042) and
-- app_private.enforce_queue_count_entitlement (0070) already use.
create or replace function app_private.meter_tts_usage(
  target_event_id uuid,
  target_char_count integer
)
returns table (allowed boolean, remaining integer, reason text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  target_channel_id uuid;
  current_tier text;
  quota integer;
  current_month date := date_trunc('month', current_timestamp)::date;
  used integer;
begin
  -- No upper bound here beyond non-negative: the per-synthesis-call bound
  -- (message length, capped at 500 by app_private.get_alert_tts_input in
  -- 0067) is enforced upstream of this function, and this function's own
  -- job is only the arithmetic hard stop against the monthly quota.
  if target_char_count is null or target_char_count < 0 then
    raise exception 'invalid TTS character count' using errcode = '22023';
  end if;

  select event.channel_id into target_channel_id
    from public.alert_events event
   where event.id = target_event_id;
  if not found then
    raise exception 'alert event not found for TTS metering' using errcode = '23503';
  end if;

  perform 1 from public.channels where id = target_channel_id for update;

  select entitlement.tier into current_tier
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id
   order by entitlement.version desc
   limit 1;
  current_tier := coalesce(current_tier, 'free');

  quota := app_private.tier_tts_monthly_quota(current_tier);

  if quota = 0 then
    return query select false, 0, 'tier_not_entitled';
    return;
  end if;

  insert into public.alert_tts_usage_monthly (channel_id, billing_month, characters_used, updated_at)
  values (target_channel_id, current_month, 0, current_timestamp)
  on conflict (channel_id, billing_month) do nothing;

  select usage_row.characters_used into used
    from public.alert_tts_usage_monthly usage_row
   where usage_row.channel_id = target_channel_id
     and usage_row.billing_month = current_month
     for update;

  if used + target_char_count > quota then
    return query select false, greatest(quota - used, 0), 'quota_exhausted';
    return;
  end if;

  update public.alert_tts_usage_monthly
     set characters_used = used + target_char_count,
         updated_at = current_timestamp
   where channel_id = target_channel_id
     and billing_month = current_month;

  return query select true, quota - (used + target_char_count), null::text;
end
$$;

revoke execute on function app_private.tier_tts_monthly_quota(text) from public;
revoke execute on function app_private.get_tts_quota_remaining(uuid) from public;
revoke execute on function app_private.meter_tts_usage(uuid, integer) from public;
grant execute on function app_private.tier_tts_monthly_quota(text) to bsa_app;
grant execute on function app_private.get_tts_quota_remaining(uuid) to bsa_app;
grant execute on function app_private.meter_tts_usage(uuid, integer) to bsa_app;
