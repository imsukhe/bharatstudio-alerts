-- L16: support goals (master plan Part 6 "L16 — Interaction menu, goals and
-- widgets", Part 7 §7.6). A support goal is a per-channel target that fills
-- as tips arrive, rendered as an OBS overlay widget.
--
-- PROGRESS IS NEVER STORED. `support_goals` carries no current/progress
-- column at all — app_private.support_goal_progress_paise() computes it
-- live, every read, as a windowed sum over public.payments (status in
-- captured/refunded/partially_refunded) minus public.refunds rows with
-- status = 'processed' for those same payments. There is therefore no
-- counter anywhere a creator, a bug, or a compromised client could set
-- directly — the only way progress moves is a real payment/refund row.
--
-- REFUND BEHAVIOUR: a refund reduces progress the very next time progress
-- is read (no event to miss, nothing to reconcile, no separate write path
-- to keep in sync) because the sum already nets out every 'processed'
-- refund tied to a payment inside the goal's window. A goal can therefore
-- never be left "permanently inflated" by a refunded tip. The net is
-- clamped at zero (greatest(..., 0)) as a defensive floor only — the
-- payments/refunds check constraints already prevent a refund total from
-- exceeding its payment's gross amount.
--
-- WINDOW: four kinds, chosen because this schema has no "stream session"
-- entity (no live/VOD boundary signal exists anywhere in the schema) to
-- key a true per-stream window off of:
--   'stream' — creator-controlled: starts at started_at (goal creation),
--              ends only when the creator explicitly ends it. This is the
--              stand-in for "this stream's goal" until a real stream-
--              session concept exists.
--   'daily'  — resets every UTC calendar day; progress = payments inside
--              [max(started_at, today 00:00 UTC), tomorrow 00:00 UTC).
--   'monthly'— resets every UTC calendar month, same shape.
--   'open'   — no reset ever; accumulates from started_at until ended.
-- daily/monthly need no cron/reset job — the window boundary is computed
-- from current_timestamp on every read, so progress rolls over on its own.
--
-- LIFECYCLE: 'ended' is the only lifecycle state ever written (ended_at
-- set once, idempotently, by the creator). 'active' vs 'reached' is never
-- stored — app_private.support_goal_reached() derives it live by comparing
-- computed progress to target_amount_paise, so "reached" can never be
-- spoofed independently of real payment totals either.
--
-- ENTITLEMENT: goal count is gated per MASTER-PLAN Part 7 §7.6's widget
-- table (Free 1 / Pro 3 / Creator 10 / Studio 10) via
-- app_private.tier_goal_count_limit(), computed LIVE against the channel's
-- current tier at creation time — exactly the pattern 0077 established for
-- tier_custom_branding_allowed (lottieEnabled): never merged into
-- channel_entitlement_versions.values, so this is not a ninth public
-- entitlement dimension. A downgrade does not retroactively end existing
-- goals (matches lottie's "no separate cleanup job" philosophy) but blocks
-- creating new ones past the new limit.

create table public.support_goals (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  created_by_user_id uuid not null references public.app_users(id),
  title text not null check (char_length(title) between 1 and 120),
  target_amount_paise bigint not null check (target_amount_paise >= 1000),
  goal_window text not null check (goal_window in ('stream', 'daily', 'monthly', 'open')),
  is_public boolean not null default true,
  started_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create index support_goals_channel_active_idx on public.support_goals (channel_id) where ended_at is null;

alter table public.support_goals enable row level security;
revoke all on public.support_goals from public;
revoke all on public.support_goals from bsa_app;

-- Hidden per-tier goal count limit — see file header. Mirrors
-- tier_custom_branding_allowed's exact shape (0077): live-only, fail-closed
-- on an unrecognised tier, never cached into entitlement values.
create or replace function app_private.tier_goal_count_limit(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 1;
    when 'pro' then return 3;
    when 'creator' then return 10;
    when 'studio' then return 10;
    else raise exception 'unrecognised tier for support goal entitlement: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.tier_goal_count_limit(text) from public;
grant execute on function app_private.tier_goal_count_limit(text) to bsa_app;

-- The single source of truth for a goal's progress. Takes the goal id
-- (not a row) so every caller — owner read, overlay read, the reached-
-- check — shares one derivation with no risk of divergence.
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
  net_paise bigint;
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

  select coalesce(sum(payment.gross_amount_paise), 0) - coalesce((
    select sum(refund.amount_paise)
      from public.refunds refund
      join public.payments refunded_payment on refunded_payment.id = refund.payment_id
     where refunded_payment.channel_id = goal.channel_id
       and refund.status = 'processed'
       and refunded_payment.created_at >= window_start
       and refunded_payment.created_at < window_end
  ), 0)
    into net_paise
    from public.payments payment
   where payment.channel_id = goal.channel_id
     and payment.status in ('captured', 'refunded', 'partially_refunded')
     and payment.created_at >= window_start
     and payment.created_at < window_end;

  return greatest(coalesce(net_paise, 0), 0);
end
$$;

revoke execute on function app_private.support_goal_progress_paise(uuid) from public;
grant execute on function app_private.support_goal_progress_paise(uuid) to bsa_app;

-- Derived reached-state — never stored. See file header.
create or replace function app_private.support_goal_reached(target_goal_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select app_private.support_goal_progress_paise(target_goal_id) >= goal.target_amount_paise
    from public.support_goals goal
   where goal.id = target_goal_id
$$;

revoke execute on function app_private.support_goal_reached(uuid) from public;
grant execute on function app_private.support_goal_reached(uuid) to bsa_app;

create or replace function app_private.create_support_goal(
  target_channel_id uuid,
  target_title text,
  target_amount_paise bigint,
  target_window text,
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
  active_count integer;
  new_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s support goals' using errcode = '42501';
  end if;

  if target_title is null or char_length(target_title) not between 1 and 120
     or target_amount_paise is null or target_amount_paise < 1000
     or target_window not in ('stream', 'daily', 'monthly', 'open') then
    raise exception 'invalid support goal' using errcode = '22023';
  end if;

  select tier into current_tier
    from public.channel_entitlement_versions
   where channel_id = target_channel_id
   order by version desc
   limit 1;

  if current_tier is null then
    raise exception 'invalid support goal' using errcode = '22023';
  end if;

  select count(*) into active_count
    from public.support_goals
   where channel_id = target_channel_id
     and ended_at is null;

  if active_count >= app_private.tier_goal_count_limit(current_tier) then
    raise exception 'support goal limit reached for the channel''s current tier' using errcode = '42501';
  end if;

  new_id := gen_random_uuid();
  insert into public.support_goals (
    id, channel_id, created_by_user_id, title, target_amount_paise, goal_window, is_public, started_at, created_at, updated_at
  ) values (
    new_id, target_channel_id, app_private.current_user_id(), target_title, target_amount_paise, target_window,
    coalesce(target_is_public, true), current_timestamp, current_timestamp, current_timestamp
  );

  return new_id;
end
$$;

revoke execute on function app_private.create_support_goal(uuid, text, bigint, text, boolean) from public;
grant execute on function app_private.create_support_goal(uuid, text, bigint, text, boolean) to bsa_app;

-- Read path for the dashboard: any current channel member (owner through
-- viewer) can see the channel's goals and their live progress; a non-member
-- sees zero rows (same "filtered in the WHERE clause, no exception" shape
-- list_channel_lottie_assets uses).
create or replace function app_private.list_channel_goals(target_channel_id uuid)
returns table (
  goal_id uuid, title text, target_amount_paise bigint, goal_window text, is_public boolean,
  progress_paise bigint, reached boolean, ended boolean, started_at timestamptz, ended_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select goal.id, goal.title, goal.target_amount_paise, goal.goal_window, goal.is_public,
         app_private.support_goal_progress_paise(goal.id),
         (goal.ended_at is null and app_private.support_goal_progress_paise(goal.id) >= goal.target_amount_paise),
         goal.ended_at is not null,
         goal.started_at, goal.ended_at
    from public.support_goals goal
   where goal.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
   order by goal.started_at desc
$$;

revoke execute on function app_private.list_channel_goals(uuid) from public;
grant execute on function app_private.list_channel_goals(uuid) to bsa_app;

create or replace function app_private.get_channel_goal(target_channel_id uuid, target_goal_id uuid)
returns table (
  goal_id uuid, title text, target_amount_paise bigint, goal_window text, is_public boolean,
  progress_paise bigint, reached boolean, ended boolean, started_at timestamptz, ended_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select goal.id, goal.title, goal.target_amount_paise, goal.goal_window, goal.is_public,
         app_private.support_goal_progress_paise(goal.id),
         (goal.ended_at is null and app_private.support_goal_progress_paise(goal.id) >= goal.target_amount_paise),
         goal.ended_at is not null,
         goal.started_at, goal.ended_at
    from public.support_goals goal
   where goal.channel_id = target_channel_id
     and goal.id = target_goal_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
$$;

revoke execute on function app_private.get_channel_goal(uuid, uuid) from public;
grant execute on function app_private.get_channel_goal(uuid, uuid) to bsa_app;

-- Update: title/target only. There is deliberately no parameter here that
-- could set progress — see file header "PROGRESS IS NEVER STORED".
create or replace function app_private.update_support_goal(
  target_channel_id uuid,
  target_goal_id uuid,
  target_title text,
  target_amount_paise bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  goal public.support_goals%rowtype;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s support goals' using errcode = '42501';
  end if;

  select * into goal from public.support_goals where id = target_goal_id and channel_id = target_channel_id;
  if not found then
    raise exception 'support goal not found' using errcode = 'P0002';
  end if;
  if goal.ended_at is not null then
    raise exception 'an ended support goal cannot be edited' using errcode = '22023';
  end if;

  if target_title is not null and char_length(target_title) not between 1 and 120 then
    raise exception 'invalid support goal' using errcode = '22023';
  end if;
  if target_amount_paise is not null and target_amount_paise < 1000 then
    raise exception 'invalid support goal' using errcode = '22023';
  end if;

  update public.support_goals
     set title = coalesce(target_title, goal.title),
         target_amount_paise = coalesce(update_support_goal.target_amount_paise, goal.target_amount_paise),
         updated_at = current_timestamp
   where id = target_goal_id;
end
$$;

revoke execute on function app_private.update_support_goal(uuid, uuid, text, bigint) from public;
grant execute on function app_private.update_support_goal(uuid, uuid, text, bigint) to bsa_app;

create or replace function app_private.end_support_goal(target_channel_id uuid, target_goal_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  goal public.support_goals%rowtype;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s support goals' using errcode = '42501';
  end if;

  select * into goal from public.support_goals where id = target_goal_id and channel_id = target_channel_id;
  if not found then
    raise exception 'support goal not found' using errcode = 'P0002';
  end if;

  if goal.ended_at is null then
    update public.support_goals set ended_at = current_timestamp, updated_at = current_timestamp where id = target_goal_id;
  end if;
end
$$;

revoke execute on function app_private.end_support_goal(uuid, uuid) from public;
grant execute on function app_private.end_support_goal(uuid, uuid) to bsa_app;

-- Overlay/widget read: same session-scoping shape as
-- list_overlay_lottie_assets (0077) — token fingerprint, not revoked, not
-- expired. Returns at most one row: the most recently started, still-live
-- (ended_at is null), public goal for that channel. Ended or private goals
-- never reach the overlay; an overlay with no live public goal gets zero
-- rows and the widget degrades to its "no active goal" state.
create or replace function app_private.list_overlay_goal(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (
  goal_id uuid, title text, target_amount_paise bigint, goal_window text,
  progress_paise bigint, reached boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select goal.id, goal.title, goal.target_amount_paise, goal.goal_window,
         app_private.support_goal_progress_paise(goal.id),
         app_private.support_goal_progress_paise(goal.id) >= goal.target_amount_paise
    from public.overlay_sessions session
    join public.support_goals goal on goal.channel_id = session.channel_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and goal.is_public
     and goal.ended_at is null
   order by goal.started_at desc
   limit 1
$$;

revoke execute on function app_private.list_overlay_goal(uuid, text) from public;
grant execute on function app_private.list_overlay_goal(uuid, text) to bsa_app;
