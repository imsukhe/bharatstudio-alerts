-- CMP-21/CMP-20: Companion Live Deck goal controls and scene presets
-- (FULL-PRODUCT-DEFINITION.md S5.2 "Live Deck", S5.4 "Milestone queue --
-- prepare, not fire", S19.6 derive-don't-store, S31.8 register rows
-- CMP-20/CMP-21).
--
-- MIGRATION NUMBER: 0162, assigned to this task. Nothing else is
-- renumbered or touched.
--
-- ============================================================
-- CMP-21 -- GOAL CONTROLS FROM COMPANION. Exactly the four S5.2 names:
-- increase target, start timer, mark complete, trigger celebration.
-- ============================================================
--
-- NO NEW GOAL STATE. Every control below reuses public.support_goals
-- (0102) and public.support_goal_completions (0150) exactly as they are.
-- Nothing here adds a progress column, a completed-flag column, or any
-- other durable counter -- S19.6 (derive, never store) is honoured by
-- construction: progress keeps coming from
-- app_private.support_goal_progress_paise (0102), completion keeps living
-- in support_goal_completions (0150), unmodified.
--
--   * "Increase target" -- app_private.increase_support_goal_target below
--     calls the EXISTING app_private.update_support_goal (0102) after
--     checking the new amount is strictly greater than the current one.
--     It is a thin, additional-rule wrapper, not a second update path.
--   * "Mark complete" -- this is the one genuinely new piece of logic,
--     and it is a deliberate, narrow EXTENSION of 0150's latch, not a
--     parallel mechanism. 0150's app_private.latch_support_goal_
--     completion only ever inserts a 'completed' row when live progress
--     has actually crossed the target; that is correct for the
--     opportunistic, automatic latch on every read, but a creator-
--     initiated "mark complete" from Companion is explicitly an EARLY/
--     FORCED completion (e.g. "close this out now, good enough") and
--     must work below 100% too. app_private.manually_complete_support_
--     goal below writes into the exact same support_goal_completions
--     table, freezes completed_progress_paise at whatever live progress
--     is AT THE MOMENT OF THE CALL (never the target, never a guess),
--     and is gated by the exact same partial unique index
--     (support_goal_completions_active_idx, 0150) that makes the
--     automatic latch idempotent -- so a manual complete and a natural
--     100% crossing can never both produce two active completion rows,
--     and BOTH paths converge on one row a later refund can never
--     rewrite. Reopening a manually-completed goal uses 0150's own
--     app_private.reopen_support_goal_completion, completely unmodified
--     -- there is no separate "un-manually-complete" path to keep in
--     sync.
--   * "Start timer" -- ASSUMPTION, recorded here because S5.2 names the
--     control but does not define it, and no timer/countdown/duration
--     concept exists anywhere in this schema (0102's own header already
--     rejects inventing one; see 0135/0142 for the same posture on other
--     features). The only existing, schema-native "timer" a support goal
--     has is `started_at` itself: for goal_window = 'stream' (0102's own
--     "creator-controlled ... stand-in for 'this stream's goal'"),
--     `started_at` is exactly the instant contribution-counting begins,
--     and moving it forward is exactly "(re)start the clock" -- no new
--     column, reusing the one derive-don't-store already depends on.
--     app_private.start_support_goal_timer below resets started_at to
--     now for a 'stream'-window goal only (daily/monthly already roll
--     over on their own each period; 'open' has no per-stream timer
--     concept per 0102's own header) and refuses on any other window
--     with a distinct, honest error rather than silently no-op'ing.
--     This is an interpretation, not a verified product decision -- see
--     this task's return report.
--   * "Trigger celebration" -- GOA-21-shaped, deliberately, and see the
--     classifier block below for why.
--
-- ============================================================
-- WHY CELEBRATION'S "PREPARE, NOT FIRE" IS STRUCTURAL HERE TOO.
-- ============================================================
-- Migration 0158 already proved this shape for the goal-trigger engine:
-- an IMMUTABLE classifier keyed on the action type alone, and a CHECK
-- constraint that calls it directly so Postgres itself refuses an
-- outbound/public row with fire_mode = 'fire' -- no column, parameter or
-- API field can bypass it. 0158's own app_private.goal_trigger_action_
-- class is closed over ITS OWN three action types and is not altered by
-- one character in this file (out of scope, and it would not even
-- recognise 'trigger_celebration' -- passing an unknown value through it
-- returns NULL, which would make a CHECK built on it silently ACCEPT any
-- fire_mode, the opposite of enforcement). This migration therefore
-- defines its own IMMUTABLE classifier, app_private.companion_goal_
-- control_class, over Companion's own four-value control-type vocabulary,
-- and reuses 0158's exact CHECK-constraint idiom against it.
--
-- Every Companion goal-control invocation (all four types, not just
-- celebration) is logged, once per call, to companion_goal_control_
-- invocations -- this is both the audit trail and the idempotency lever
-- (unique on (channel_id, idempotency_key), same shape companion_commands
-- already uses for the existing 17-action catalogue). fire_mode on that
-- table is NEVER a caller-supplied parameter anywhere in this file or the
-- API layer above it -- app_private.prepare_support_goal_celebration is
-- the only function that ever writes 'trigger_celebration', and it
-- hardcodes fire_mode = 'prepare' with no argument that could change
-- that. The CHECK constraint below is therefore defense in depth against
-- a FUTURE change to that function, exactly the posture 0158's own header
-- states for GOA-21 ("a comment is not enforcement; the constraint is").
-- "Prepare" here means exactly what S5.4's Milestone queue rule says --
-- the invocation is recorded, ready for a later, separate outbound-
-- dispatch slice (this repository has none yet; 0158 itself scoped
-- GOA-10..17 out for the same reason) -- and nothing here sends, posts,
-- announces or plays anything.
--
-- ============================================================
-- THE COMPANION AUTHORISATION MODEL: ENTITLEMENT + ACTIVATION + LEASE.
-- ============================================================
-- Entitlement (is this channel's plan allowed Companion goal controls at
-- all) and activation (is the overlay actually live right now) are
-- checked in the route layer (apps/api/src/routes/companion-goal-scene.ts
-- -- a NEW file; apps/api/src/routes/companion.ts itself is untouched),
-- the same two-layer split companion.ts's own /actions route already
-- uses, reusing the same AlertStore.getEntitlements/getCompanionState and
-- CompanionEntitlementStore.getCompanionGrantPolicy read paths rather
-- than inventing a third entitlement source. The THIRD layer -- the
-- control-session lease -- is enforced here, in the database, by
-- app_private.require_active_companion_control_session, which every one
-- of the four control functions below calls before doing anything else:
-- the caller must present a session id that is a currently unrevoked,
-- unexpired row in companion_control_sessions (0053) for this exact
-- channel. This table and its acquire/revoke functions are 0053's,
-- completely unmodified -- this migration only ever reads it.

-- ============================================================
-- Classification helper -- IMMUTABLE, pure lookup on control_type alone.
-- Mirrors 0158's app_private.goal_trigger_action_class exactly in shape.
-- ============================================================
create or replace function app_private.companion_goal_control_class(target_control_type text)
returns text
language sql
immutable
as $$
  select case target_control_type
    when 'increase_target' then 'local'
    when 'start_timer' then 'local'
    when 'mark_complete' then 'local'
    when 'trigger_celebration' then 'outbound_or_public'
    else null
  end
$$;

revoke execute on function app_private.companion_goal_control_class(text) from public;
grant execute on function app_private.companion_goal_control_class(text) to public;
grant execute on function app_private.companion_goal_control_class(text) to bsa_app;

-- ============================================================
-- companion_goal_control_invocations -- audit trail + idempotency lever
-- for all four CMP-21 controls, and the structural home of GOA-21's
-- equivalent for this vocabulary (see header).
-- ============================================================
create table public.companion_goal_control_invocations (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  goal_id uuid not null references public.support_goals(id),
  actor_user_id uuid not null references public.app_users(id),
  control_type text not null check (control_type in (
    'increase_target', 'start_timer', 'mark_complete', 'trigger_celebration'
  )),
  fire_mode text not null default 'prepare' check (fire_mode in ('prepare', 'fire')),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  created_at timestamptz not null default current_timestamp,
  unique (channel_id, idempotency_key),
  -- Structural GOA-21 equivalent: an 'outbound_or_public' control_type
  -- (today, only 'trigger_celebration') can never be stored with
  -- fire_mode = 'fire'. See header for why this is a second layer behind
  -- "no function ever passes fire_mode as a parameter", not a substitute
  -- for it.
  check (app_private.companion_goal_control_class(control_type) <> 'outbound_or_public' or fire_mode = 'prepare')
);

create index companion_goal_control_invocations_goal_idx on public.companion_goal_control_invocations (goal_id);
create index companion_goal_control_invocations_channel_idx on public.companion_goal_control_invocations (channel_id);

alter table public.companion_goal_control_invocations enable row level security;
revoke all on public.companion_goal_control_invocations from public;
revoke all on public.companion_goal_control_invocations from bsa_app;

-- ============================================================
-- Layer 3 of the Companion authorisation model: the control-session
-- lease. Reads 0053's companion_control_sessions (unmodified) and
-- nothing else -- see header.
-- ============================================================
create or replace function app_private.require_active_companion_control_session(
  target_channel_id uuid,
  target_session_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_channel_id is null or target_session_id is null then
    raise exception 'a Companion control session is required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.companion_control_sessions session
     where session.id = target_session_id
       and session.channel_id = target_channel_id
       and session.revoked_at is null
       and session.lease_until > current_timestamp
  ) then
    raise exception 'no active Companion control session for this channel' using errcode = '55P03';
  end if;
end
$$;

revoke execute on function app_private.require_active_companion_control_session(uuid, uuid) from public;
grant execute on function app_private.require_active_companion_control_session(uuid, uuid) to bsa_app;

-- "Increase target" -- thin wrapper over 0102's own update_support_goal.
-- Owner/admin only (same bound update_support_goal itself already
-- enforces; checked again here, before the lease/idempotency work, so the
-- error a caller sees is this function's own and the message stays
-- identical to every other goal-management entry point).
create or replace function app_private.increase_support_goal_target(
  target_channel_id uuid,
  target_goal_id uuid,
  target_session_id uuid,
  target_idempotency_key text,
  target_new_amount_paise bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  goal public.support_goals%rowtype;
  invocation_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s support goals' using errcode = '42501';
  end if;

  perform app_private.require_active_companion_control_session(target_channel_id, target_session_id);

  select * into goal from public.support_goals where id = target_goal_id and channel_id = target_channel_id;
  if not found then
    raise exception 'support goal not found' using errcode = 'P0002';
  end if;
  if goal.ended_at is not null then
    raise exception 'an ended support goal cannot be edited' using errcode = '22023';
  end if;

  -- The idempotency insert happens BEFORE the "new amount > current
  -- amount" check, and that check only runs in the branch where this is
  -- a genuinely NEW invocation (using `goal`, fetched once above, before
  -- any update). This ordering matters here specifically -- unlike the
  -- other three controls below, this function's own effect changes the
  -- very value ("current target") a retry would be re-validated against,
  -- so validating before the idempotency check would make a legitimate
  -- retry (same idempotency key, e.g. after a dropped response) fail
  -- with "new target must be greater than the current target" once the
  -- first call had already landed. Checking after guarantees a retry is
  -- always a silent no-op, never re-validated against post-update state.
  insert into public.companion_goal_control_invocations (id, channel_id, goal_id, actor_user_id, control_type, fire_mode, idempotency_key, created_at)
  values (gen_random_uuid(), target_channel_id, target_goal_id, app_private.current_user_id(), 'increase_target', 'fire', target_idempotency_key, current_timestamp)
  on conflict (channel_id, idempotency_key) do nothing
  returning id into invocation_id;

  if invocation_id is not null then
    if target_new_amount_paise is null or target_new_amount_paise <= goal.target_amount_paise then
      raise exception 'the new target must be greater than the current target' using errcode = '22023';
    end if;
    perform app_private.update_support_goal(target_channel_id, target_goal_id, null, target_new_amount_paise);
  end if;
end
$$;

revoke execute on function app_private.increase_support_goal_target(uuid, uuid, uuid, text, bigint) from public;
grant execute on function app_private.increase_support_goal_target(uuid, uuid, uuid, text, bigint) to bsa_app;

-- "Start timer" -- see header ASSUMPTION note. 'stream'-window only.
create or replace function app_private.start_support_goal_timer(
  target_channel_id uuid,
  target_goal_id uuid,
  target_session_id uuid,
  target_idempotency_key text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  goal public.support_goals%rowtype;
  invocation_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s support goals' using errcode = '42501';
  end if;

  perform app_private.require_active_companion_control_session(target_channel_id, target_session_id);

  select * into goal from public.support_goals where id = target_goal_id and channel_id = target_channel_id;
  if not found then
    raise exception 'support goal not found' using errcode = 'P0002';
  end if;
  if goal.ended_at is not null then
    raise exception 'an ended support goal cannot be edited' using errcode = '22023';
  end if;
  if goal.goal_window <> 'stream' then
    raise exception 'start timer only applies to a stream-window support goal' using errcode = '22023';
  end if;

  insert into public.companion_goal_control_invocations (id, channel_id, goal_id, actor_user_id, control_type, fire_mode, idempotency_key, created_at)
  values (gen_random_uuid(), target_channel_id, target_goal_id, app_private.current_user_id(), 'start_timer', 'fire', target_idempotency_key, current_timestamp)
  on conflict (channel_id, idempotency_key) do nothing
  returning id into invocation_id;

  if invocation_id is not null then
    update public.support_goals set started_at = current_timestamp, updated_at = current_timestamp where id = target_goal_id;
  end if;
end
$$;

revoke execute on function app_private.start_support_goal_timer(uuid, uuid, uuid, text) from public;
grant execute on function app_private.start_support_goal_timer(uuid, uuid, uuid, text) to bsa_app;

-- "Mark complete" -- manual/early completion. Extends 0150's latch shape
-- (same table, same partial unique index, same reopen path) rather than
-- adding a stored flag -- see header for why this is safe against a
-- later refund.
create or replace function app_private.manually_complete_support_goal(
  target_channel_id uuid,
  target_goal_id uuid,
  target_session_id uuid,
  target_idempotency_key text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  goal public.support_goals%rowtype;
  invocation_id uuid;
  progress bigint;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s support goals' using errcode = '42501';
  end if;

  perform app_private.require_active_companion_control_session(target_channel_id, target_session_id);

  select * into goal from public.support_goals where id = target_goal_id and channel_id = target_channel_id;
  if not found then
    raise exception 'support goal not found' using errcode = 'P0002';
  end if;

  insert into public.companion_goal_control_invocations (id, channel_id, goal_id, actor_user_id, control_type, fire_mode, idempotency_key, created_at)
  values (gen_random_uuid(), target_channel_id, target_goal_id, app_private.current_user_id(), 'mark_complete', 'fire', target_idempotency_key, current_timestamp)
  on conflict (channel_id, idempotency_key) do nothing
  returning id into invocation_id;

  if invocation_id is not null then
    -- Idempotent by construction, exactly like 0150's own latch: if this
    -- goal already has an active 'completed' row (whether from a natural
    -- 100% crossing or an earlier manual complete), this is a silent
    -- no-op -- never a second active row, never an error.
    if not exists (select 1 from public.support_goal_completions where goal_id = target_goal_id and status = 'completed') then
      progress := app_private.support_goal_progress_paise(target_goal_id);
      insert into public.support_goal_completions (
        id, goal_id, status, completed_at, completed_progress_paise, target_amount_paise_at_completion, created_at, updated_at
      ) values (
        gen_random_uuid(), target_goal_id, 'completed', current_timestamp, progress, goal.target_amount_paise, current_timestamp, current_timestamp
      )
      on conflict (goal_id) where status = 'completed' do nothing;
    end if;
  end if;
end
$$;

revoke execute on function app_private.manually_complete_support_goal(uuid, uuid, uuid, text) from public;
grant execute on function app_private.manually_complete_support_goal(uuid, uuid, uuid, text) to bsa_app;

-- "Trigger celebration" -- PREPARE ONLY. fire_mode is hardcoded below,
-- never a parameter; the table's own CHECK constraint (above) is the
-- second, structural layer. See header.
create or replace function app_private.prepare_support_goal_celebration(
  target_channel_id uuid,
  target_goal_id uuid,
  target_session_id uuid,
  target_idempotency_key text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  invocation_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s support goals' using errcode = '42501';
  end if;

  perform app_private.require_active_companion_control_session(target_channel_id, target_session_id);

  if not exists (select 1 from public.support_goals where id = target_goal_id and channel_id = target_channel_id) then
    raise exception 'support goal not found' using errcode = 'P0002';
  end if;

  insert into public.companion_goal_control_invocations (id, channel_id, goal_id, actor_user_id, control_type, fire_mode, idempotency_key, created_at)
  values (gen_random_uuid(), target_channel_id, target_goal_id, app_private.current_user_id(), 'trigger_celebration', 'prepare', target_idempotency_key, current_timestamp)
  on conflict (channel_id, idempotency_key) do nothing
  returning id into invocation_id;
end
$$;

revoke execute on function app_private.prepare_support_goal_celebration(uuid, uuid, uuid, text) from public;
grant execute on function app_private.prepare_support_goal_celebration(uuid, uuid, uuid, text) to bsa_app;

-- ============================================================
-- CMP-20 -- SCENE PRESETS. Exactly the six S5.2 names: Gameplay, Just
-- Chatting, BRB, Sponsor, Vertical, Ending.
-- ============================================================
--
-- SEEDING DECISION: creator-created, upserted on first configure -- NOT
-- a pre-seeded catalogue. See this task's return report for the fuller
-- reasoning; in short, this repo's two catalogue shapes do not fit:
-- the template/soundboard catalogues (0106/0110/0143) exist because
-- BharatStudio authors shared CONTENT once and every creator reuses it,
-- but a scene preset's content is entirely a creator's own OBS scene/
-- source/transition names -- there is no meaningful shared default to
-- author centrally, and pre-seeding six empty rows per channel would
-- just be six rows a creator must still fill in one at a time. The
-- pattern this migration follows instead is public.master_canvas_modules
-- (0131) app_private.upsert_master_canvas_module: a fixed, closed name
-- enum (not creator-nameable) with ONE row created lazily, on first
-- configure, per (channel, name) pair, never pre-seeded, never deleted.
--
-- STORAGE + RESOLUTION ONLY, same "spine" scope cut 0158 itself used for
-- the goal-trigger engine: this migration builds the preset and its
-- ordered OBS-action steps, and a read path that resolves a preset to
-- that ordered list (companion-goal-scene.ts's GET .../actions route).
-- It does NOT add a one-tap "apply this preset now" dispatch route --
-- doing so would mean either duplicating apps/api/src/db/alert-store.ts's
-- companion_commands dispatch logic (owned by other lanes, not touched
-- here) or editing companion.ts (explicitly read-only for this task).
-- Firing the resolved steps is left to a later slice, exactly like
-- 0158 left GOA-10..17's real action implementations to a later slice.
--
-- NO NEW OBS VERBS: action_type below is constrained to the exact four
-- strings apps/api/src/routes/companion.ts's ACTION_GROUPS already lists
-- for the 'obs' group (obs_set_scene, obs_toggle_source, obs_toggle_mute,
-- obs_set_transition) -- copied as literal strings, not re-derived,
-- because this migration must not alter or duplicate that file's own
-- allowlist.
--
-- NO INVENTED CAP: S30.3 states caps for Master Canvas modules; no
-- authority row states one for scene presets, and none is invented here.
-- A per-channel ceiling of six is already structural (the unique
-- (channel_id, preset_name) constraint over a six-value enum), so no
-- separate cap column, capability-plane registration (0149/0160) or
-- guessed limit is added. If a future authority decision states one,
-- it is read from the capability control plane then -- not guessed now.

create table public.companion_scene_presets (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  preset_name text not null check (preset_name in (
    'gameplay', 'just_chatting', 'brb', 'sponsor', 'vertical', 'ending'
  )),
  created_by_user_id uuid not null references public.app_users(id),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (channel_id, preset_name)
);

create index companion_scene_presets_channel_idx on public.companion_scene_presets (channel_id);

alter table public.companion_scene_presets enable row level security;
revoke all on public.companion_scene_presets from public;
revoke all on public.companion_scene_presets from bsa_app;

create table public.companion_scene_preset_actions (
  id uuid primary key,
  preset_id uuid not null references public.companion_scene_presets(id),
  step_order integer not null check (step_order >= 0),
  -- NO NEW OBS VERBS -- see file header. These four strings are copied
  -- verbatim from companion.ts's ACTION_GROUPS 'obs' group.
  action_type text not null check (action_type in (
    'obs_set_scene', 'obs_toggle_source', 'obs_toggle_mute', 'obs_set_transition'
  )),
  -- Same free-text shape and bound as companion.ts's own targetLabel for
  -- the 'obs' action group (scene/source/input/transition name) -- reused
  -- verbatim, not reinvented.
  target_label text not null check (char_length(target_label) between 1 and 200),
  created_at timestamptz not null default current_timestamp,
  unique (preset_id, step_order)
);

create index companion_scene_preset_actions_preset_idx on public.companion_scene_preset_actions (preset_id);

alter table public.companion_scene_preset_actions enable row level security;
revoke all on public.companion_scene_preset_actions from public;
revoke all on public.companion_scene_preset_actions from bsa_app;

-- Owner/admin only. Creates the preset row the first time this channel
-- configures this name; every later call for the same (channel, name)
-- is a no-op that returns the existing id -- there is no delete path and
-- no second row, mirroring upsert_master_canvas_module (0131) exactly.
create or replace function app_private.upsert_companion_scene_preset(
  target_channel_id uuid,
  target_preset_name text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  result_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s scene presets' using errcode = '42501';
  end if;

  if target_preset_name is null or target_preset_name not in (
    'gameplay', 'just_chatting', 'brb', 'sponsor', 'vertical', 'ending'
  ) then
    raise exception 'invalid scene preset' using errcode = '22023';
  end if;

  insert into public.companion_scene_presets (id, channel_id, preset_name, created_by_user_id, created_at, updated_at)
  values (gen_random_uuid(), target_channel_id, target_preset_name, app_private.current_user_id(), current_timestamp, current_timestamp)
  on conflict (channel_id, preset_name) do update
    set updated_at = current_timestamp
  returning id into result_id;

  return result_id;
end
$$;

revoke execute on function app_private.upsert_companion_scene_preset(uuid, text) from public;
grant execute on function app_private.upsert_companion_scene_preset(uuid, text) to bsa_app;

-- Owner/admin only. Appends one ordered step -- exactly the same
-- "append, do not upsert, let the unique(preset_id, step_order) index
-- refuse a duplicate step" idiom 0158's add_goal_trigger_action uses for
-- goal_trigger_actions.
create or replace function app_private.add_companion_scene_preset_action(
  target_channel_id uuid,
  target_preset_id uuid,
  target_step_order integer,
  target_action_type text,
  target_target_label text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s scene presets' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.companion_scene_presets preset
     where preset.id = target_preset_id and preset.channel_id = target_channel_id
  ) then
    raise exception 'scene preset not found' using errcode = 'P0002';
  end if;

  if target_action_type is null or target_action_type not in (
    'obs_set_scene', 'obs_toggle_source', 'obs_toggle_mute', 'obs_set_transition'
  ) then
    raise exception 'invalid scene preset action' using errcode = '22023';
  end if;
  if target_target_label is null or char_length(target_target_label) not between 1 and 200 then
    raise exception 'invalid scene preset action' using errcode = '22023';
  end if;
  if target_step_order is null or target_step_order < 0 then
    raise exception 'invalid scene preset action' using errcode = '22023';
  end if;

  new_id := gen_random_uuid();
  insert into public.companion_scene_preset_actions (id, preset_id, step_order, action_type, target_label, created_at)
  values (new_id, target_preset_id, target_step_order, target_action_type, target_target_label, current_timestamp);

  update public.companion_scene_presets set updated_at = current_timestamp where id = target_preset_id;

  return new_id;
end
$$;

revoke execute on function app_private.add_companion_scene_preset_action(uuid, uuid, integer, text, text) from public;
grant execute on function app_private.add_companion_scene_preset_action(uuid, uuid, integer, text, text) to bsa_app;

-- Creator-facing read: any current channel member (owner through viewer,
-- same role list list_channel_goals already uses). A non-member sees
-- zero rows.
create or replace function app_private.list_channel_scene_presets(target_channel_id uuid)
returns table (preset_id uuid, preset_name text, created_at timestamptz, updated_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select preset.id, preset.preset_name, preset.created_at, preset.updated_at
    from public.companion_scene_presets preset
   where preset.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
   order by preset.created_at asc
$$;

revoke execute on function app_private.list_channel_scene_presets(uuid) from public;
grant execute on function app_private.list_channel_scene_presets(uuid) to bsa_app;

-- RESOLUTION: a preset's ordered OBS-action steps. This is CMP-20's
-- "resolution to existing actions" -- the client executes each returned
-- step through the EXISTING /v1/channels/{channelId}/companion/actions
-- route (companion.ts, untouched), one action_type/targetLabel pair at a
-- time, in step_order. Same role bound as the list above. Raises (rather
-- than silently returning zero rows) on a missing/foreign preset or an
-- unauthorized caller, mirroring list_goal_trigger_actions (0158)
-- exactly, so the API layer can tell "no steps configured yet" apart
-- from "this preset does not exist / is not yours to see".
create or replace function app_private.list_companion_scene_preset_actions(target_channel_id uuid, target_preset_id uuid)
returns table (action_id uuid, step_order integer, action_type text, target_label text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[]) then
    raise exception 'not authorized to view this channel''s scene presets' using errcode = '42501';
  end if;
  if not exists (select 1 from public.companion_scene_presets preset where preset.id = target_preset_id and preset.channel_id = target_channel_id) then
    raise exception 'scene preset not found' using errcode = 'P0002';
  end if;

  return query
    select action.id, action.step_order, action.action_type, action.target_label
      from public.companion_scene_preset_actions action
     where action.preset_id = target_preset_id
     order by action.step_order asc;
end
$$;

revoke execute on function app_private.list_companion_scene_preset_actions(uuid, uuid) from public;
grant execute on function app_private.list_companion_scene_preset_actions(uuid, uuid) to bsa_app;
