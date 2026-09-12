-- L17: paid challenges (master plan Part 6 "L17 — Paid challenges").
--
-- REDESIGNED AWAY FROM REFUNDS. The original L17 task doc
-- (../bharatstudio-requirements/tasks/L17-paid-challenges.md) specifies a
-- refund-initiation flow gated on `PaymentProviderConnection.capabilities
-- .refunds`. That capability does not exist and cannot exist here:
-- CreatorPaymentProvider.connectionCapabilities() reports
-- supportsRefunds: false for every rail (apps/api/src/domain/
-- payment-provider-creator.ts, apps/api/src/domain/
-- payment-provider-razorpay.ts) and no rail implements refund
-- *initiation* — only reconciliation of a refund a creator issued
-- themselves in their own provider dashboard (services/payment-webhook-go/
-- internal/reconcile/refund.go). Master plan 1.4: BharatStudio holds no
-- escrow and is not in the settlement path, so it has no funds to return
-- and no API call that would return them. Master plan 10.7 already cut
-- refundable multi-contributor challenges for exactly this reason
-- ("N independent refund operations, each able to fail — treat as goals").
--
-- What this migration builds instead: a challenge is a creator-set target
-- (a stake or a bounty) that RESOLVES — succeeded / failed / cancelled —
-- rather than reverses. A contribution is an ordinary tip that counts
-- toward the target. If the challenge fails or is cancelled, the money
-- has already settled to the creator; nothing here promises, implies, or
-- attempts to move it back. See CHALLENGE_FAILURE_COPY in
-- apps/api/src/domain/challenge-store.ts and its mirror in
-- apps/web/app/dashboard/challenges/ and apps/web/app/overlay/widgets/
-- challenge/ for the exact sentence shown to a contributor.
--
-- PROGRESS IS NEVER STORED — same shape as 0102's support_goals, and for
-- the same reason: app_private.challenge_progress_paise() computes it
-- live, every read, as a windowed sum over public.payments (status in
-- captured/refunded/partially_refunded) minus public.refunds rows with
-- status = 'processed' for those same payments, scoped to the channel and
-- the challenge's own active window. There is no counter anywhere a
-- creator, a bug, or a compromised client could set directly. A refund a
-- creator issues on their own provider dashboard (the only kind of refund
-- this system can ever observe) reduces progress the next time it is read
-- — no event to miss, no reconciliation job of ours, no code path here at
-- all. This is precisely 0102's "PROGRESS IS NEVER STORED" note, unchanged.
--
-- STATE MACHINE (stored strictly separately from payment state, per the
-- original task doc's non-negotiable rule — no column here ever holds a
-- payment/refund status):
--   draft     -> active      (creator/admin starts the challenge)
--   draft     -> cancelled   (creator/admin withdraws it before it starts)
--   active    -> succeeded   (creator/admin declares the target/bounty met)
--   active    -> failed      (creator/admin declares it did not happen)
--   active    -> cancelled   (creator/admin stops it early)
-- succeeded/failed/cancelled are terminal — no further transition is ever
-- valid. app_private.transition_challenge() is the only write path for
-- lifecycle and validates every edge above; anything else raises. Every
-- transition is appended to challenge_status_events (append-only, no
-- update/delete grant to bsa_app) so the lifecycle history survives even
-- after the challenge itself resolves.
--
-- ENTITLEMENT: challenge count is gated per-tier via
-- app_private.tier_challenge_count_limit(), computed LIVE against the
-- channel's current tier at creation time — mirrors 0102's
-- tier_goal_count_limit exactly. This is not a ninth public entitlement
-- dimension: the limit is never merged into channel_entitlement_versions
-- .values (master plan decision 2 — the eight dimensions are closed).

create table public.challenges (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  created_by_user_id uuid not null references public.app_users(id),
  title text not null check (char_length(title) between 1 and 120),
  description text check (description is null or char_length(description) <= 500),
  challenge_kind text not null check (challenge_kind in ('stake', 'bounty')),
  target_amount_paise bigint not null check (target_amount_paise >= 1000),
  state text not null check (state in ('draft', 'active', 'succeeded', 'failed', 'cancelled')) default 'draft',
  is_public boolean not null default true,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  check (state = 'draft' or started_at is not null),
  check (state not in ('succeeded', 'failed', 'cancelled') or ended_at is not null)
);

create index challenges_channel_open_idx on public.challenges (channel_id) where state in ('draft', 'active');

alter table public.challenges enable row level security;
revoke all on public.challenges from public;
revoke all on public.challenges from bsa_app;

