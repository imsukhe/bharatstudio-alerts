-- L16c (owner decision 2026-09-13): Super Chats and other external support
-- must count toward widgets alongside BharatStudio tips. Aggregation across
-- sources IS the product — one overlay instead of four. Display is GROSS
-- throughout (Razorpay's 2-3% MDR is already not netted out anywhere in
-- this schema, so a Super Chat's platform cut is not netted out either).
--
-- THE CONSTRAINT THAT SHAPES THIS FILE: progress is derived, never stored
-- (0102/0105/0108/0109's rule, unchanged). This migration does not add a
-- counter anywhere. It adds a second, structurally identical evidence
-- ledger for money that never moved through our rails, and rewrites the
-- derivation to UNION over both ledgers.
--
-- WHY NOT A SYNTHETIC public.payments ROW: payments means "money that moved
-- through our rails" — it is the ledger reconciliation reads, the table the
-- refund-failure metric keys off, and the table webhook dedup keys off
-- (unique (provider, provider_payment_id), 0001). A Super Chat's money
-- settles on YouTube, never touches Razorpay, and BharatStudio never holds
-- or moves it. Inserting a payments row for it would make every one of
-- those systems believe money moved through our rails that did not.
-- external_contributions is deliberately NOT a payments-compatible shape —
-- it has no provider/provider_order_id, cannot satisfy any payments check
-- constraint, and cannot be joined into reconciliation by accident.
--
-- REFUNDS VS REVERSALS: BharatStudio cannot issue a refund (master plan
-- 3.15) and, symmetrically, cannot issue a Super Chat reversal either — it
-- cannot reach into YouTube's ledger at all. A "reversal" here is a fact
-- ingested from upstream (however the connector observes it), landed in
-- external_contribution_reversals exactly the way a processed refund lands
-- in public.refunds: an append-only, insert-only record with no un-award
-- step anywhere, because the union sum below nets it out on the very next
-- read. There is no "reversal.status" state machine, no button that issues
-- one, no code path of ours that ever produces one.
--
-- CURRENCY: youtube-live-event.ts's own header is explicit that
-- payload.amountMinorUnits is "the platform's own reported figure, in that
-- platform's currency's minor unit ... never BharatStudio-INR paise". For
-- an INR Super Chat, the minor unit already IS paise (100 minor units = 1
-- rupee, identically to payments.gross_amount_paise) — a direct unit
-- equality, not a conversion. For any other currency there is no rate
-- anywhere in this codebase to convert with, and inventing one would be
-- exactly the fabricated-and-presented-as-fact arithmetic the source-
-- inclusion design below refuses to do for a platform-cut percentage. So:
-- ONLY currency = 'INR' Super Chats become an external_contributions row.
-- A non-INR Super Chat still gets its alert (unchanged), just never a
-- contribution — see "Remaining open" in the delivery report.
--
-- SOURCE INCLUSION, INCLUDE/EXCLUDE ONLY: contribution_source_inclusions
-- lets a creator turn a source off for one goal/challenge/hype-mode
-- definition. No percentage/multiplier column exists or is ever read by
-- any function below — there is nowhere in this schema to put "count
-- Super Chat at 70%", on purpose. Missing row = included (aggregation is
-- the default and the point).
--
-- SCOPE — NOT EXTENDED IN THIS MIGRATION: support_vote_tally (free,
-- headcount only — not money at all, untouched) and paid_support_vote_
-- tally/channel_leaderboard (0108/0105) are NOT unioned with external
-- contributions here. A paid vote tally is inherently per-OPTION and a
-- leaderboard is inherently per-VIEWER; a Super Chat carries no option tag
-- (there is no checkout flow for it to be tagged at) and, for almost every
-- Super Chatter, no resolvable viewer_identity_id.
--
-- CORRECTED 2026-09-13. An earlier draft of this comment said a YouTube
-- channel id is "a different identity space with no mapping table anywhere
-- in this schema". That is wrong: 0084 created viewer_platform_identities,
-- unique on (provider, provider_user_id) with provider constrained to
-- 'youtube', precisely so a YouTube channel id CAN resolve to a
-- viewer_identity_id. The conclusion below is unchanged, but the real
-- reason matters for anyone deciding later whether to revisit it:
--
-- that mapping row only exists once a viewer has CLAIMED their platform
-- identity by linking it to a BharatStudio viewer account (0107's
-- claim_platform_identity). An unclaimed YouTube channel id — which is the
-- overwhelming majority of Super Chatters, since claiming requires them to
-- sign up for a product they have never heard of — has no row and therefore
-- no identity to attribute to.
--
-- So leaderboard attribution is not impossible, it is sparse: it would work
-- for the small claimed minority and silently omit everyone else, which is
-- worse than omitting the source entirely because it would look complete.
-- If claim rates ever become high this is worth revisiting, and the join
-- already exists to do it.
--
-- Fabricating either attribution would be the same category of error the
-- MDR-percentage refusal above is about — presenting an invented link as
-- fact. Left unchanged; recorded under "Remaining open".
--
-- PROVENANCE DISCIPLINE, mirroring 0091's precedent exactly: a partial
-- unique index on (channel_id, source_type, source_id) is the idempotency
-- guarantee for external_contributions, the same shape 0091 built for
-- alert_events' external connector rows and for the same reason (a
-- database-level guarantee, not only a writer-side check).
--
-- ROLLBACK: additive only. Two new tables carrying money facts
-- (external_contributions, external_contribution_reversals), one config
-- table (contribution_source_inclusions), and CREATE OR REPLACE on five
-- existing functions (support_goal_progress_paise, challenge_progress_
-- paise, hype_mode_state, record_youtube_alert_event — same signature,
-- extended body — and none of paid_support_vote_tally/channel_leaderboard/
-- support_vote_tally, which are explicitly untouched). No ALTER TABLE on
-- payments, refunds, alert_events, support_goals, challenges, or
-- interaction_definitions. Feature-flagging this off (source inclusion
-- rows all default-included, no new external_contributions rows ingested)
-- returns every rewritten function to its pre-0117 payments-only value.

