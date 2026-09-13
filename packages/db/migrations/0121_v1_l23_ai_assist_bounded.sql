-- L23: AI assist, bounded (master plan Part 6 "L23 — AI assist, bounded";
-- also appears verbatim as a one-page summary directly above L24). Authority
-- quote: "AI must never autonomously: capture money, refund, change payment
-- destinations, mark a challenge complete, or create a financial obligation
-- without explicit human confirmation."
--
-- THE WORD THAT MATTERS IS "BOUNDED". This migration adds exactly two
-- tables and they hold exactly one kind of fact each:
--   assist_suggestions   — a proposal object. Never an action.
--   assist_confirmations — a human decision on a proposal, recorded before
--                          anything downstream ever reads it as "accepted".
--
-- THE BOUND, load-bearing and testable: deciding a suggestion (accept or
-- reject) does nothing but flip assist_suggestions.status and insert one
-- assist_confirmations row. It never writes to public.payments,
-- public.refunds, public.channel_payment_accounts, public.challenges, or
-- any other financially- or stream-state-consequential table. Applying an
-- accepted suggestion to a live surface (alert style config, challenge
-- copy, a queue's live config, a moderation action) is a SEPARATE, later,
-- human action through the product's *existing* creator flows (channel
-- config PATCH, challenge authoring, the existing moderation endpoint) —
-- this migration adds no new write path into those tables and no trigger
-- that would create one. "Suggestion" and "confirm-and-apply" are therefore
-- architecturally separate by construction, not by a check we hope holds:
-- there is no code path in app_private that can reach those tables from
-- here at all, and the SQL test suite asserts this by inspecting the
-- function bodies (pg_get_functiondef ... not ilike '%public.payments%'
-- etc.) rather than trusting review.
--
-- FIVE SURFACES (per task): 'config', 'challenge_copy', 'translation',
-- 'alert_style', 'moderation'. Closed set, CHECK-enforced — a sixth surface
-- needs its own migration decision, same shape as the entitlement set.
--
-- WHO MAY DECIDE: per-surface, because "moderation assistance" explicitly
-- names a human *moderator* as the confirmer (master plan: "surfacing a
-- suggested moderation action for a human moderator to confirm"), while the
-- other four surfaces are creator-facing (config, challenge copy, style,
-- translation) and gated to owner/admin (translation additionally trusts
-- 'operator', matching that role's existing content-adjacent scope
-- elsewhere in the schema). A viewer can never decide any surface. This is
-- enforced inside app_private.decide_assist_suggestion, not in the API
-- layer, so it holds regardless of which client calls it.
--
-- ENTITLEMENT: gated live via app_private.tier_assist_enabled(), exactly
-- the tier_goal_count_limit (0102) / tier_custom_branding_allowed (0077)
-- pattern — computed at suggestion-creation time against the channel's
-- current tier, never merged into channel_entitlement_versions.values.
-- This is not a ninth public entitlement dimension (master plan decision 2
-- keeps that set closed at eight).
--
-- PROVIDER SEAM: this migration stores suggestions; it does not generate
-- them from any external model. Generation is an application-layer concern
-- (apps/api/src/domain/assist-provider.ts) that ships with a local,
-- deterministic, zero-network default. No provider is chosen or
-- integrated here — see that file's data-contract comment for exactly what
-- would and would not cross a future provider seam.
--
-- AUDIT: assist_confirmations.applied_payload is null on rejection and
-- (creator-editable-at-accept-time) payload on acceptance, so "what was
-- suggested vs. what was applied" is always reconstructable by joining
-- assist_suggestions.suggested_payload to assist_confirmations.applied_payload
-- for the same suggestion_id, alongside who decided (decided_by_user_id +
-- decided_by_role, a snapshot so a later role change cannot rewrite
-- history) and when (decided_at).

create table public.assist_suggestions (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  surface text not null check (surface in ('config', 'challenge_copy', 'translation', 'alert_style', 'moderation')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  suggested_payload jsonb not null check (jsonb_typeof(suggested_payload) = 'object'),
  basis text not null check (char_length(basis) between 1 and 500),
  requested_by_user_id uuid not null references public.app_users(id),
  created_at timestamptz not null default current_timestamp,
  decided_at timestamptz
);

create index assist_suggestions_channel_status_idx on public.assist_suggestions (channel_id, status);

alter table public.assist_suggestions enable row level security;
revoke all on public.assist_suggestions from public;
revoke all on public.assist_suggestions from bsa_app;

create table public.assist_confirmations (
  id uuid primary key,
  suggestion_id uuid not null unique references public.assist_suggestions(id),
  decision text not null check (decision in ('accepted', 'rejected')),
  decided_by_user_id uuid not null references public.app_users(id),
  decided_by_role text not null check (decided_by_role in ('owner', 'admin', 'operator', 'moderator', 'viewer')),
  applied_payload jsonb check (applied_payload is null or jsonb_typeof(applied_payload) = 'object'),
  decided_at timestamptz not null default current_timestamp
);

alter table public.assist_confirmations enable row level security;
revoke all on public.assist_confirmations from public;
revoke all on public.assist_confirmations from bsa_app;

-- Hidden per-tier assist toggle — see file header. Mirrors
-- tier_goal_count_limit's exact shape: live-only, fail-closed on an
-- unrecognised tier, never cached into entitlement values. Free gets no
-- assist surfaces at all; every paid tier does.
create or replace function app_private.tier_assist_enabled(target_tier text)
returns boolean
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return false;
    when 'pro' then return true;
    when 'creator' then return true;
    when 'studio' then return true;
    else raise exception 'unrecognised tier for assist entitlement: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.tier_assist_enabled(text) from public;
grant execute on function app_private.tier_assist_enabled(text) to bsa_app;

-- Create a suggestion. Requesting one is itself restricted to owner/admin/
-- operator (a viewer never triggers assist generation either) AND requires
-- the channel's current tier to have assist enabled. This function inserts
-- into assist_suggestions ONLY — see file header for why no other table is
-- reachable from here.
create or replace function app_private.create_assist_suggestion(
  target_channel_id uuid,
  target_surface text,
  target_suggested_payload jsonb,
  target_basis text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_tier text;
  new_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator']::text[]) then
    raise exception 'not authorized to request assist suggestions for this channel' using errcode = '42501';
  end if;

  if target_surface not in ('config', 'challenge_copy', 'translation', 'alert_style', 'moderation') then
    raise exception 'invalid assist surface' using errcode = '22023';
  end if;

  if target_suggested_payload is null or jsonb_typeof(target_suggested_payload) <> 'object' then
    raise exception 'invalid assist suggestion payload' using errcode = '22023';
  end if;

  if target_basis is null or char_length(target_basis) not between 1 and 500 then
    raise exception 'invalid assist suggestion basis' using errcode = '22023';
  end if;

  select tier into current_tier
    from public.channel_entitlement_versions
   where channel_id = target_channel_id
   order by version desc
   limit 1;

  if current_tier is null then
    raise exception 'invalid assist suggestion' using errcode = '22023';
  end if;

  if not app_private.tier_assist_enabled(current_tier) then
    raise exception 'assist is not enabled for this channel''s current tier' using errcode = '42501';
  end if;

  new_id := gen_random_uuid();
  insert into public.assist_suggestions (
    id, channel_id, surface, status, suggested_payload, basis, requested_by_user_id, created_at
  ) values (
    new_id, target_channel_id, target_surface, 'pending', target_suggested_payload, target_basis,
    app_private.current_user_id(), current_timestamp
  );

  return new_id;
end
$$;

revoke execute on function app_private.create_assist_suggestion(uuid, text, jsonb, text) from public;
grant execute on function app_private.create_assist_suggestion(uuid, text, jsonb, text) to bsa_app;

-- Read path: any current channel member (owner through moderator; viewer
-- excluded — these surfaces are creator/moderator tooling, not public)
-- sees the channel's suggestions. A non-member / viewer sees zero rows.
create or replace function app_private.list_channel_assist_suggestions(target_channel_id uuid)
returns table (
  suggestion_id uuid, surface text, status text, suggested_payload jsonb, basis text,
  requested_by_user_id uuid, created_at timestamptz, decided_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select s.id, s.surface, s.status, s.suggested_payload, s.basis, s.requested_by_user_id, s.created_at, s.decided_at
    from public.assist_suggestions s
   where s.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[])
   order by s.created_at desc
$$;

revoke execute on function app_private.list_channel_assist_suggestions(uuid) from public;
grant execute on function app_private.list_channel_assist_suggestions(uuid) to bsa_app;

-- The one place a suggestion becomes a decision. Per-surface acceptor
-- roles (see file header): moderation -> owner/admin/moderator;
-- translation -> owner/admin/operator; everything else (config,
-- challenge_copy, alert_style) -> owner/admin only. A suggestion already
-- decided cannot be decided again (status must be 'pending'). Writes to
-- assist_suggestions and assist_confirmations ONLY.
create or replace function app_private.decide_assist_suggestion(
  target_suggestion_id uuid,
  target_decision text,
  target_applied_payload jsonb
)
returns table (
  confirmation_id uuid, suggestion_id uuid, decision text, decided_by_user_id uuid,
  decided_by_role text, applied_payload jsonb, decided_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  target_channel_id uuid;
  target_surface text;
  current_status text;
  allowed_roles text[];
  caller_role text;
  new_confirmation_id uuid;
  final_applied_payload jsonb;
  final_decided_at timestamptz;
begin
  if target_decision not in ('accepted', 'rejected') then
    raise exception 'invalid assist decision' using errcode = '22023';
  end if;

  select channel_id, surface, status into target_channel_id, target_surface, current_status
    from public.assist_suggestions
   where id = target_suggestion_id
   for update;

  if target_channel_id is null then
    raise exception 'assist suggestion not found' using errcode = '02000';
  end if;

  if current_status <> 'pending' then
    raise exception 'assist suggestion already decided' using errcode = '22023';
  end if;

  case target_surface
    when 'moderation' then allowed_roles := array['owner', 'admin', 'moderator']::text[];
    when 'translation' then allowed_roles := array['owner', 'admin', 'operator']::text[];
    else allowed_roles := array['owner', 'admin']::text[];
  end case;

  if not app_private.has_channel_role(target_channel_id, allowed_roles) then
    raise exception 'not authorized to decide this assist suggestion' using errcode = '42501';
  end if;

  select membership.role into caller_role
    from public.channel_memberships membership
   where membership.channel_id = target_channel_id
     and membership.user_id = app_private.current_user_id()
     and membership.revoked_at is null
   limit 1;

  if caller_role is null then
    raise exception 'not authorized to decide this assist suggestion' using errcode = '42501';
  end if;

  if target_decision = 'accepted' then
    if target_applied_payload is not null and jsonb_typeof(target_applied_payload) <> 'object' then
      raise exception 'invalid applied payload' using errcode = '22023';
    end if;
    select coalesce(target_applied_payload, s.suggested_payload) into final_applied_payload
      from public.assist_suggestions s where s.id = target_suggestion_id;
  else
    final_applied_payload := null;
  end if;

  final_decided_at := current_timestamp;
  new_confirmation_id := gen_random_uuid();

  update public.assist_suggestions
     set status = target_decision, decided_at = final_decided_at
   where id = target_suggestion_id;

  insert into public.assist_confirmations (
    id, suggestion_id, decision, decided_by_user_id, decided_by_role, applied_payload, decided_at
  ) values (
    new_confirmation_id, target_suggestion_id, target_decision, app_private.current_user_id(), caller_role,
    final_applied_payload, final_decided_at
  );

  return query
    select new_confirmation_id, target_suggestion_id, target_decision, app_private.current_user_id(), caller_role,
           final_applied_payload, final_decided_at;
end
$$;

revoke execute on function app_private.decide_assist_suggestion(uuid, text, jsonb) from public;
grant execute on function app_private.decide_assist_suggestion(uuid, text, jsonb) to bsa_app;

-- Audit read: the full lifecycle of one suggestion, joined to its decision
-- (if any). Same membership gate as the list function.
create or replace function app_private.get_assist_suggestion_audit(target_suggestion_id uuid)
returns table (
  suggestion_id uuid, channel_id uuid, surface text, status text, suggested_payload jsonb, basis text,
  requested_by_user_id uuid, created_at timestamptz,
  confirmation_id uuid, decision text, decided_by_user_id uuid, decided_by_role text,
  applied_payload jsonb, decided_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select s.id, s.channel_id, s.surface, s.status, s.suggested_payload, s.basis, s.requested_by_user_id, s.created_at,
         c.id, c.decision, c.decided_by_user_id, c.decided_by_role, c.applied_payload, c.decided_at
    from public.assist_suggestions s
    left join public.assist_confirmations c on c.suggestion_id = s.id
   where s.id = target_suggestion_id
     and app_private.has_channel_role(s.channel_id, array['owner', 'admin', 'operator', 'moderator']::text[])
$$;

revoke execute on function app_private.get_assist_suggestion_audit(uuid) from public;
grant execute on function app_private.get_assist_suggestion_audit(uuid) to bsa_app;
