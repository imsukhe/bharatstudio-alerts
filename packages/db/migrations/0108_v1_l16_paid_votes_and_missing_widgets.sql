-- L16 gap-closure (2026-09-07): paid support votes + the four widget
-- overlay reads 0105 shipped configuration for but never rendered
-- (recent_tips, top_supporters, supporter_ticker, mega_tip_banner).
-- Depends on 0001-0106 (0102 support_goals shape, 0084 viewer identity,
-- 0105 interaction_definitions/interaction_vote_options/widget_configs,
-- 0006/0007 payment_order_intents+payments). Modifies no existing table or
-- function — additive only. See ROLLBACK at the bottom.
--
-- =========================================================================
-- GAP 1 — PAID VOTES. 0105's header explains why votes shipped as a plain
-- headcount tally: attributing a specific payment to a specific vote
-- option needs a tag somewhere between "public.ts accepts the tip-order
-- request" and "a payment row exists for it" — and every existing table on
-- that path (payment_order_intents, payments) belongs to other lanes.
--
-- THE JOIN, WITHOUT TOUCHING A SINGLE EXISTING TABLE: public.ts already
-- generates idempotencyKey and knows channelId + environment before it
-- ever calls the (out-of-repo) payment microservice. That triple
-- (channel_id, environment, idempotency_key) is also payment_order_intents'
-- own unique constraint (0006). And payment_order_intents.provider_order_id
-- always equals payments.provider_order_id for the payment that settles it
-- (0007's webhook handler sets both to the same normalized_order_id, scoped
-- by provider/environment/connected_account_ref on both sides). So:
--
--   vote_payment_tags (channel_id, environment, idempotency_key)
--     --> payment_order_intents (same triple, unique)
--     --> payments (provider, environment, connected_account_ref, provider_order_id)
--
-- is a complete, read-only chain from "a tag written before checkout" to
-- "the real captured/refunded payment row", with no ALTER on
-- payment_order_intents or payments and no write path except this new
-- table. This is exactly 0102/0105's "financial truth from real
-- payments/refunds only" rule, just reached via composite-key join instead
-- of a foreign key, because the FK target columns are owned elsewhere.
--
-- PROGRESS IS NEVER STORED, same as every other L16 tally: paid_support_
-- vote_tally sums payments.gross_amount_paise minus processed refunds.paise
-- live, every read. A refund therefore reduces its option's tally the very
-- next read, with no event to miss and no counter to desync.
--
-- MODE SELECTION: interaction_definitions.config (jsonb, already free-form
-- for support_vote per 0105) gets one new convention:
-- {"votingMode": "paid"}. A support_vote definition with no votingMode key,
-- or any value other than "paid", stays exactly the free/headcount flow
-- 0105 built — cast_support_vote/support_vote_tally/list_overlay_vote_tally
-- are UNCHANGED by this migration (not one line), so every existing
-- consumer (dashboard, the vote overlay widget, l16-interactions-routes
-- tests) keeps working unmodified. A "paid" definition additionally
-- accepts app_private.tag_vote_payment at checkout time; the caller
-- (apps/api/src/routes/public.ts) decides which mode a definition is in by
-- reading its config before deciding whether to send an interaction tag
-- with the tip order, and the dashboard/overlay decide which tally
-- function to call the same way. A definition cannot accept BOTH a headcount
-- cast and a paid tag on the same option in a way that double counts,
-- because cast_support_vote and tag_vote_payment write to two entirely
-- separate tables that are never summed together.
--
-- =========================================================================
-- GAP 2 — WIDGETS. Four widget_configs types (recent_tips, top_supporters,
-- supporter_ticker, mega_tip_banner) have config rows possible since 0105
-- but no overlay data endpoint. Every function below is scoped through
-- overlay_sessions/token_fingerprint exactly like list_overlay_goal/
-- list_overlay_vote_tally/list_overlay_leaderboard — no second delivery
-- path, no new auth model.
--
-- PRIVACY (master plan Part 11.5 — cross-creator history never visible to
-- creators, public profiles opt-in default-off): 0084 never built the
-- opt-in profile column its own task promised (confirmed absent by
-- grep across 0084-0106; see 0105's own header for the identical finding
-- re: the leaderboard). With no opt-in switch anywhere in the schema,
-- top_supporters and supporter_ticker — the two widgets that read
-- viewer_identity_id-linked history — follow 0105's leaderboard rule
-- exactly: an anonymised viewer_ref ('viewer_' || first 8 chars of the
-- identity uuid) and a coarse tier bucket ONLY. Never donor_display_name,
-- never viewer_accounts.display_name/email, never an exact amount. This
-- is not "hide it unless opted in" (there is nothing to opt into) — it is
-- "never expose it, structurally", the same posture 0105 took. recent_tips
-- and mega_tip_banner are different in kind: they read alert_events.payload
-- displayName/message, which only exists on a row at all because
-- payment_order_intents.alert_consent was true at checkout (0007) — the
-- donor's own opt-in to be shown on stream, already relied upon by the
-- existing main tip alert. No new consent concept is introduced.
--
-- ROLLBACK: additive only — one new table (vote_payment_tags) and ten new
-- app_private functions, none altering payments/refunds/alert_events/
-- interaction_definitions/interaction_vote_records/widget_configs. Feature-
-- flagging this off does not touch existing tip/vote/hype/leaderboard
-- flows. No production migration without separate explicit approval.

