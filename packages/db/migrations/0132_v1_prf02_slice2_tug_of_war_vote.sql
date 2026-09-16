-- PRF-02 slice 2, module #3: Tug-of-War Vote. §6: "Two-sided transparent
-- result bar." This migration adds exactly one function and no table, no
-- event type, and no second progress computation -- it is a read over
-- data that already exists (interaction_definitions/interaction_vote_
-- options, vote_payment_tags, payments/refunds -- all from 0105/0108) and
-- reuses app_private.paid_support_vote_tally's/list_overlay_paid_vote_
-- tally's exact money-derived-tally math (0108), not a reimplementation.
--
-- WHY A NEW FUNCTION AND NOT JUST A NEW ROUTE CALLING THE EXISTING ONE:
-- list_overlay_paid_vote_tally (0108) takes a target_definition_id -- the
-- creator picks which paid vote a given standalone OBS widget source
-- shows, at the time they add that browser-source URL. Master Canvas
-- (PRF-02) modules have no per-module configuration surface yet (the
-- canvas designer UI is explicitly out of scope, per PRF-02.md's
-- boundaries) -- a module is only ever entitled on/off, never given a
-- definitionId. The existing Community Goal Ladder module resolves this
-- identically: list_overlay_goal (0102) takes no goal id, it resolves
-- "the" goal for the channel itself (is_public, not ended, most recently
-- started). This function is that same resolution rule applied to a paid,
-- two-option support_vote, so the Tug-of-War module can be entitled the
-- same way every other module is, with no config step this slice does
-- not have anywhere to put.
--
-- RESOLUTION RULE, stated plainly because no authority states one and it
-- is therefore this migration's own scoping decision (recorded again in
-- reviews/2026-09-16-prf-02-slice-2-implementation.md):
--   - Eligible definitions: interaction_type = 'support_vote',
--     is_enabled, config->>'votingMode' = 'paid', and EXACTLY TWO options
--     (interaction_vote_options rows) -- "two-sided" is enforced here,
--     not left to the renderer to assume.
--   - Prefer an OPEN vote (closed_at is null) over a closed one, so a
--     result bar does not vanish mid-broadcast the instant the creator
--     resolves it -- the resolved state (already computed by the same
--     "resolved"/"resolved_option_key" columns 0108 defined) is exactly
--     what "transparent" requires a viewer to still be able to see.
--   - Among ties, the most recently touched one wins: closed_at for a
--     closed definition, created_at for an open one -- the same
--     "order by the one timestamp that already exists" posture 0131 used
--     for the module cap's downgrade tiebreak, not an invented rank.
--
-- MONEY-DERIVED, NEVER STORED (§19.6, §12.7, this task's §1(b)): every
-- amount below is summed live from public.payments/public.refunds via
-- public.vote_payment_tags on every read, byte-for-byte the same join
-- 0108's paid_support_vote_tally/list_overlay_paid_vote_tally already use
-- -- this function only adds the "which definition" resolution in front
-- of that existing, unmodified computation. There is no new counter
-- anywhere in this migration for a divergent value to live in.
--
-- ROLLBACK: additive only -- one new function, no table, no column, no
-- trigger. Dropping it removes the Tug-of-War overlay read only; the
-- underlying paid-vote tables/functions (0105, 0108) are untouched and
-- every other paid-vote consumer (dashboard tally, standalone OBS widget)
-- keeps working. No production migration without separate explicit
-- approval.

create or replace function app_private.list_overlay_tug_of_war_vote(
  target_overlay_id uuid,
  target_token_fingerprint text
)
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
  eligible as (
    select def.id, def.closed_at, def.created_at
      from public.interaction_definitions def
      join scoped_channel sc on sc.channel_id = def.channel_id
     where def.interaction_type = 'support_vote'
       and def.is_enabled
       and def.config->>'votingMode' = 'paid'
       and (
         select count(*) from public.interaction_vote_options opt
          where opt.interaction_definition_id = def.id
       ) = 2
  ),
  active_definition as (
    select id from eligible
     order by (closed_at is null) desc, coalesce(closed_at, created_at) desc
     limit 1
  ),
  tag_amounts as (
    select tag.option_key,
           greatest(payment.gross_amount_paise - coalesce(refunded.amount_paise, 0), 0) as net_paise
      from public.vote_payment_tags tag
      join scoped_channel sc on sc.channel_id = tag.channel_id
      join active_definition ad on ad.id = tag.interaction_definition_id
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
     where payment.status in ('captured', 'refunded', 'partially_refunded')
  ),
  tallies as (
    select opt.option_key, opt.label, coalesce(sum(ta.net_paise), 0) as amount_paise
      from public.interaction_vote_options opt
      join active_definition ad on ad.id = opt.interaction_definition_id
      left join tag_amounts ta on ta.option_key = opt.option_key
     group by opt.option_key, opt.label
  ),
  winner as (
    select option_key from tallies order by amount_paise desc, option_key asc limit 1
  ),
  is_closed as (
    select ad.id is not null and def.closed_at is not null as closed
      from active_definition ad
      join public.interaction_definitions def on def.id = ad.id
  )
  select t.option_key, t.label, t.amount_paise,
         coalesce((select closed from is_closed), false) as resolved,
         case when coalesce((select closed from is_closed), false) and exists (select 1 from tallies where amount_paise > 0)
              then (select option_key from winner) else null end as resolved_option_key
    from tallies t
   order by t.amount_paise desc, t.option_key asc
$$;

revoke execute on function app_private.list_overlay_tug_of_war_vote(uuid, text) from public;
grant execute on function app_private.list_overlay_tug_of_war_vote(uuid, text) to bsa_app;