-- =========================================================================
-- 1. external_contributions — the external-money evidence ledger.
-- =========================================================================
create table public.external_contributions (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  source_type text not null check (source_type in ('youtube_superchat')),
  -- Upstream event id (e.g. a YouTube live-chat superChatEvent message id).
  -- Idempotency key, same role source_id plays in alert_events for a
  -- connector row (0091).
  source_id text not null check (char_length(source_id) between 1 and 200),
  -- Provenance link to the alert this contribution rode in on. Nullable so
  -- a future ingestion path that never produces an alert is not blocked,
  -- but every YouTube ingestion in THIS migration always sets it.
  alert_event_id uuid references public.alert_events(id),
  gross_amount_paise bigint not null check (gross_amount_paise >= 1),
  -- Always 'INR' as written by this migration's ingestion path (see file
  -- header). Column kept general, not hardcoded, so a future currency with
  -- a real conversion source does not need a table rebuild.
  source_currency text not null check (source_currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default current_timestamp
);

create unique index external_contributions_source_unique
  on public.external_contributions (channel_id, source_type, source_id);

create index external_contributions_channel_created_idx
  on public.external_contributions (channel_id, created_at);

alter table public.external_contributions enable row level security;
revoke all on public.external_contributions from public;
revoke all on public.external_contributions from bsa_app;

-- =========================================================================
-- 2. external_contribution_reversals — an OBSERVED fact, never an action of
--    ours. See file header. Append-only; no update/delete grant is ever
--    issued to any role.
-- =========================================================================
create table public.external_contribution_reversals (
  id uuid primary key,
  external_contribution_id uuid not null references public.external_contributions(id),
  -- Upstream idempotency key for the reversal observation itself, so the
  -- same observed reversal ingested twice (a retried webhook/poll) is a
  -- no-op, not a double deduction. Distinct from source_id above, which
  -- identifies the original contribution, not its reversal.
  reversal_source_id text not null check (char_length(reversal_source_id) between 1 and 200),
  amount_paise bigint not null check (amount_paise >= 1),
  reason text check (reason is null or char_length(reason) <= 500),
  observed_at timestamptz not null default current_timestamp
);