-- =========================================================================
-- vote_payment_tags
-- =========================================================================
create table public.vote_payment_tags (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  environment text not null check (environment in ('test', 'live')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  interaction_definition_id uuid not null references public.interaction_definitions(id),
  option_key text not null,
  created_at timestamptz not null default current_timestamp,
  unique (channel_id, environment, idempotency_key),
  foreign key (interaction_definition_id, option_key)
    references public.interaction_vote_options (interaction_definition_id, option_key)
);

create index vote_payment_tags_definition_idx on public.vote_payment_tags (interaction_definition_id, option_key);

alter table public.vote_payment_tags enable row level security;
revoke all on public.vote_payment_tags from public;
revoke all on public.vote_payment_tags from bsa_app;

-- Called from apps/api/src/routes/public.ts's tip-order route, BEFORE the
-- order is created, using the same channelId/environment/idempotencyKey
-- that route already computes for the payment itself. Public/unauthenticated
-- (a donor's browser calls the tip-order route with no session) — same
-- shape as cast_support_vote: no channel-role check, every real gate lives
-- inside this SECURITY DEFINER function. Idempotent for a genuine retry of
-- the same idempotency key with the same tag; rejects a reused key tagged
-- to a different option/definition, same "reused idempotency key with
-- different intent" posture as app_private.create_payment_order_intent.
create or replace function app_private.tag_vote_payment(
  target_channel_id uuid,
  target_environment text,
  target_idempotency_key text,
  target_definition_id uuid,
  target_option_key text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  def public.interaction_definitions%rowtype;
  existing public.vote_payment_tags%rowtype;
  new_id uuid;
begin
  if target_environment not in ('test', 'live')
     or target_idempotency_key is null or char_length(target_idempotency_key) not between 1 and 128 then
    raise exception 'invalid vote payment tag' using errcode = '22023';
  end if;

  select * into def from public.interaction_definitions
   where id = target_definition_id and channel_id = target_channel_id and interaction_type = 'support_vote';
  if not found or not def.is_enabled or def.closed_at is not null then
    raise exception 'this support vote is not accepting votes' using errcode = '22023';
  end if;
  if coalesce(def.config->>'votingMode', 'free') <> 'paid' then
    raise exception 'this support vote is not configured for paid voting' using errcode = '22023';
  end if;

  perform 1 from public.interaction_vote_options
   where interaction_definition_id = target_definition_id and option_key = target_option_key;
  if not found then
    raise exception 'invalid vote option' using errcode = '22023';
  end if;

  select * into existing from public.vote_payment_tags
   where channel_id = target_channel_id and environment = target_environment and idempotency_key = target_idempotency_key;

  if found then
    if existing.interaction_definition_id <> target_definition_id or existing.option_key <> target_option_key then
      raise exception 'idempotency key already tagged with a different vote option' using errcode = '23505';
    end if;
    return existing.id;
  end if;

  new_id := gen_random_uuid();
  insert into public.vote_payment_tags (id, channel_id, environment, idempotency_key, interaction_definition_id, option_key)
  values (new_id, target_channel_id, target_environment, target_idempotency_key, target_definition_id, target_option_key);
  return new_id;
end
$$;

revoke execute on function app_private.tag_vote_payment(uuid, text, text, uuid, text) from public;
grant execute on function app_private.tag_vote_payment(uuid, text, text, uuid, text) to bsa_app;

-- The money-derived tally. Sums, per option, real payments tagged to it
-- (via the chain in the header) minus processed refunds on those same
-- payments, clamped at zero as a defensive floor only (same posture as
-- 0102's support_goal_progress_paise and 0105's hype_mode_state). Zero
-- tagged payments for an option reads as zero, never an error. Dashboard
-- read: channel-role gated exactly like support_vote_tally.
create or replace function app_private.paid_support_vote_tally(target_channel_id uuid, target_definition_id uuid)
returns table (option_key text, label text, amount_paise bigint, resolved boolean, resolved_option_key text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with tag_amounts as (
    select tag.option_key,
           greatest(payment.gross_amount_paise - coalesce(refunded.amount_paise, 0), 0) as net_paise
      from public.vote_payment_tags tag
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
     where tag.interaction_definition_id = target_definition_id
       and tag.channel_id = target_channel_id
       and payment.status in ('captured', 'refunded', 'partially_refunded')
  ),
  tallies as (
    select opt.option_key, opt.label, coalesce(sum(ta.net_paise), 0) as amount_paise
      from public.interaction_vote_options opt
      join public.interaction_definitions def on def.id = opt.interaction_definition_id
      left join tag_amounts ta on ta.option_key = opt.option_key
     where def.id = target_definition_id
       and def.channel_id = target_channel_id
       and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
     group by opt.option_key, opt.label
  ),
  winner as (
    select option_key from tallies order by amount_paise desc, option_key asc limit 1
  ),
  is_closed as (
    select closed_at is not null as closed from public.interaction_definitions where id = target_definition_id
  )
  select t.option_key, t.label, t.amount_paise,
         (select closed from is_closed) as resolved,
         case when (select closed from is_closed) and exists (select 1 from tallies where amount_paise > 0)
              then (select option_key from winner) else null end as resolved_option_key
    from tallies t
   order by t.amount_paise desc, t.option_key asc
$$;

revoke execute on function app_private.paid_support_vote_tally(uuid, uuid) from public;
grant execute on function app_private.paid_support_vote_tally(uuid, uuid) to bsa_app;

-- Overlay read — same overlay_sessions/token-fingerprint scoping as
-- list_overlay_vote_tally.
create or replace function app_private.list_overlay_paid_vote_tally(target_overlay_id uuid, target_token_fingerprint text, target_definition_id uuid)
returns table (option_key text, label text, amount_paise bigint, resolved boolean, resolved_option_key text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with scoped_channel as (
    select session.channel_id
      from public.overlay_sessions session
     where session.id = target_overlay_id
       and session.token_fingerprint = target_token_fingerprint
       and session.revoked_at is null
       and session.expires_at > current_timestamp
  ),
  tag_amounts as (
    select tag.option_key,
           greatest(payment.gross_amount_paise - coalesce(refunded.amount_paise, 0), 0) as net_paise
      from public.vote_payment_tags tag
      join scoped_channel sc on sc.channel_id = tag.channel_id
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
     where tag.interaction_definition_id = target_definition_id
  ),
  tallies as (
    select opt.option_key, opt.label, coalesce(sum(ta.net_paise), 0) as amount_paise
      from public.interaction_vote_options opt
      join public.interaction_definitions def on def.id = opt.interaction_definition_id
      join scoped_channel sc on sc.channel_id = def.channel_id
      left join tag_amounts ta on ta.option_key = opt.option_key
     where def.id = target_definition_id
     group by opt.option_key, opt.label
  ),
  winner as (
    select option_key from tallies order by amount_paise desc, option_key asc limit 1
  ),
  is_closed as (
    select def.closed_at is not null as closed
      from public.interaction_definitions def
      join scoped_channel sc on sc.channel_id = def.channel_id
     where def.id = target_definition_id
  )
  select t.option_key, t.label, t.amount_paise,
         coalesce((select closed from is_closed), false) as resolved,
         case when coalesce((select closed from is_closed), false) and exists (select 1 from tallies where amount_paise > 0)
              then (select option_key from winner) else null end as resolved_option_key
    from tallies t
   order by t.amount_paise desc, t.option_key asc
$$;

revoke execute on function app_private.list_overlay_paid_vote_tally(uuid, text, uuid) from public;
grant execute on function app_private.list_overlay_paid_vote_tally(uuid, text, uuid) to bsa_app;

-- =========================================================================
-- Widget overlay reads: recent_tips, top_supporters, supporter_ticker,
-- mega_tip_banner. Every function is scoped through overlay_sessions,
-- returns zero rows for a bad/expired token (never an exception), and
-- carries no identity beyond what its header comment allows.
-- =========================================================================

-- recent_tips: consented (alert_consent = true at checkout, 0007) tip
-- events only — the same donor-supplied display name already shown on the
-- live main tip alert, nothing new exposed. Most recent 8, newest first.
create or replace function app_private.list_overlay_recent_tips(target_overlay_id uuid, target_token_fingerprint text)
returns table (display_name text, amount_paise bigint, message text, created_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select coalesce(nullif(event.payload->>'displayName', ''), 'Anonymous'),
         payment.gross_amount_paise,
         nullif(event.payload->>'message', ''),
         event.created_at
    from public.overlay_sessions session
    join public.alert_events event on event.channel_id = session.channel_id and event.source_type = 'payment'
    join public.payments payment on payment.id = event.payment_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and payment.status in ('captured', 'refunded', 'partially_refunded')
   order by event.created_at desc
   limit 8
$$;

revoke execute on function app_private.list_overlay_recent_tips(uuid, text) from public;
grant execute on function app_private.list_overlay_recent_tips(uuid, text) to bsa_app;

-- top_supporters: the top 5 of this channel's own monthly leaderboard —
-- literally reuses app_private.channel_leaderboard (0105), so it inherits
-- that function's privacy proof (rank + coarse tier bucket only, never an
-- exact amount, structurally incapable of a cross-channel row) rather than
-- re-deriving it. See PRIVACY note above.
create or replace function app_private.list_overlay_top_supporters(target_overlay_id uuid, target_token_fingerprint text)
returns table (rank integer, viewer_ref text, tier_label text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select board.rank, board.viewer_ref, board.tier_label
    from public.overlay_sessions session,
         lateral app_private.channel_leaderboard(session.channel_id, 'monthly') board
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
   order by board.rank
   limit 5
$$;

revoke execute on function app_private.list_overlay_top_supporters(uuid, text) from public;
grant execute on function app_private.list_overlay_top_supporters(uuid, text) to bsa_app;

-- supporter_ticker: the last 10 real, non-fully-refunded payments carrying
-- a viewer_identity_id on THIS channel, each shown as the same anonymised
-- viewer_ref + a coarse tier bucket for that single payment (identical
-- bucket thresholds to channel_leaderboard, applied per-payment instead of
-- lifetime — a ticker is a recency feed, not a ranking). Never
-- donor_display_name, never viewer_accounts.email/display_name, never an
-- exact amount. A fully refunded payment ('refunded' status) never
-- appears — 'partially_refunded' still represents real, ongoing support.
create or replace function app_private.list_overlay_supporter_ticker(target_overlay_id uuid, target_token_fingerprint text)
returns table (viewer_ref text, tier_label text, supported_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select 'viewer_' || substr(payment.viewer_identity_id::text, 1, 8),
         case
           when payment.gross_amount_paise >= 5000000 then 'platinum'
           when payment.gross_amount_paise >= 1000000 then 'gold'
           when payment.gross_amount_paise >= 200000 then 'silver'
           else 'bronze'
         end,
         payment.created_at
    from public.overlay_sessions session
    join public.payments payment on payment.channel_id = session.channel_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and payment.viewer_identity_id is not null
     and payment.status in ('captured', 'partially_refunded')
   order by payment.created_at desc
   limit 10
$$;

revoke execute on function app_private.list_overlay_supporter_ticker(uuid, text) from public;
grant execute on function app_private.list_overlay_supporter_ticker(uuid, text) to bsa_app;

-- mega_tip_banner: the single most recent consented tip at or above a
-- fixed ₹5,000 (500000 paise) floor, landed in the last 15 minutes — a
-- creator-facing threshold/window knob is real future scope (see the
-- delivery report's "Remaining open"), not built here; this is a
-- deliberately simple v1 that never throws and degrades to zero rows
-- (empty banner) the moment nothing qualifies.
create or replace function app_private.list_overlay_mega_tip_banner(target_overlay_id uuid, target_token_fingerprint text)
returns table (display_name text, amount_paise bigint, created_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select coalesce(nullif(event.payload->>'displayName', ''), 'Anonymous'),
         payment.gross_amount_paise,
         event.created_at
    from public.overlay_sessions session
    join public.alert_events event on event.channel_id = session.channel_id and event.source_type = 'payment'
    join public.payments payment on payment.id = event.payment_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and payment.status in ('captured', 'refunded', 'partially_refunded')
     and payment.gross_amount_paise >= 500000
     and event.created_at >= current_timestamp - interval '15 minutes'
   order by event.created_at desc
   limit 1
$$;

revoke execute on function app_private.list_overlay_mega_tip_banner(uuid, text) from public;
grant execute on function app_private.list_overlay_mega_tip_banner(uuid, text) to bsa_app;
