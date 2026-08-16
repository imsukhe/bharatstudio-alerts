-- L03/L04: correct app_private.get_billing_view's no-subscription default
-- shape, found via live onboarding testing against a brand-new channel
-- that has never had a channel_subscriptions row.
--
-- 0048's original coalesce() defaults were
--   coalesce(latest.charged_months, 10), coalesce(latest.service_months, 12),
--   coalesce(latest.billing_interval, 'monthly')
-- — an ANNUAL charged/service shape (10/12) paired with a MONTHLY interval
-- default. This is exactly the invariant this repository's own
-- channel_subscriptions CHECK constraint enforces for a real row
-- (billing_interval = 'monthly' requires charged_months = 1 and
-- service_months = 1, only 'annual' gets 10/12) — the fallback path for a
-- channel with no subscription row at all was never brought into line with
-- it, because every channel exercised before now already had a real
-- subscription row (e.g. the seeded demo/studio channel), so the
-- left-join-to-nothing branch was never actually hit in practice.
-- apps/web/app/lib/api.ts's parseBillingView (already fixed this session
-- for the real-subscription case) correctly rejects this shape client-side
-- — a brand-new free channel's dashboard load failed closed with "Server
-- response was invalid" rather than silently accepting inconsistent data.
--
-- Fix: default charged/service months to the monthly shape (1/1) to match
-- the already-defaulted 'monthly' interval, consistent with the CHECK
-- constraint. No existing channel_subscriptions row is touched — this only
-- changes the synthesized projection for a channel with zero rows.
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
         coalesce(latest.charged_months, 1),
         coalesce(latest.service_months, 1),
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

revoke execute on function app_private.get_billing_view(uuid) from public;
grant execute on function app_private.get_billing_view(uuid) to bsa_app;