create unique index external_contribution_reversals_source_unique
  on public.external_contribution_reversals (external_contribution_id, reversal_source_id);

create index external_contribution_reversals_contribution_idx
  on public.external_contribution_reversals (external_contribution_id);

alter table public.external_contribution_reversals enable row level security;
revoke all on public.external_contribution_reversals from public;
revoke all on public.external_contribution_reversals from bsa_app;

-- =========================================================================
-- 3. contribution_source_inclusions — per-target include/exclude only. No
--    multiplier/percentage column exists here or anywhere else in this
--    file — see file header. Missing row = included.
-- =========================================================================
create table public.contribution_source_inclusions (
  id uuid primary key,
  target_type text not null check (target_type in ('goal', 'challenge', 'interaction_definition')),
  target_id uuid not null,
  source_type text not null check (source_type in ('payment', 'youtube_superchat')),
  included boolean not null default true,
  updated_at timestamptz not null default current_timestamp,
  unique (target_type, target_id, source_type)
);

alter table public.contribution_source_inclusions enable row level security;
revoke all on public.contribution_source_inclusions from public;
revoke all on public.contribution_source_inclusions from bsa_app;

-- =========================================================================
-- 4. Helpers.
-- =========================================================================

-- Default-included: a missing row means "count this source", because
-- aggregation is the default and the point (owner decision, file header).
create or replace function app_private.contribution_source_included(
  target_target_type text,
  target_target_id uuid,
  target_source_type text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select coalesce(
    (select included from public.contribution_source_inclusions
      where target_type = target_target_type and target_id = target_target_id and source_type = target_source_type),
    true
  )
$$;

revoke execute on function app_private.contribution_source_included(text, uuid, text) from public;
grant execute on function app_private.contribution_source_included(text, uuid, text) to bsa_app;

-- Resolves the owning channel for a source-inclusion target, so the setter
-- below can role-check against the channel the caller claims, not merely
-- the raw target id (a caller cannot toggle a source on a goal it does not
-- name the correct channel_id for).
create or replace function app_private.contribution_target_channel(
  target_target_type text,
  target_target_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select case target_target_type
    when 'goal' then (select channel_id from public.support_goals where id = target_target_id)
    when 'challenge' then (select channel_id from public.challenges where id = target_target_id)
    when 'interaction_definition' then (select channel_id from public.interaction_definitions where id = target_target_id)
    else null
  end
$$;

revoke execute on function app_private.contribution_target_channel(text, uuid) from public;
grant execute on function app_private.contribution_target_channel(text, uuid) to bsa_app;

-- The only write path for source inclusion. owner/admin only, and only for
-- the channel that actually owns the target (contribution_target_channel
-- above), the same "resolve, then compare" shape 0109's transition_challenge
-- uses for its own channel-scoped writes.
create or replace function app_private.set_contribution_source_inclusion(
  target_channel_id uuid,
  target_target_type text,
  target_target_id uuid,
  target_source_type text,
  target_included boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  owning_channel uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s contribution sources' using errcode = '42501';
  end if;

  if target_target_type not in ('goal', 'challenge', 'interaction_definition')
     or target_source_type not in ('payment', 'youtube_superchat') then
    raise exception 'invalid contribution source inclusion' using errcode = '22023';
  end if;

  owning_channel := app_private.contribution_target_channel(target_target_type, target_target_id);
  if owning_channel is null or owning_channel <> target_channel_id then
    raise exception 'target not found on this channel' using errcode = 'P0002';
  end if;

  insert into public.contribution_source_inclusions (id, target_type, target_id, source_type, included, updated_at)
  values (gen_random_uuid(), target_target_type, target_target_id, target_source_type, target_included, current_timestamp)
  on conflict (target_type, target_id, source_type)
    do update set included = excluded.included, updated_at = current_timestamp;
end
$$;

revoke execute on function app_private.set_contribution_source_inclusion(uuid, text, uuid, text, boolean) from public;
grant execute on function app_private.set_contribution_source_inclusion(uuid, text, uuid, text, boolean) to bsa_app;

-- Dashboard read: the resolved (default-applied) state for every known
-- source, not merely the override rows that happen to exist, so a creator
-- always sees a complete, correct-by-default picture.
create or replace function app_private.list_contribution_source_inclusions(
  target_channel_id uuid,
  target_target_type text,
  target_target_id uuid
)
returns table (source_type text, included boolean)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select s.source_type, app_private.contribution_source_included(target_target_type, target_target_id, s.source_type)
    from unnest(array['payment', 'youtube_superchat']) as s(source_type)
   where app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
     and app_private.contribution_target_channel(target_target_type, target_target_id) = target_channel_id
$$;

revoke execute on function app_private.list_contribution_source_inclusions(uuid, text, uuid) from public;
grant execute on function app_private.list_contribution_source_inclusions(uuid, text, uuid) to bsa_app;

-- =========================================================================
-- 5. Ingestion for external reversals — an OBSERVED fact only (file
--    header). Granted to bsa_connector_poller: the same least-privilege
--    role 0091/0094 built for the YouTube path, used here for the only
--    other write this migration lets that role make.
-- =========================================================================
create or replace function app_private.record_external_contribution_reversal(
  target_id uuid,
  target_channel_id uuid,
  target_source_type text,
  target_source_id text,
  target_reversal_source_id text,
  target_amount_paise bigint,
  target_reason text
)
returns table (reversal_id uuid, inserted boolean)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  contribution public.external_contributions%rowtype;
  local_id uuid;
begin
  if target_id is null or target_channel_id is null or target_source_type is null
     or target_source_id is null or target_reversal_source_id is null
     or target_amount_paise is null or target_amount_paise < 1 then
    raise exception 'invalid external contribution reversal' using errcode = '22023';
  end if;

  select * into contribution from public.external_contributions
   where channel_id = target_channel_id and source_type = target_source_type and source_id = target_source_id;
  if not found then
    raise exception 'external contribution not found for reversal' using errcode = 'P0002';
  end if;

  insert into public.external_contribution_reversals (id, external_contribution_id, reversal_source_id, amount_paise, reason, observed_at)
  values (target_id, contribution.id, target_reversal_source_id, target_amount_paise, target_reason, current_timestamp)
  on conflict (external_contribution_id, reversal_source_id) do nothing
  returning id into local_id;

  if local_id is null then
    select id into local_id from public.external_contribution_reversals
     where external_contribution_id = contribution.id and reversal_source_id = target_reversal_source_id;
    return query select local_id, false;
    return;
  end if;

  return query select local_id, true;
end
$$;

revoke execute on function app_private.record_external_contribution_reversal(uuid, uuid, text, text, text, bigint, text) from public;
grant execute on function app_private.record_external_contribution_reversal(uuid, uuid, text, text, text, bigint, text) to bsa_connector_poller;

-- =========================================================================
-- 6. Extend the YouTube delivery path (0094) — NOT a parallel pipeline.
--    Same signature, same name, only the body grows: after a genuinely new
--    alert_events row is inserted (not on a duplicate replay), a
--    currency='INR' Super Chat also gets an external_contributions row,
--    idempotent on the same partial unique index pattern 0091/this file
--    both use. Every other event type / non-INR currency is completely
--    unaffected: the alert insert, dedup, and delivery-routing behaviour
--    this function already had are untouched.
-- =========================================================================
create or replace function app_private.record_youtube_alert_event(
  target_event_id uuid,
  target_outbox_id uuid,
  target_channel_id uuid,
  target_source_id text,
  target_source_event_type text,
  target_source_user_id text,
  target_trace_id text,
  target_config_snapshot_version bigint,
  target_payload jsonb
)
returns table (event_id uuid, inserted boolean, delivery_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  local_event_id uuid;
  local_delivery_count integer := 0;
  selected_binding record;
  contribution_amount bigint;
  contribution_currency text;
begin
  if target_event_id is null or target_outbox_id is null or target_channel_id is null
     or target_source_id is null or length(target_source_id) = 0 then
    raise exception 'invalid youtube alert event' using errcode = '22023';
  end if;

  insert into public.alert_events (
    id, channel_id, payment_id, source_type, source_id,
    source_event_type, source_user_id,
    trace_id, config_snapshot_version, payload, created_at
  )
  values (
    target_event_id, target_channel_id, null, 'youtube', target_source_id,
    target_source_event_type, target_source_user_id,
    target_trace_id, target_config_snapshot_version, target_payload, current_timestamp
  )
  on conflict (channel_id, source_type, source_id)
    where source_type in ('youtube', 'twitch', 'kick')
  do nothing
  returning id into local_event_id;

  if local_event_id is null then
    select id into local_event_id
      from public.alert_events
     where channel_id = target_channel_id and source_type = 'youtube' and source_id = target_source_id;
    return query select local_event_id, false, 0;
    return;
  end if;

  -- L16c addition: a genuinely new Super Chat, reported in INR, also
  -- becomes an external_contributions row. See file header for why only
  -- INR is accepted (minor unit = paise, no conversion invented) and why
  -- every other event type/currency is left exactly as before (alert only,
  -- no contribution — a real, documented gap, not a silent drop: it never
  -- raises, it simply does not insert).
  if target_source_event_type = 'youtube.super_chat' then
    contribution_currency := upper(target_payload->>'currency');
    if contribution_currency = 'INR' and (target_payload->>'amountMinorUnits') is not null then
      contribution_amount := (target_payload->>'amountMinorUnits')::bigint;
      if contribution_amount >= 1 then
        insert into public.external_contributions (
          id, channel_id, source_type, source_id, alert_event_id, gross_amount_paise, source_currency, created_at
        )
        values (
          gen_random_uuid(), target_channel_id, 'youtube_superchat', target_source_id, local_event_id,
          contribution_amount, 'INR', current_timestamp
        )
        on conflict (channel_id, source_type, source_id) do nothing;
      end if;
    end if;
  end if;

  insert into public.event_outbox (id, event_id, status, available_at, created_at, updated_at)
  values (target_outbox_id, local_event_id, 'pending', current_timestamp, current_timestamp, current_timestamp);

  for selected_binding in
    select binding.id as binding_id,
           binding.queue_id as queue_id,
           binding.priority as source_priority,
           coalesce(binding.override_values, '{}'::jsonb) as override_values,
           binding.created_at as created_at
      from public.queue_bindings binding
     where binding.channel_id = target_channel_id
       and binding.closed_at is null
       and binding.source_type = 'youtube'
       and binding.source_id in (target_source_id, '__channel_default__')
       and not (
         binding.source_id = '__channel_default__'
         and exists (
           select 1
             from public.queue_bindings exact_binding
            where exact_binding.channel_id = target_channel_id
              and exact_binding.closed_at is null
              and exact_binding.source_type = 'youtube'
              and exact_binding.source_id = target_source_id
              and exact_binding.queue_id = binding.queue_id
         )
       )
     order by binding.priority desc, binding.created_at asc, binding.id asc
  loop
    local_delivery_count := local_delivery_count + 1;
    insert into public.event_outbox_deliveries (
      id, event_id, outbox_id, queue_id, binding_id, source_id,
      config_snapshot_version, delivery_sequence, source_priority, override_values,
      status, attempt_count, created_at, updated_at
    )
    values (
      md5('youtube-delivery:' || local_event_id::text || ':' || selected_binding.queue_id::text)::uuid,
      local_event_id, target_outbox_id, selected_binding.queue_id, selected_binding.binding_id, target_source_id,
      target_config_snapshot_version, local_delivery_count, selected_binding.source_priority, selected_binding.override_values,
      'ready', 0, current_timestamp, current_timestamp
    );
  end loop;

  if local_delivery_count = 0 then
    update public.event_outbox
       set status = 'quarantined', updated_at = current_timestamp
     where id = target_outbox_id;
  end if;

  return query select local_event_id, true, local_delivery_count;
end
$$;

revoke execute on function app_private.record_youtube_alert_event(uuid, uuid, uuid, text, text, text, text, bigint, jsonb) from public;
grant execute on function app_private.record_youtube_alert_event(uuid, uuid, uuid, text, text, text, text, bigint, jsonb) to bsa_connector_poller;

-- =========================================================================
-- 7. Rewrite the progress functions to UNION (payments - refunds) with
--    (external_contributions - external_contribution_reversals), gated
--    per-source by contribution_source_included. Same signature, same
--    "PROGRESS IS NEVER STORED" property, same greatest(...,0) defensive
--    floor as every function being replaced already had.
-- =========================================================================

create or replace function app_private.support_goal_progress_paise(target_goal_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  goal public.support_goals%rowtype;
  window_start timestamptz;
  window_end timestamptz;
  payment_net bigint := 0;
  external_net bigint := 0;
begin
  select * into goal from public.support_goals where id = target_goal_id;
  if not found then
    return 0;
  end if;

  case goal.goal_window
    when 'daily' then
      window_start := greatest(goal.started_at, date_trunc('day', current_timestamp));
      window_end := date_trunc('day', current_timestamp) + interval '1 day';
    when 'monthly' then
      window_start := greatest(goal.started_at, date_trunc('month', current_timestamp));
      window_end := date_trunc('month', current_timestamp) + interval '1 month';
    else
      window_start := goal.started_at;
      window_end := 'infinity'::timestamptz;
  end case;

  if goal.ended_at is not null then
    window_end := least(window_end, goal.ended_at);
  end if;

  if app_private.contribution_source_included('goal', target_goal_id, 'payment') then
    select coalesce(sum(payment.gross_amount_paise), 0) - coalesce((
      select sum(refund.amount_paise)
        from public.refunds refund
        join public.payments refunded_payment on refunded_payment.id = refund.payment_id
       where refunded_payment.channel_id = goal.channel_id
         and refund.status = 'processed'
         and refunded_payment.created_at >= window_start
         and refunded_payment.created_at < window_end
    ), 0)
      into payment_net
      from public.payments payment
     where payment.channel_id = goal.channel_id
       and payment.status in ('captured', 'refunded', 'partially_refunded')
       and payment.created_at >= window_start
       and payment.created_at < window_end;
  end if;

  if app_private.contribution_source_included('goal', target_goal_id, 'youtube_superchat') then
    select coalesce(sum(contribution.gross_amount_paise), 0) - coalesce((
      select sum(reversal.amount_paise)
        from public.external_contribution_reversals reversal
        join public.external_contributions reversed_contribution on reversed_contribution.id = reversal.external_contribution_id
       where reversed_contribution.channel_id = goal.channel_id
         and reversed_contribution.created_at >= window_start
         and reversed_contribution.created_at < window_end
    ), 0)
      into external_net
      from public.external_contributions contribution
     where contribution.channel_id = goal.channel_id
       and contribution.created_at >= window_start
       and contribution.created_at < window_end;
  end if;

  return greatest(coalesce(payment_net, 0) + coalesce(external_net, 0), 0);
end
$$;

revoke execute on function app_private.support_goal_progress_paise(uuid) from public;
grant execute on function app_private.support_goal_progress_paise(uuid) to bsa_app;

create or replace function app_private.challenge_progress_paise(target_challenge_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  challenge public.challenges%rowtype;
  window_end timestamptz;
  payment_net bigint := 0;
  external_net bigint := 0;
begin
  select * into challenge from public.challenges where id = target_challenge_id;
  if not found or challenge.started_at is null then
    return 0;
  end if;

  window_end := coalesce(challenge.ended_at, 'infinity'::timestamptz);

  if app_private.contribution_source_included('challenge', target_challenge_id, 'payment') then
    select coalesce(sum(payment.gross_amount_paise), 0) - coalesce((
      select sum(refund.amount_paise)
        from public.refunds refund
        join public.payments refunded_payment on refunded_payment.id = refund.payment_id
       where refunded_payment.channel_id = challenge.channel_id
         and refund.status = 'processed'
         and refunded_payment.created_at >= challenge.started_at
         and refunded_payment.created_at < window_end
    ), 0)
      into payment_net
      from public.payments payment
     where payment.channel_id = challenge.channel_id
       and payment.status in ('captured', 'refunded', 'partially_refunded')
       and payment.created_at >= challenge.started_at
       and payment.created_at < window_end;
  end if;

  if app_private.contribution_source_included('challenge', target_challenge_id, 'youtube_superchat') then
    select coalesce(sum(contribution.gross_amount_paise), 0) - coalesce((
      select sum(reversal.amount_paise)
        from public.external_contribution_reversals reversal
        join public.external_contributions reversed_contribution on reversed_contribution.id = reversal.external_contribution_id
       where reversed_contribution.channel_id = challenge.channel_id
         and reversed_contribution.created_at >= challenge.started_at
         and reversed_contribution.created_at < window_end
    ), 0)
      into external_net
      from public.external_contributions contribution
     where contribution.channel_id = challenge.channel_id
       and contribution.created_at >= challenge.started_at
       and contribution.created_at < window_end;
  end if;

  return greatest(coalesce(payment_net, 0) + coalesce(external_net, 0), 0);
end
$$;

revoke execute on function app_private.challenge_progress_paise(uuid) from public;
grant execute on function app_private.challenge_progress_paise(uuid) to bsa_app;

create or replace function app_private.hype_mode_state(target_definition_id uuid)
returns table (meter_paise bigint, threshold_paise bigint, reached boolean, started_at timestamptz, ends_at timestamptz, ended boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  def public.interaction_definitions%rowtype;
  activation public.hype_mode_activations%rowtype;
  window_end timestamptz;
  decay_seconds numeric;
  threshold bigint;
  payment_net numeric := 0;
  external_net numeric := 0;
begin
  select * into def from public.interaction_definitions where id = target_definition_id and interaction_type = 'hype_mode';
  if not found then
    return;
  end if;

  select * into activation from public.hype_mode_activations
   where interaction_definition_id = target_definition_id
   order by started_at desc
   limit 1;
  if not found then
    return;
  end if;

  decay_seconds := greatest((def.config->>'decaySeconds')::numeric, 1);
  threshold := (def.config->>'thresholdPaise')::bigint;
  window_end := least(current_timestamp, activation.ends_at);
  if activation.ended_at is not null then
    window_end := least(window_end, activation.ended_at);
  end if;

  if app_private.contribution_source_included('interaction_definition', target_definition_id, 'payment') then
    select coalesce(sum(
             greatest(0, (payment.gross_amount_paise - coalesce(refunded.amount_paise, 0))
               * greatest(0, 1 - extract(epoch from (window_end - payment.created_at)) / decay_seconds))
           ), 0)
      into payment_net
      from public.payments payment
      left join (
        select refund.payment_id, sum(refund.amount_paise) as amount_paise
          from public.refunds refund
         where refund.status = 'processed'
         group by refund.payment_id
      ) refunded on refunded.payment_id = payment.id
     where payment.channel_id = activation.channel_id
       and payment.status in ('captured', 'refunded', 'partially_refunded')
       and payment.created_at >= activation.started_at
       and payment.created_at <= window_end;
  end if;

  if app_private.contribution_source_included('interaction_definition', target_definition_id, 'youtube_superchat') then
    select coalesce(sum(
             greatest(0, (contribution.gross_amount_paise - coalesce(reversed.amount_paise, 0))
               * greatest(0, 1 - extract(epoch from (window_end - contribution.created_at)) / decay_seconds))
           ), 0)
      into external_net
      from public.external_contributions contribution
      left join (
        select reversal.external_contribution_id, sum(reversal.amount_paise) as amount_paise
          from public.external_contribution_reversals reversal
         group by reversal.external_contribution_id
      ) reversed on reversed.external_contribution_id = contribution.id
     where contribution.channel_id = activation.channel_id
       and contribution.created_at >= activation.started_at
       and contribution.created_at <= window_end;
  end if;

  return query select
    greatest(round(coalesce(payment_net, 0) + coalesce(external_net, 0))::bigint, 0),
    threshold,
    round(coalesce(payment_net, 0) + coalesce(external_net, 0))::bigint >= threshold,
    activation.started_at,
    activation.ends_at,
    (activation.ended_at is not null or current_timestamp >= activation.ends_at);
end
$$;

revoke execute on function app_private.hype_mode_state(uuid) from public;
grant execute on function app_private.hype_mode_state(uuid) to bsa_app;
