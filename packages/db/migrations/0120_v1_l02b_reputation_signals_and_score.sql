-- L02b: supporter reputation — signals -> score -> action.
--
-- THERE IS NO ABUSE/REPUTATION TRACKING TODAY. The only thing named "abuse"
-- (PublicAbuseGuard, apps/api/src/domain/public-abuse.ts) is a Turnstile
-- CAPTCHA at the moment of payment — bot prevention, not behavioural
-- reputation. This migration is the first reputation surface.
--
-- THE ASYMMETRY THIS SCHEMA IS BUILT AROUND (verified, not designed around
-- an assumption): a BharatStudio tip refund is reconciled on OUR rails
-- (payment-webhook-go against public.payments/public.refunds), so it is
-- fully identified per viewer. A Super Chat refund happens between the
-- viewer and Google — no webhook reaches us, nothing in the chat stream
-- announces it, and YouTube's channel-report refund aggregates carry no
-- payer dimension (verified against Google's own channel-reports docs). We
-- can never build a Super Chat refund signal, at any granularity, for
-- anyone. So refund/chargeback signal_types are constrained BY TABLE CHECK
-- CONSTRAINT (not just application discipline) to source = 'bharatstudio_tip'
-- only, and a refund signal is never stored as a row at all here — it is
-- derived live from public.payments/public.refunds, exactly like migration
-- 0102's support-goal progress, so a reversed refund needs no un-scoring
-- step (see app_private.reputation_signal_evidence below).
--
-- SCORE INTEGRITY: there is no reputation_scores table and no score/verdict
-- column anywhere in this file. app_private.reputation_score() and
-- app_private.reputation_verdict() are STABLE SQL functions computed fresh
-- from reputation_signal_events + payments/refunds on every call — the same
-- discipline 0102 used for support-goal progress. Nothing can "set" a score;
-- the only write surface into the signal history is
-- app_private.record_reputation_signal(), which itself refuses to accept a
-- 'refund' row (see its body) because that signal is never stored.
--
-- CROSS-CREATOR BOUNDARY (master plan Part 11.5, enforced today in
-- packages/db/tests/l14_viewer_identity.sql:109 and l16_security_boundary.sql):
-- a creator must never see another creator's supporter history. Abuse
-- scoring genuinely needs cross-creator signal ("refunds everywhere" is the
-- point of the feature) so this is resolved, not avoided: the SYSTEM
-- (app_private.reputation_score/reputation_verdict/reputation_signal_evidence)
-- is free to read signals across every channel. The CREATOR-facing surface,
-- app_private.get_supporter_reputation_verdict(), returns only
-- (viewer_identity_id, verdict, recommended_action) for a supporter of the
-- CALLER's own channel — never a signal, a source, a channel_id, or a count
-- that would let a creator infer another creator's supporter list.
-- reputation_signal_evidence/reputation_score/reputation_verdict are never
-- granted to bsa_app; only get_supporter_reputation_verdict is.
--
-- DELETION BIND (recorded, not resolved — governance/AGENTS.md forbids a
-- legal conclusion here; see 0085's own header for the same posture). A
-- reputation score attached to a viewer identity is personal data with
-- consequences. If a viewer deletes their account and we retain the score,
-- deletion was not deletion; if we drop it, deletion becomes reputation
-- laundering — a refund-abusing viewer could delete-and-recreate to launder
-- a flagged history. This migration takes the SAME side 0085 already took
-- for creator_supporter_relations (retain the audit/financial aggregate,
-- erase only profile/linkage) so today's behaviour is: reputation_signal_events
-- and the payments/refunds rows the live score reads are retained after
-- deletion, keyed only by the surviving viewer_identity_id (no PII per
-- 0084/0085). Whether THAT is DPDP-compliant, or whether reputation must
-- instead be erased/decayed on deletion, is left OPEN — see the
-- legalDispositionOpen extension below. This is a recorded tension, not an
-- answer.

create table reputation_signal_events (
  id uuid primary key,
  viewer_identity_id uuid not null references viewer_identities(id),
  channel_id uuid not null references channels(id),
  source text not null check (source in ('bharatstudio_tip', 'super_chat')),
  -- 'refund' is deliberately absent from this enum: it is never stored as a
  -- row (see header). Only signal_types a source can actually produce are
  -- representable at all.
  signal_type text not null check (signal_type in ('chargeback', 'velocity_spike', 'content_moderation_strike')),
  severity integer not null default 3 check (severity between 1 and 5),
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp,
  -- Structural (not app-level) enforcement of the per-source asymmetry:
  -- chargeback evidence only exists on our own rails (bharatstudio_tip);
  -- content-moderation strikes here model YouTube chat moderation
  -- (super_chat) — a tip's own message moderation is out of this task's
  -- scope, not smuggled in under this signal_type.
  check (signal_type <> 'chargeback' or source = 'bharatstudio_tip'),
  check (signal_type <> 'content_moderation_strike' or source = 'super_chat')
);

create index reputation_signal_events_viewer_idx on reputation_signal_events (viewer_identity_id, occurred_at desc);
create index reputation_signal_events_channel_idx on reputation_signal_events (channel_id, occurred_at desc);

alter table reputation_signal_events enable row level security;
revoke all on reputation_signal_events from public;
revoke all on reputation_signal_events from bsa_app;
-- No policies, no bsa_app grant: exactly the 0084 pattern — every access
-- path is a security-definer app_private function, never a direct table
-- grant.

-- Writer: the only way a signal row is ever created. Refuses 'refund'
-- outright (that signal is never stored — see header) and re-asserts the
-- per-source constraint in code too, so the error a caller sees is
-- diagnostic even though the table CHECK would also catch it.
create or replace function app_private.record_reputation_signal(
  target_viewer_identity_id uuid,
  target_channel_id uuid,
  target_source text,
  target_signal_type text,
  target_severity integer,
  target_occurred_at timestamptz,
  target_metadata jsonb
)
returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_id uuid := gen_random_uuid();
begin
  if target_signal_type = 'refund' then
    raise exception 'refund signals are derived live from payments/refunds and are never recorded' using errcode = '22023';
  end if;
  if target_signal_type = 'chargeback' and target_source <> 'bharatstudio_tip' then
    raise exception 'chargeback signal is only available for bharatstudio_tip' using errcode = '22023';
  end if;
  if target_signal_type = 'content_moderation_strike' and target_source <> 'super_chat' then
    raise exception 'content moderation signal is only available for super_chat' using errcode = '22023';
  end if;
  insert into reputation_signal_events (
    id, viewer_identity_id, channel_id, source, signal_type, severity, occurred_at, metadata
  ) values (
    new_id, target_viewer_identity_id, target_channel_id, target_source, target_signal_type,
    coalesce(target_severity, 3), target_occurred_at, coalesce(target_metadata, '{}'::jsonb)
  );
  return new_id;
end
$$;

-- SYSTEM-ONLY evidence read: every signal for a viewer, across every
-- channel (cross-creator by design — see header), PLUS the live-derived
-- refund signal for bharatstudio_tip payments (never a stored row — a
-- refund's status flips or reverses in public.refunds itself, so this join
-- always reflects the current truth with no un-scoring step). Never granted
-- to bsa_app: this is the function a creator route must NEVER call.
create or replace function app_private.reputation_signal_evidence(target_viewer_identity_id uuid)
returns table (source text, signal_type text, channel_id uuid, severity integer, occurred_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select 'bharatstudio_tip'::text as source, 'refund'::text as signal_type, p.channel_id, 4 as severity, r.updated_at as occurred_at
    from refunds r
    join payments p on p.id = r.payment_id
   where p.viewer_identity_id = target_viewer_identity_id
     and r.status = 'processed'
  union all
  select rse.source, rse.signal_type, rse.channel_id, rse.severity, rse.occurred_at
    from reputation_signal_events rse
   where rse.viewer_identity_id = target_viewer_identity_id
$$;

-- SYSTEM-ONLY live score. Weighted sum over a 180-day window so an old
-- signal ages out on its own (no sweep job, no un-scoring step — the next
-- read simply excludes it, same as 0102's daily/monthly goal windows).
create or replace function app_private.reputation_score(target_viewer_identity_id uuid)
returns integer
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select coalesce(sum(
    case evidence.signal_type
      when 'refund' then 15
      when 'chargeback' then 25
      when 'velocity_spike' then 5
      when 'content_moderation_strike' then 8
      else 0
    end * evidence.severity
  ), 0)::integer
    from app_private.reputation_signal_evidence(target_viewer_identity_id) evidence
   where evidence.occurred_at > current_timestamp - interval '180 days'
$$;

create or replace function app_private.reputation_verdict(target_viewer_identity_id uuid)
returns text
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select case when app_private.reputation_score(target_viewer_identity_id) >= 60 then 'flagged' else 'clear' end
$$;

-- CREATOR-FACING surface. Structurally cannot leak cross-creator evidence:
-- (1) gated by can_access_channel(target_channel_id) — the caller's own
--     channel only; (2) requires the viewer to actually be a supporter of
--     THAT channel (creator_supporter_relations row must exist) so a
--     creator cannot fish a random viewer_identity_id; (3) the returned
--     columns are exactly (viewer_identity_id, verdict, recommended_action)
--     — no signal_type, source, channel_id or count is ever selected here,
--     so there is no column to leak even by a future careless edit to the
--     SELECT list widening this table shape.
create or replace function app_private.get_supporter_reputation_verdict(target_channel_id uuid, target_viewer_identity_id uuid)
returns table (viewer_identity_id uuid, verdict text, recommended_action text)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select csr.viewer_identity_id,
         app_private.reputation_verdict(csr.viewer_identity_id),
         case when app_private.reputation_verdict(csr.viewer_identity_id) = 'flagged'
              then 'review_before_payout'
              else 'none'
         end
    from creator_supporter_relations csr
   where csr.channel_id = target_channel_id
     and csr.viewer_identity_id = target_viewer_identity_id
     and app_private.can_access_channel(target_channel_id)
$$;

revoke execute on function app_private.record_reputation_signal(uuid, uuid, text, text, integer, timestamptz, jsonb) from public;
revoke execute on function app_private.reputation_signal_evidence(uuid) from public;
revoke execute on function app_private.reputation_score(uuid) from public;
revoke execute on function app_private.reputation_verdict(uuid) from public;
revoke execute on function app_private.get_supporter_reputation_verdict(uuid, uuid) from public;

-- Signal recording is a backend/system concern (payment-webhook-go for
-- chargebacks on bharatstudio_tip today; a future YouTube moderation/velocity
-- ingestion path for super_chat — not owned by this migration, see
-- "Remaining open"), not a creator HTTP capability, so it is granted to
-- bsa_payment (the existing reconciliation role, 0111) and deliberately NOT
-- to bsa_app.
grant execute on function app_private.record_reputation_signal(uuid, uuid, text, text, integer, timestamptz, jsonb) to bsa_payment;

-- Only the verdict-only surface reaches the app role a creator route runs
-- under. reputation_signal_evidence/reputation_score/reputation_verdict are
-- intentionally never granted to bsa_app.
grant execute on function app_private.get_supporter_reputation_verdict(uuid, uuid) to bsa_app;

-- Extend 0085's deletion erasure record with the reputation open question,
-- per this task's explicit instruction. Body is otherwise identical to
-- 0085/current — only the jsonb 'retained' array and legalDispositionOpen
-- annotation change.
create or replace function app_private.request_viewer_account_deletion(target_viewer_account_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  record_id uuid := gen_random_uuid();
  erasure jsonb;
begin
  if target_viewer_account_id <> app_private.current_viewer_id() then
    raise exception 'viewer deletion access denied' using errcode = '42501';
  end if;
  update viewer_accounts
     set email = null, password_hash = null, display_name = null,
         profile_visibility = 'private', profile_slug = null,
         closed_at = coalesce(closed_at, current_timestamp),
         updated_at = current_timestamp
   where id = target_viewer_account_id;
  update viewer_sessions set revoked_at = current_timestamp
   where viewer_account_id = target_viewer_account_id and revoked_at is null;
  erasure := jsonb_build_object(
    'schemaVersion', 'v1',
    'erased', jsonb_build_array('email', 'password_hash', 'display_name', 'profile_visibility_reset_to_private', 'profile_slug', 'active_sessions'),
    'retained', jsonb_build_array(
      'payments (financial record)', 'refunds (financial record)', 'creator_supporter_relations (financial/audit aggregate)',
      'viewer_identities row id (audit linkage only, no PII)',
      'reputation_signal_events (audit-adjacent, retained the same way as creator_supporter_relations; the live reputation_score/verdict derived from it also survives deletion because it is computed from this retained data — see 0120 header for why this is NOT asserted here to be DPDP-compliant)'
    ),
    'legalDispositionOpen', true
  );
  insert into viewer_deletion_requests (id, viewer_account_id, erasure_record)
  values (record_id, target_viewer_account_id, erasure);
  return erasure;
end
$$;

revoke execute on function app_private.request_viewer_account_deletion(uuid) from public;
grant execute on function app_private.request_viewer_account_deletion(uuid) to bsa_app;