-- Append-only lifecycle audit trail. No update/delete grant is ever issued
-- to bsa_app — the only writer is app_private.transition_challenge(),
-- which only ever inserts.
create table public.challenge_status_events (
  id uuid primary key,
  challenge_id uuid not null references public.challenges(id),
  from_state text not null,
  to_state text not null check (to_state in ('active', 'succeeded', 'failed', 'cancelled')),
  actor_user_id uuid not null references public.app_users(id),
  created_at timestamptz not null default current_timestamp
);

create index challenge_status_events_challenge_idx on public.challenge_status_events (challenge_id, created_at);

alter table public.challenge_status_events enable row level security;
revoke all on public.challenge_status_events from public;
revoke all on public.challenge_status_events from bsa_app;

-- Hidden per-tier challenge count limit — mirrors tier_goal_count_limit
-- (0102) exactly: live-only, fail-closed on an unrecognised tier, never
-- cached into entitlement values. Free is 0 — a challenge is a paid
-- monetisation surface, not a free-tier feature, and this is the "an
-- unentitled tier cannot create one" gate.
create or replace function app_private.tier_challenge_count_limit(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 0;
    when 'pro' then return 2;
    when 'creator' then return 5;
    when 'studio' then return 8;
    else raise exception 'unrecognised tier for challenge entitlement: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.tier_challenge_count_limit(text) from public;
grant execute on function app_private.tier_challenge_count_limit(text) to bsa_app;

-- The single source of truth for a challenge's progress. See file header
-- "PROGRESS IS NEVER STORED". Window is [started_at, ended_at or now) —
-- a draft challenge (started_at is null) always reports zero.
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
  net_paise bigint;
begin
  select * into challenge from public.challenges where id = target_challenge_id;
  if not found or challenge.started_at is null then
    return 0;
  end if;

  window_end := coalesce(challenge.ended_at, 'infinity'::timestamptz);

  select coalesce(sum(payment.gross_amount_paise), 0) - coalesce((
    select sum(refund.amount_paise)
      from public.refunds refund
      join public.payments refunded_payment on refunded_payment.id = refund.payment_id
     where refunded_payment.channel_id = challenge.channel_id
       and refund.status = 'processed'
       and refunded_payment.created_at >= challenge.started_at
       and refunded_payment.created_at < window_end
  ), 0)
    into net_paise
    from public.payments payment
   where payment.channel_id = challenge.channel_id
     and payment.status in ('captured', 'refunded', 'partially_refunded')
     and payment.created_at >= challenge.started_at
     and payment.created_at < window_end;

  return greatest(coalesce(net_paise, 0), 0);
end
$$;

revoke execute on function app_private.challenge_progress_paise(uuid) from public;
grant execute on function app_private.challenge_progress_paise(uuid) to bsa_app;

create or replace function app_private.create_challenge(
  target_channel_id uuid,
  target_title text,
  target_description text,
  target_kind text,
  target_amount_paise bigint,
  target_is_public boolean
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_tier text;
  open_count integer;
  new_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s challenges' using errcode = '42501';
  end if;

  if target_title is null or char_length(target_title) not between 1 and 120
     or (target_description is not null and char_length(target_description) > 500)
     or target_kind not in ('stake', 'bounty')
     or target_amount_paise is null or target_amount_paise < 1000 then
    raise exception 'invalid challenge' using errcode = '22023';
  end if;

  select tier into current_tier
    from public.channel_entitlement_versions
   where channel_id = target_channel_id
   order by version desc
   limit 1;

  if current_tier is null then
    raise exception 'invalid challenge' using errcode = '22023';
  end if;

  select count(*) into open_count
    from public.challenges
   where channel_id = target_channel_id
     and state in ('draft', 'active');

  if open_count >= app_private.tier_challenge_count_limit(current_tier) then
    raise exception 'challenge limit reached for the channel''s current tier' using errcode = '42501';
  end if;

  new_id := gen_random_uuid();
  insert into public.challenges (
    id, channel_id, created_by_user_id, title, description, challenge_kind, target_amount_paise, state, is_public, created_at, updated_at
  ) values (
    new_id, target_channel_id, app_private.current_user_id(), target_title, target_description, target_kind, target_amount_paise,
    'draft', coalesce(target_is_public, true), current_timestamp, current_timestamp
  );

  return new_id;
end
$$;

revoke execute on function app_private.create_challenge(uuid, text, text, text, bigint, boolean) from public;
grant execute on function app_private.create_challenge(uuid, text, text, text, bigint, boolean) to bsa_app;

-- The only lifecycle write path. Validates every edge named in the file
-- header's state machine and rejects anything else — a state transition
-- is never free-form. Every successful transition is appended to
-- challenge_status_events before it returns.
create or replace function app_private.transition_challenge(
  target_channel_id uuid,
  target_challenge_id uuid,
  target_to_state text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  challenge public.challenges%rowtype;
  edge_valid boolean;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s challenges' using errcode = '42501';
  end if;

  select * into challenge from public.challenges where id = target_challenge_id and channel_id = target_channel_id;
  if not found then
    raise exception 'challenge not found' using errcode = 'P0002';
  end if;

  edge_valid := (challenge.state = 'draft' and target_to_state in ('active', 'cancelled'))
             or (challenge.state = 'active' and target_to_state in ('succeeded', 'failed', 'cancelled'));

  if not edge_valid then
    raise exception 'invalid challenge state transition: % -> %', challenge.state, target_to_state using errcode = '22023';
  end if;

  update public.challenges
     set state = target_to_state,
         started_at = case when target_to_state = 'active' then current_timestamp else started_at end,
         ended_at = case when target_to_state in ('succeeded', 'failed', 'cancelled') then current_timestamp else ended_at end,
         updated_at = current_timestamp
   where id = target_challenge_id;

  insert into public.challenge_status_events (id, challenge_id, from_state, to_state, actor_user_id, created_at)
  values (gen_random_uuid(), target_challenge_id, challenge.state, target_to_state, app_private.current_user_id(), current_timestamp);
end
$$;

revoke execute on function app_private.transition_challenge(uuid, uuid, text) from public;
grant execute on function app_private.transition_challenge(uuid, uuid, text) to bsa_app;

-- Read path for the dashboard: any current channel member (owner through
-- viewer) can see the channel's challenges and their live progress; a
-- non-member sees zero rows. Same shape as list_channel_goals (0102).
create or replace function app_private.list_channel_challenges(target_channel_id uuid)
returns table (
  challenge_id uuid, title text, description text, challenge_kind text, target_amount_paise bigint,
  state text, is_public boolean, progress_paise bigint, target_reached boolean,
  started_at timestamptz, ended_at timestamptz, created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select c.id, c.title, c.description, c.challenge_kind, c.target_amount_paise, c.state, c.is_public,
         app_private.challenge_progress_paise(c.id),
         app_private.challenge_progress_paise(c.id) >= c.target_amount_paise,
         c.started_at, c.ended_at, c.created_at
    from public.challenges c
   where c.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
   order by c.created_at desc
$$;

revoke execute on function app_private.list_channel_challenges(uuid) from public;
grant execute on function app_private.list_channel_challenges(uuid) to bsa_app;

create or replace function app_private.get_channel_challenge(target_channel_id uuid, target_challenge_id uuid)
returns table (
  challenge_id uuid, title text, description text, challenge_kind text, target_amount_paise bigint,
  state text, is_public boolean, progress_paise bigint, target_reached boolean,
  started_at timestamptz, ended_at timestamptz, created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select c.id, c.title, c.description, c.challenge_kind, c.target_amount_paise, c.state, c.is_public,
         app_private.challenge_progress_paise(c.id),
         app_private.challenge_progress_paise(c.id) >= c.target_amount_paise,
         c.started_at, c.ended_at, c.created_at
    from public.challenges c
   where c.channel_id = target_channel_id
     and c.id = target_challenge_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
$$;

revoke execute on function app_private.get_channel_challenge(uuid, uuid) from public;
grant execute on function app_private.get_channel_challenge(uuid, uuid) to bsa_app;

-- Overlay/widget read — identical auth shape to list_overlay_goal (0102):
-- overlay_sessions token fingerprint, not revoked, not expired. Returns the
-- most recently updated public challenge for the channel, in ANY lifecycle
-- state (including terminal ones), so the widget can show a resolved
-- challenge's outcome rather than only ever "in progress".
create or replace function app_private.list_overlay_challenge(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (
  challenge_id uuid, title text, challenge_kind text, target_amount_paise bigint,
  state text, progress_paise bigint, target_reached boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select c.id, c.title, c.challenge_kind, c.target_amount_paise, c.state,
         app_private.challenge_progress_paise(c.id),
         app_private.challenge_progress_paise(c.id) >= c.target_amount_paise
    from public.overlay_sessions session
    join public.challenges c on c.channel_id = session.channel_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and c.is_public
   order by c.updated_at desc
   limit 1
$$;

revoke execute on function app_private.list_overlay_challenge(uuid, text) from public;
grant execute on function app_private.list_overlay_challenge(uuid, text) to bsa_app;
