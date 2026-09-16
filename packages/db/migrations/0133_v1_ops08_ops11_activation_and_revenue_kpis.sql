-- OPS-08 (activation instrumentation) and the derivable half of OPS-11
-- (revenue KPIs), per FULL-PRODUCT-DEFINITION.md §31, §31.0, §19.6, §12.6,
-- §12.7 and bharatstudio-requirements/reviews/2026-09-16-ops-activation-
-- and-revenue-instrumentation.md.
--
-- ADDITIVE ONLY. Two new read-only app_private functions. No new table, no
-- new column, no counter. Every value below is recomputed from durable
-- truth on every call (§19.6) -- there is nothing here a refund has to
-- "catch up to": the very next read is already correct.
--
-- =========================================================================
-- OPS-08 -- app_private.get_creator_activation_state
--
-- Three activation milestones, each already knowable from an existing
-- durable, append-only record -- no new schema:
--
--   payout_connected   -- public.payment_account_audit, action = 'activated'
--                          (0060). This is the SAME signal 0093's
--                          get_companion_state already reads for
--                          payment_account_connected, except that reads
--                          CURRENT status (a later revoke flips it back to
--                          false); an activation milestone must be sticky
--                          -- once a creator has ever completed Razorpay
--                          activation, that fact does not un-happen if they
--                          later revoke the account. payment_account_audit
--                          is append-only (no update/delete grant to
--                          bsa_app -- 0060), so MIN(created_at) over
--                          action = 'activated' rows is a stable "first
--                          activated" timestamp regardless of what happens
--                          to payment_accounts.status afterwards.
--   overlay_connected  -- public.overlay_sessions, any row ever created for
--                          the channel. Sessions are never deleted (only
--                          revoked_at/expires_at are set -- see
--                          app_private.run_overlay_session_maintenance,
--                          0016), so EXISTS(...) regardless of current
--                          validity is a safe "has this creator ever loaded
--                          the overlay as an OBS browser source" milestone,
--                          again deliberately sticky rather than the live
--                          "is a session valid right now" signal
--                          get_companion_state's overlay_connected reads.
--   first_alert_fired  -- public.alert_events, any row ever created for the
--                          channel (alert_events rows are never deleted).
--
-- Read-only, no amounts, so any active channel member may read it (same
-- guard as get_companion_state: app_private.can_access_channel).
create or replace function app_private.get_creator_activation_state(
  target_channel_id uuid
)
returns table (
  payout_connected boolean,
  payout_connected_at timestamptz,
  overlay_connected boolean,
  overlay_connected_at timestamptz,
  first_alert_fired boolean,
  first_alert_fired_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select
    exists (
      select 1 from public.payment_account_audit audit
       where audit.channel_id = target_channel_id and audit.action = 'activated'
    ),
    (
      select min(audit.created_at) from public.payment_account_audit audit
       where audit.channel_id = target_channel_id and audit.action = 'activated'
    ),
    exists (
      select 1 from public.overlay_sessions session where session.channel_id = target_channel_id
    ),
    (
      select min(session.created_at) from public.overlay_sessions session
       where session.channel_id = target_channel_id
    ),
    exists (
      select 1 from public.alert_events event where event.channel_id = target_channel_id
    ),
    (
      select min(event.created_at) from public.alert_events event
       where event.channel_id = target_channel_id
    )
  where app_private.can_access_channel(target_channel_id)
$$;

revoke execute on function app_private.get_creator_activation_state(uuid) from public;
grant execute on function app_private.get_creator_activation_state(uuid) to bsa_app;

-- =========================================================================
-- OPS-11 (derivable subset only) -- app_private.get_channel_revenue_kpis
--
-- Built: average tip, repeat-supporter rate, challenge revenue, vote
-- revenue -- every one of them a read over payments/refunds/challenges/
-- vote_payment_tags/creator_supporter_relations that already exists.
--
-- Explicitly NOT built here (see the review record): tips-per-viewer-hour,
-- TTS-driven tips, threshold uplift, goal-driven tips and `!tip` conversion
-- -- each needs a cause-attribution write path (or, for `!tip`, a chat-
-- command origin marker) that does not exist anywhere in this schema today
-- and that Opus referred rather than authorised here.
--
-- AVERAGE TIP -- mean of (gross_amount_paise - processed refunds), clamped
-- at zero, over payments in ('captured','refunded','partially_refunded')
-- whose created_at falls in [window_start, window_end). A payment refunded
-- down to exactly zero net is excluded from the average (it is not a
-- tip that happened, per the same "greatest(...,0)" floor 0102/0109/0124
-- already use) rather than dragging the average down to a value nobody
-- actually paid.
--
-- REPEAT-SUPPORTER RATE -- deliberately NOT windowed by payment date: it is
-- a relationship-population statistic (what share of this channel's
-- supporters have supported more than once), not a per-period revenue
-- figure, so it reads creator_supporter_relations.tip_count directly --
-- already recomputed net-of-refunds by 0124's trigger, so a refund that
-- takes a supporter's net-positive tip count from 2 down to 1 changes this
-- rate on the very next read, with no counter to correct (§19.6, exactly
-- as required).
--
-- THE PRIVACY BOUNDARY (Opus's decision, binding): an anonymous supporter's
-- identity must not be tracked as "repeat" past anonymous_browser_
-- identities.expires_at (0124: 30 days from first resolution, matching
-- db/viewer-store.ts's own 30-day session TTL default). The population
-- this function counts over therefore excludes any relation whose viewer
-- identity is kind='anonymous' AND that identity's anonymous_browser_
-- identities row has already expired -- once the 30-day window passes, a
-- returning anonymous supporter is, correctly, a NEW identity (0124's own
-- resolve_anonymous_payment_identity never resurrects an expired token),
-- so continuing to count the old row as evidence of a "return" would
-- silently extend tracking past the boundary the TTL exists to enforce.
-- kind='platform'/'account' identities carry no such TTL and are always
-- included.
--
-- CHALLENGE REVENUE -- sums app_private.challenge_progress_paise() (0109)
-- over every challenge in the channel whose started_at falls in the
-- window. Reuses 0109's own windowed-sum-over-payments definition
-- unchanged (that function already nets processed refunds); this migration
-- adds no separate payment-to-challenge attribution, because none exists
-- to add (0109's own header explains why: a challenge's progress is its
-- channel's payments during its active window, not a per-payment tag).
--
-- VOTE REVENUE -- sums net paise over every public.vote_payment_tags row
-- for the channel, via the exact join chain 0108's own
-- paid_support_vote_tally already established (vote_payment_tags ->
-- payment_order_intents -> payments, minus processed refunds), just
-- aggregated across every definition/option in the channel instead of one
-- definition at a time.
--
-- ACCESS: financial amounts, so owner/admin only (00_LAUNCH_SCOPE_
-- AUTHORITY.md's role-scoped financial-visibility rule) -- a caller
-- without that role gets an all-zero/empty row, never a 403, matching
-- list_channel_payments' own posture (0071).
create or replace function app_private.get_channel_revenue_kpis(
  target_channel_id uuid,
  window_start timestamptz,
  window_end timestamptz
)
returns table (
  average_net_tip_paise numeric,
  net_tip_count bigint,
  total_net_tip_paise bigint,
  supporter_count bigint,
  repeat_supporter_count bigint,
  repeat_supporter_rate numeric,
  challenge_revenue_paise bigint,
  vote_revenue_paise bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with bounds as (
    select coalesce(window_start, '-infinity'::timestamptz) as w_start,
           coalesce(window_end, 'infinity'::timestamptz) as w_end
  ),
  net_tips as (
    select greatest(payment.gross_amount_paise - coalesce(refunded.amount_paise, 0), 0) as net_paise
      from public.payments payment
      cross join bounds
      left join lateral (
        select sum(refund.amount_paise)::bigint as amount_paise
          from public.refunds refund
         where refund.payment_id = payment.id and refund.status = 'processed'
      ) refunded on true
     where payment.channel_id = target_channel_id
       and payment.status in ('captured', 'refunded', 'partially_refunded')
       and payment.created_at >= bounds.w_start
       and payment.created_at < bounds.w_end
  ),
  positive_tips as (
    select net_paise from net_tips where net_paise > 0
  ),
  supporter_population as (
    select csr.tip_count
      from public.creator_supporter_relations csr
      join public.viewer_identities vi on vi.id = csr.viewer_identity_id
      left join public.anonymous_browser_identities abi on abi.id = vi.anonymous_identity_id
     where csr.channel_id = target_channel_id
       and (vi.kind <> 'anonymous' or abi.expires_at > current_timestamp)
  ),
  challenge_revenue as (
    select coalesce(sum(app_private.challenge_progress_paise(c.id)), 0)::bigint as amount_paise
      from public.challenges c
      cross join bounds
     where c.channel_id = target_channel_id
       and c.started_at is not null
       and c.started_at >= bounds.w_start
       and c.started_at < bounds.w_end
  ),
  vote_revenue as (
    select coalesce(sum(greatest(payment.gross_amount_paise - coalesce(refunded.amount_paise, 0), 0)), 0)::bigint as amount_paise
      from public.vote_payment_tags tag
      cross join bounds
      join public.payment_order_intents intent
        on intent.channel_id = tag.channel_id
       and intent.environment = tag.environment
       and intent.idempotency_key = tag.idempotency_key
      join public.payments payment
        on payment.provider = intent.provider
       and payment.environment = intent.environment
       and payment.connected_account_ref = intent.connected_account_ref
       and payment.provider_order_id = intent.provider_order_id
      left join (
        select refund.payment_id, sum(refund.amount_paise) as amount_paise
          from public.refunds refund
         where refund.status = 'processed'
         group by refund.payment_id
      ) refunded on refunded.payment_id = payment.id
     where tag.channel_id = target_channel_id
       and payment.status in ('captured', 'refunded', 'partially_refunded')
       and payment.created_at >= bounds.w_start
       and payment.created_at < bounds.w_end
  )
  select
    case when (select count(*) from positive_tips) = 0 then 0::numeric
         else round((select coalesce(sum(net_paise), 0) from positive_tips)::numeric
                     / (select count(*) from positive_tips), 2) end,
    (select count(*) from positive_tips),
    (select coalesce(sum(net_paise), 0) from positive_tips),
    (select count(*) from supporter_population),
    (select count(*) from supporter_population where tip_count > 1),
    case when (select count(*) from supporter_population) = 0 then 0::numeric
         else round((select count(*) from supporter_population where tip_count > 1)::numeric
                     / (select count(*) from supporter_population), 4) end,
    (select amount_paise from challenge_revenue),
    (select amount_paise from vote_revenue)
  where app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
$$;

revoke execute on function app_private.get_channel_revenue_kpis(uuid, timestamptz, timestamptz) from public;
grant execute on function app_private.get_channel_revenue_kpis(uuid, timestamptz, timestamptz) to bsa_app;

-- ROLLBACK: additive only -- two new app_private functions, no table, no
-- column, no trigger, no index. Reverted by a new forward migration that
-- drops app_private.get_creator_activation_state(uuid) and
-- app_private.get_channel_revenue_kpis(uuid, timestamptz, timestamptz);
-- never by editing or deleting this file.
