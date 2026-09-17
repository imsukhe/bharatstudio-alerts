-- GOA-04/GOA-09/GOA-18/GOA-19/GOA-20/GOA-21: the goal trigger engine --
-- SPINE ONLY (FULL-PRODUCT-DEFINITION.md S23.3, S31 register). See
-- bharatstudio-requirements/active/tasks/GOA-04-trigger-engine-spine.md
-- for the full task record.
--
-- WHAT "SPINE" MEANS HERE. This migration builds the part of S23.3 that
-- DECIDES WHETHER and IN WHAT ORDER something happens: rule configuration
-- (GOA-04/GOA-09), ordered per-step-delay sequencing (GOA-18), rule-level
-- conditions (GOA-19), the two non-configurable safety interlocks
-- (GOA-20), and the prepare-vs-fire default (GOA-21). It does NOT
-- implement what an action actually DOES on the overlay, in audio, OBS,
-- outbound or sponsor systems (GOA-10..GOA-17) -- those are separate,
-- later slices. Three "no-op" action types exist here purely so the
-- sequencing/interlock/prepare machinery has something concrete to move
-- through and to test (see the action_type check constraint below).
--
-- FIRES FROM EVENTS, LIKE 0150. Migration 0150 (commit 849bb02) is the
-- reason this engine exists in this shape: goal completion there is a
-- LATCHED, AUDITED EVENT (support_goal_completions), never a recomputed
-- boolean, because progress is derived from payments-minus-refunds and
-- can go down. This migration reuses that exact idempotent-latch shape
-- for its OWN crossing detection (goal_trigger_evaluations below) and,
-- for the reached_100 trigger type specifically, calls 0150's own
-- app_private.latch_support_goal_completion(goal_id) rather than
-- re-deriving "did this goal just complete" a second, divergent way.
-- 0150 ITSELF IS NOT MODIFIED BY ONE CHARACTER IN THIS FILE, and
-- app_private.support_goal_progress_paise (0102) stays the single,
-- unmodified source of truth for progress -- called here, never
-- shadowed.
--
-- SCOPE CUT, EXACTLY AS ASSIGNED (not a smaller cut made unilaterally):
--   GOA-04 -- only reached_100, threshold_percentage, threshold_absolute
--     and first_contribution. The full S31 register row additionally
--     lists "the closer", "biggest single contribution", "stretch steps",
--     "stalled N minutes", "expired unmet", "ladder step" and "all/any
--     goals complete" -- verbatim, and deliberately NOT built here. They
--     are a different, larger slice.
--   GOA-09 -- only enabled, threshold and once-per-stream/every-time.
--     The full row additionally lists "max N", "cooldown", "minimum
--     contribution", "quiet window" and "which contribution sources
--     count" -- not built here, for the same reason.
--   GOA-05/06/07/08 (session/platform/community/operational triggers),
--     GOA-10..GOA-17 (action implementations), GOA-17 itself
--     (CONTRADICTED, see the 2026-09-17 flag on that register row --
--     not built at all, in any form), GOA-22..GOA-26 (templates, depth,
--     preview, presets) -- all out of scope for this migration.
--
-- CONDITIONS THAT REFERENCE THINGS THAT DO NOT EXIST (GOA-19). "Only
-- live", "named scenes" and "not in Clutch" name concepts absent from
-- this schema today (no is_live/broadcast-status column anywhere; no
-- scene-profile table; Clutch Mode is CMP-17, not built). None of the
-- three is stubbed and no scene concept is invented -- the condition
-- TYPE exists (so a creator can record the intent and it can be wired up
-- the day the concept ships) but evaluating it today always FAILS SAFE:
-- the gated action does not fire. Only "not during a sponsor slot" is
-- evaluatable today, against the existing public.sponsor_cards (0145).
-- See app_private.dispatch_goal_trigger_sequence's condition loop below.
--
-- THE TWO INTERLOCKS THIS SLICE COVERS (GOA-20), AND WHY THEY ARE NOT A
-- ROW OF CONFIGURATION. The full S31 register row names five interlocks;
-- this slice implements the two that are meaningfully checkable against
-- what already exists in this schema -- "Clutch suppresses loud and
-- full-screen" and "our rate limits, not the platform's rejection" are
-- deferred (Clutch does not exist; rate limiting is a dispatch-time
-- concern for the action implementations this slice does not build).
-- "Never interrupt an alert mid-play" and "never-interrupt-gameplay
-- holds takeovers" both depend on state this schema does not have either
-- (an alert-playback cursor, a gameplay-safe-moment signal) and are
-- likewise not built. What IS built: loud/full-screen suppression is
-- evaluated from action_type alone, via an IMMUTABLE lookup function
-- (app_private.goal_trigger_action_severity), inside
-- dispatch_goal_trigger_sequence's own function body -- not from a
-- column, not from a parameter, not from anything an API call or a
-- creator-facing config table could set. Since Clutch state cannot be
-- evaluated (see above), this interlock currently fails safe for every
-- loud/full-screen action, every time, with no way to configure around
-- it. GOA-20 UNCONDITIONALLY (never creator-configurable): this is
-- SEPARATE from the optional, creator-added GOA-19 'not_in_clutch'
-- CONDITION a creator may attach to a whole rule (goal_trigger_
-- conditions) -- that condition is one more data row among four, also
-- fails safe today, but a creator choosing not to add it changes
-- nothing about the interlock below, which applies regardless.
--
-- PREPARE, NOT FIRE (GOA-21, S5.4). Every action_type is classified
-- 'local' or 'outbound_or_public' by app_private.goal_trigger_
-- action_class, an IMMUTABLE lookup keyed on action_type alone. A CHECK
-- CONSTRAINT on goal_trigger_actions (not application code) makes it
-- IMPOSSIBLE to store an outbound_or_public action with fire_mode =
-- 'fire' -- the only way to change what counts as outbound is a new
-- migration. fire_mode defaults to 'prepare' for every action, local or
-- not; a local action may be explicitly opted into 'fire' by the
-- creator, matching "low-risk local actions may auto-fire".
--
-- NOTHING INVENTED. No default delay, threshold, retry count, or bound
-- beyond structural ones (a percentage is 0-100 by definition, reusing
-- the exact shape 0149:192 and 0152:227 already use for
-- rollout_percentage; a paise amount must be positive) is chosen here.
-- delay_ms and every threshold value are creator-supplied at row-
-- creation time with no default beyond fire_mode='prepare' (GOA-21's own
-- decided default, not an invented one) and repeat_mode='once_per_stream'
-- (the safer of the two named options, reused as the default the same
-- way fire_mode defaults to the safer option).
--
-- NEVER TOUCHES: apps/web/app/overlay/canvas/ (getSubscriberCount stays
-- 16), migration 0150, app_private.support_goal_progress_paise. No
-- capability*/ctl_*/admin*/app_users/platform_owner* table or column is
-- created or altered.

-- =====================================================================
-- Classification helpers. IMMUTABLE, pure lookups on action_type alone
-- -- no table read, no parameter beyond the type itself. These are what
-- make GOA-20 and GOA-21 structural: a CHECK CONSTRAINT below calls
-- goal_trigger_action_class directly, so the constraint is re-evaluated
-- by Postgres on every insert/update and cannot be bypassed by any
-- column value, because it never reads a column that varies per row.
-- =====================================================================
create or replace function app_private.goal_trigger_action_class(target_action_type text)
returns text
language sql
immutable
as $$
  select case target_action_type
    when 'noop_local_quiet' then 'local'
    when 'noop_local_loud_or_fullscreen' then 'local'
    when 'noop_outbound' then 'outbound_or_public'
    else null
  end
$$;

revoke execute on function app_private.goal_trigger_action_class(text) from public;
grant execute on function app_private.goal_trigger_action_class(text) to public;
grant execute on function app_private.goal_trigger_action_class(text) to bsa_app;

create or replace function app_private.goal_trigger_action_severity(target_action_type text)
returns text
language sql
immutable
as $$
  select case target_action_type
    when 'noop_local_quiet' then 'quiet'
    when 'noop_local_loud_or_fullscreen' then 'loud_or_fullscreen'
    when 'noop_outbound' then 'quiet'
    else null
  end
$$;

revoke execute on function app_private.goal_trigger_action_severity(text) from public;
grant execute on function app_private.goal_trigger_action_severity(text) to public;
grant execute on function app_private.goal_trigger_action_severity(text) to bsa_app;

-- =====================================================================
-- goal_trigger_rules -- GOA-04 (trigger_type) + GOA-09 (enabled,
-- threshold, repeat_mode). One row per configured rule on one goal.
-- =====================================================================
create table public.goal_trigger_rules (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  goal_id uuid not null references public.support_goals(id),
  created_by_user_id uuid not null references public.app_users(id),

  -- GOA-04, exactly the four in scope -- see file header.
  trigger_type text not null check (trigger_type in (
    'reached_100', 'threshold_percentage', 'threshold_absolute', 'first_contribution'
  )),

  -- GOA-09 "enabled".
  enabled boolean not null default true,

  -- GOA-09 "threshold". A percentage is 0-100 by definition (the same
  -- bound shape 0149:192 and 0152:227 already use for
  -- rollout_percentage) -- not an invented business limit. 100 itself is
  -- accepted here even though 'reached_100' is a separate, dedicated
  -- trigger type: a creator may still configure a 100% threshold rule
  -- independently (e.g. with a different repeat_mode) without that being
  -- a conflict.
  threshold_percentage integer check (threshold_percentage between 1 and 100),
  -- A paise amount must be positive to mean anything; no minimum beyond
  -- that (unlike support_goals.target_amount_paise's >= 1000, which is
  -- 0102's OWN decided minimum for a goal target, not reused here for an
  -- unrelated concept -- a threshold is not a goal target).
  threshold_amount_paise bigint check (threshold_amount_paise > 0),

  -- GOA-09 "once-per-stream / every time". Defaults to the safer,
  -- narrower option, mirroring fire_mode's own "default to the safer
  -- choice" posture below.
  repeat_mode text not null default 'once_per_stream' check (repeat_mode in ('once_per_stream', 'every_time')),

  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,

  -- Exactly one threshold field is set, and only for the trigger_type
  -- that uses it -- reached_100 and first_contribution carry neither
  -- (their "threshold" is intrinsic to the type, not creator-supplied).
  check (
    (trigger_type = 'threshold_percentage' and threshold_percentage is not null and threshold_amount_paise is null)
    or (trigger_type = 'threshold_absolute' and threshold_amount_paise is not null and threshold_percentage is null)
    or (trigger_type in ('reached_100', 'first_contribution') and threshold_percentage is null and threshold_amount_paise is null)
  )
);

create index goal_trigger_rules_goal_idx on public.goal_trigger_rules (goal_id);
create index goal_trigger_rules_channel_idx on public.goal_trigger_rules (channel_id);

alter table public.goal_trigger_rules enable row level security;
revoke all on public.goal_trigger_rules from public;
revoke all on public.goal_trigger_rules from bsa_app;

-- =====================================================================
-- goal_trigger_conditions -- GOA-19. Rule-level; every condition on a
-- rule must pass (or be honestly reported as unevaluatable and fail
-- safe -- see dispatch_goal_trigger_sequence) for the rule's whole
-- sequence to proceed. condition_value is used only by named_scene (the
-- scene's name) -- and even then, evaluating it is not implemented (see
-- file header: no scene concept is invented here; the value is stored
-- so it is not lost the day scene profiles ship).
-- =====================================================================
create table public.goal_trigger_conditions (
  id uuid primary key,
  rule_id uuid not null references public.goal_trigger_rules(id),
  condition_type text not null check (condition_type in (
    'only_live', 'named_scene', 'not_in_clutch', 'not_during_sponsor_slot'
  )),
  condition_value text check (condition_value is null or char_length(condition_value) between 1 and 120),
  created_at timestamptz not null default current_timestamp,
  check (
    (condition_type = 'named_scene' and condition_value is not null)
    or (condition_type <> 'named_scene' and condition_value is null)
  )
);

create index goal_trigger_conditions_rule_idx on public.goal_trigger_conditions (rule_id);

alter table public.goal_trigger_conditions enable row level security;
revoke all on public.goal_trigger_conditions from public;
revoke all on public.goal_trigger_conditions from bsa_app;

-- =====================================================================
-- goal_trigger_actions -- GOA-18 (ordered, per-step delay, as DATA, not
-- an emergent property of row order) + GOA-21 (prepare-not-fire,
-- structurally enforced by the CHECK constraint below).
-- =====================================================================
create table public.goal_trigger_actions (
  id uuid primary key,
  rule_id uuid not null references public.goal_trigger_rules(id),

  -- GOA-18: explicit order and an explicit per-step delay. step_order is
  -- the ONLY thing dispatch_goal_trigger_sequence ever orders by --
  -- never id, never created_at, never insertion order.
  step_order integer not null check (step_order >= 0),
  delay_ms integer not null default 0 check (delay_ms >= 0),

  -- Minimal no-op action types, exactly enough to exercise sequencing,
  -- the interlock, and the prepare/fire default -- see file header.
  -- GOA-10..GOA-17's real action catalogue is a separate, later slice.
  action_type text not null check (action_type in (
    'noop_local_quiet', 'noop_local_loud_or_fullscreen', 'noop_outbound'
  )),

  -- GOA-21: defaults to 'prepare' for every action, local or outbound.
  fire_mode text not null default 'prepare' check (fire_mode in ('prepare', 'fire')),

  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,

  unique (rule_id, step_order),

  -- GOA-21, STRUCTURAL. Not application logic: a database CHECK
  -- constraint referencing an IMMUTABLE, action_type-only lookup
  -- (app_private.goal_trigger_action_class). There is no column, flag or
  -- API field anywhere in this schema through which an
  -- outbound_or_public action could be stored with fire_mode = 'fire' --
  -- Postgres itself refuses the row. The only way to change what counts
  -- as outbound is to ship a new migration that changes the
  -- classification function, which is exactly the bar GOA-20's sibling
  -- interlock is held to as well.
  check (app_private.goal_trigger_action_class(action_type) <> 'outbound_or_public' or fire_mode = 'prepare')
);

create index goal_trigger_actions_rule_idx on public.goal_trigger_actions (rule_id);

alter table public.goal_trigger_actions enable row level security;
revoke all on public.goal_trigger_actions from public;
revoke all on public.goal_trigger_actions from bsa_app;

-- =====================================================================
-- goal_trigger_evaluations -- the crossing latch. Reuses 0150's own
-- "idempotent by construction" shape (an append-only row, a partial
-- unique index for the narrower repeat mode) rather than inventing a
-- second idempotency mechanism.
--
-- source_event_id is the caller-supplied id of whatever real-world event
-- drove this evaluation attempt (a payment id, typically) EXCEPT for two
-- trigger types where the function overrides it internally (see
-- evaluate_goal_trigger_rule below):
--   reached_100        -- overridden to 0150's own completion id, so a
--                          reopen-and-recomplete (a genuinely NEW
--                          completion id) is a distinct crossing, and a
--                          retried call against the SAME completion is
--                          not.
--   first_contribution -- overridden to the rule's own id, because
--                          "the first contribution" can only ever be
--                          true once, full stop, regardless of the
--                          rule's configured repeat_mode (repeat_mode is
--                          still accepted for this trigger type, since
--                          GOA-09 does not carve out an exception, but it
--                          has no observable effect here -- documented,
--                          not silently ignored).
-- =====================================================================
create table public.goal_trigger_evaluations (
  id uuid primary key,
  rule_id uuid not null references public.goal_trigger_rules(id),
  goal_id uuid not null references public.support_goals(id),
  repeat_mode text not null check (repeat_mode in ('once_per_stream', 'every_time')),
  source_event_id uuid not null,
  evaluated_progress_paise bigint not null check (evaluated_progress_paise >= 0),
  target_amount_paise_at_evaluation bigint not null check (target_amount_paise_at_evaluation >= 1000),
  created_at timestamptz not null default current_timestamp
);

-- Retry safety, both repeat modes: the same real-world event can never
-- produce two evaluation rows for the same rule.
create unique index goal_trigger_evaluations_source_idx
  on public.goal_trigger_evaluations (rule_id, source_event_id);

-- GOA-09 "once-per-stream": at most one evaluation, ever, for a
-- once_per_stream rule -- regardless of how many distinct source events
-- would otherwise qualify. "Stream" here means the same stand-in 0102's
-- own header already established for support_goals.goal_window = 'stream'
-- (packages/db/migrations/0102_v1_l16_support_goals.sql:20-24): this
-- schema has no separate stream-session entity, so "once per stream"
-- reuses the goal's own lifecycle as the boundary, exactly as 0102's
-- precedent does. once_per_stream rows never repeat within a goal's
-- lifetime; "every_time" rows carry no such index and may accumulate one
-- row per distinct source event for as long as the condition holds.
create unique index goal_trigger_evaluations_once_idx
  on public.goal_trigger_evaluations (rule_id)
  where repeat_mode = 'once_per_stream';

create index goal_trigger_evaluations_goal_idx on public.goal_trigger_evaluations (goal_id, created_at desc);

alter table public.goal_trigger_evaluations enable row level security;
revoke all on public.goal_trigger_evaluations from public;
revoke all on public.goal_trigger_evaluations from bsa_app;

-- =====================================================================
-- goal_trigger_action_runs -- one row per action step per evaluation
-- that reached dispatch. This is the table GOA-18's ordering proof,
-- GOA-19's fail-safe proof, GOA-20's interlock proof and GOA-21's
-- prepare-not-fire proof all read back from.
-- =====================================================================
create table public.goal_trigger_action_runs (
  id uuid primary key,
  evaluation_id uuid not null references public.goal_trigger_evaluations(id),
  action_id uuid not null references public.goal_trigger_actions(id),
  -- Copied from the action at dispatch time, not re-read live -- GOA-18:
  -- order and delay are explicit data belonging to the composition,
  -- never re-derived from wherever the action row happens to live by the
  -- time a run is inspected.
  step_order integer not null,
  delay_ms integer not null,
  status text not null check (status in (
    'prepared', 'fired', 'blocked_interlock', 'blocked_condition'
  )),
  blocked_reason text check (blocked_reason is null or char_length(blocked_reason) between 1 and 500),
  created_at timestamptz not null default current_timestamp,
  check ((status in ('blocked_interlock', 'blocked_condition')) = (blocked_reason is not null))
);

create unique index goal_trigger_action_runs_unique_step_idx
  on public.goal_trigger_action_runs (evaluation_id, action_id);
create index goal_trigger_action_runs_evaluation_idx
  on public.goal_trigger_action_runs (evaluation_id, step_order asc);

alter table public.goal_trigger_action_runs enable row level security;
revoke all on public.goal_trigger_action_runs from public;
revoke all on public.goal_trigger_action_runs from bsa_app;

-- =====================================================================
-- Creator-facing configuration functions. Owner/admin write, matching
-- support_goals' own create_support_goal (0102) role bound; read is
-- owner/admin/operator/moderator -- this is creator/staff configuration,
-- not a viewer-facing surface (unlike 0150's get_channel_goal_completion,
-- which also allows 'viewer').
-- =====================================================================
create or replace function app_private.create_goal_trigger_rule(
  target_channel_id uuid,
  target_goal_id uuid,
  target_trigger_type text,
  target_threshold_percentage integer,
  target_threshold_amount_paise bigint,
  target_repeat_mode text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  goal public.support_goals%rowtype;
  new_id uuid;
  effective_repeat_mode text;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s goal triggers' using errcode = '42501';
  end if;

  select * into goal from public.support_goals where id = target_goal_id and channel_id = target_channel_id;
  if not found then
    raise exception 'support goal not found' using errcode = 'P0002';
  end if;

  if target_trigger_type not in ('reached_100', 'threshold_percentage', 'threshold_absolute', 'first_contribution') then
    raise exception 'invalid goal trigger type' using errcode = '22023';
  end if;
  if target_trigger_type = 'threshold_percentage' and (target_threshold_percentage is null or target_threshold_percentage not between 1 and 100 or target_threshold_amount_paise is not null) then
    raise exception 'threshold_percentage rules require threshold_percentage (1-100) and no threshold_amount_paise' using errcode = '22023';
  end if;
  if target_trigger_type = 'threshold_absolute' and (target_threshold_amount_paise is null or target_threshold_amount_paise <= 0 or target_threshold_percentage is not null) then
    raise exception 'threshold_absolute rules require a positive threshold_amount_paise and no threshold_percentage' using errcode = '22023';
  end if;
  if target_trigger_type in ('reached_100', 'first_contribution') and (target_threshold_percentage is not null or target_threshold_amount_paise is not null) then
    raise exception 'reached_100 and first_contribution rules carry no creator-supplied threshold' using errcode = '22023';
  end if;

  effective_repeat_mode := coalesce(target_repeat_mode, 'once_per_stream');
  if effective_repeat_mode not in ('once_per_stream', 'every_time') then
    raise exception 'invalid repeat_mode' using errcode = '22023';
  end if;

  new_id := gen_random_uuid();
  insert into public.goal_trigger_rules (
    id, channel_id, goal_id, created_by_user_id, trigger_type, enabled,
    threshold_percentage, threshold_amount_paise, repeat_mode, created_at, updated_at
  ) values (
    new_id, target_channel_id, target_goal_id, app_private.current_user_id(), target_trigger_type, true,
    target_threshold_percentage, target_threshold_amount_paise, effective_repeat_mode, current_timestamp, current_timestamp
  );

  return new_id;
end
$$;

revoke execute on function app_private.create_goal_trigger_rule(uuid, uuid, text, integer, bigint, text) from public;
grant execute on function app_private.create_goal_trigger_rule(uuid, uuid, text, integer, bigint, text) to bsa_app;

create or replace function app_private.set_goal_trigger_rule_enabled(
  target_channel_id uuid,
  target_rule_id uuid,
  target_enabled boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s goal triggers' using errcode = '42501';
  end if;

  update public.goal_trigger_rules
     set enabled = target_enabled, updated_at = current_timestamp
   where id = target_rule_id and channel_id = target_channel_id;

  if not found then
    raise exception 'goal trigger rule not found' using errcode = 'P0002';
  end if;
end
$$;

revoke execute on function app_private.set_goal_trigger_rule_enabled(uuid, uuid, boolean) from public;
grant execute on function app_private.set_goal_trigger_rule_enabled(uuid, uuid, boolean) to bsa_app;

create or replace function app_private.list_channel_goal_trigger_rules(
  target_channel_id uuid,
  target_goal_id uuid
)
returns table (
  rule_id uuid,
  goal_id uuid,
  trigger_type text,
  enabled boolean,
  threshold_percentage integer,
  threshold_amount_paise bigint,
  repeat_mode text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[]) then
    raise exception 'not authorized to view this channel''s goal triggers' using errcode = '42501';
  end if;

  return query
    select r.id, r.goal_id, r.trigger_type, r.enabled, r.threshold_percentage, r.threshold_amount_paise,
           r.repeat_mode, r.created_at, r.updated_at
      from public.goal_trigger_rules r
     where r.channel_id = target_channel_id and r.goal_id = target_goal_id
     order by r.created_at asc;
end
$$;

revoke execute on function app_private.list_channel_goal_trigger_rules(uuid, uuid) from public;
grant execute on function app_private.list_channel_goal_trigger_rules(uuid, uuid) to bsa_app;

create or replace function app_private.add_goal_trigger_condition(
  target_channel_id uuid,
  target_rule_id uuid,
  target_condition_type text,
  target_condition_value text
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
    raise exception 'not authorized to manage this channel''s goal triggers' using errcode = '42501';
  end if;

  if not exists (select 1 from public.goal_trigger_rules where id = target_rule_id and channel_id = target_channel_id) then
    raise exception 'goal trigger rule not found' using errcode = 'P0002';
  end if;

  if target_condition_type not in ('only_live', 'named_scene', 'not_in_clutch', 'not_during_sponsor_slot') then
    raise exception 'invalid goal trigger condition type' using errcode = '22023';
  end if;
  if target_condition_type = 'named_scene' and (target_condition_value is null or char_length(target_condition_value) not between 1 and 120) then
    raise exception 'named_scene requires a condition_value (1-120 characters)' using errcode = '22023';
  end if;
  if target_condition_type <> 'named_scene' and target_condition_value is not null then
    raise exception 'only named_scene accepts a condition_value' using errcode = '22023';
  end if;

  new_id := gen_random_uuid();
  insert into public.goal_trigger_conditions (id, rule_id, condition_type, condition_value, created_at)
  values (new_id, target_rule_id, target_condition_type, target_condition_value, current_timestamp);

  return new_id;
end
$$;

revoke execute on function app_private.add_goal_trigger_condition(uuid, uuid, text, text) from public;
grant execute on function app_private.add_goal_trigger_condition(uuid, uuid, text, text) to bsa_app;

create or replace function app_private.list_goal_trigger_conditions(
  target_channel_id uuid,
  target_rule_id uuid
)
returns table (
  condition_id uuid,
  condition_type text,
  condition_value text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[]) then
    raise exception 'not authorized to view this channel''s goal triggers' using errcode = '42501';
  end if;
  if not exists (select 1 from public.goal_trigger_rules where id = target_rule_id and channel_id = target_channel_id) then
    raise exception 'goal trigger rule not found' using errcode = 'P0002';
  end if;

  return query
    select c.id, c.condition_type, c.condition_value, c.created_at
      from public.goal_trigger_conditions c
     where c.rule_id = target_rule_id
     order by c.created_at asc;
end
$$;

revoke execute on function app_private.list_goal_trigger_conditions(uuid, uuid) from public;
grant execute on function app_private.list_goal_trigger_conditions(uuid, uuid) to bsa_app;

create or replace function app_private.add_goal_trigger_action(
  target_channel_id uuid,
  target_rule_id uuid,
  target_step_order integer,
  target_delay_ms integer,
  target_action_type text,
  target_fire_mode text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_id uuid;
  effective_fire_mode text;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s goal triggers' using errcode = '42501';
  end if;

  if not exists (select 1 from public.goal_trigger_rules where id = target_rule_id and channel_id = target_channel_id) then
    raise exception 'goal trigger rule not found' using errcode = 'P0002';
  end if;

  if target_action_type not in ('noop_local_quiet', 'noop_local_loud_or_fullscreen', 'noop_outbound') then
    raise exception 'invalid goal trigger action type' using errcode = '22023';
  end if;
  if target_step_order is null or target_step_order < 0 then
    raise exception 'step_order must be >= 0' using errcode = '22023';
  end if;
  if target_delay_ms is null or target_delay_ms < 0 then
    raise exception 'delay_ms must be >= 0' using errcode = '22023';
  end if;

  -- GOA-21: default to 'prepare' when the caller does not explicitly
  -- opt into 'fire'. This is the API-layer half of the default; the
  -- CHECK constraint on the table is the half that makes an outbound
  -- 'fire' impossible regardless of what any caller, present or future,
  -- ever sends.
  effective_fire_mode := coalesce(target_fire_mode, 'prepare');
  if effective_fire_mode not in ('prepare', 'fire') then
    raise exception 'invalid fire_mode' using errcode = '22023';
  end if;
  if effective_fire_mode = 'fire' and app_private.goal_trigger_action_class(target_action_type) = 'outbound_or_public' then
    raise exception 'outbound/public actions may never be configured to fire directly -- prepare only (GOA-21)' using errcode = '22023';
  end if;

  new_id := gen_random_uuid();
  insert into public.goal_trigger_actions (id, rule_id, step_order, delay_ms, action_type, fire_mode, created_at, updated_at)
  values (new_id, target_rule_id, target_step_order, target_delay_ms, target_action_type, effective_fire_mode, current_timestamp, current_timestamp);

  return new_id;
end
$$;

revoke execute on function app_private.add_goal_trigger_action(uuid, uuid, integer, integer, text, text) from public;
grant execute on function app_private.add_goal_trigger_action(uuid, uuid, integer, integer, text, text) to bsa_app;

create or replace function app_private.list_goal_trigger_actions(
  target_channel_id uuid,
  target_rule_id uuid
)
returns table (
  action_id uuid,
  step_order integer,
  delay_ms integer,
  action_type text,
  fire_mode text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[]) then
    raise exception 'not authorized to view this channel''s goal triggers' using errcode = '42501';
  end if;
  if not exists (select 1 from public.goal_trigger_rules where id = target_rule_id and channel_id = target_channel_id) then
    raise exception 'goal trigger rule not found' using errcode = 'P0002';
  end if;

  return query
    select a.id, a.step_order, a.delay_ms, a.action_type, a.fire_mode, a.created_at, a.updated_at
      from public.goal_trigger_actions a
     where a.rule_id = target_rule_id
     order by a.step_order asc;
end
$$;

revoke execute on function app_private.list_goal_trigger_actions(uuid, uuid) from public;
grant execute on function app_private.list_goal_trigger_actions(uuid, uuid) to bsa_app;

-- =====================================================================
-- The engine itself. No channel-role check -- system/event-driven
-- entry points, the same position 0150's own
-- latch_support_goal_completion occupies ("no channel-role decision to
-- make; that authorization lives in the callers", 0150's own header).
-- Live wiring of evaluate_goal_trigger_rule into the real payment/refund
-- processing path is explicitly OUT of scope for this spine slice (see
-- the task record) -- both functions are complete and independently
-- callable/testable, but nothing in this migration invokes them
-- automatically from a webhook or outbox worker.
-- =====================================================================
create or replace function app_private.evaluate_goal_trigger_rule(
  target_rule_id uuid,
  target_source_event_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  rule public.goal_trigger_rules%rowtype;
  goal public.support_goals%rowtype;
  progress bigint;
  effective_threshold bigint;
  effective_source_event_id uuid;
  new_id uuid;
begin
  select * into rule from public.goal_trigger_rules where id = target_rule_id;
  if not found or not rule.enabled then
    return null;
  end if;

  select * into goal from public.support_goals where id = rule.goal_id;
  if not found then
    return null;
  end if;

  progress := app_private.support_goal_progress_paise(goal.id);

  case rule.trigger_type
    when 'reached_100' then
      -- Fires FROM 0150's own latched completion event, never from a
      -- re-derived boolean -- see file header.
      effective_source_event_id := app_private.latch_support_goal_completion(goal.id);
      if effective_source_event_id is null then
        return null;
      end if;
    when 'first_contribution' then
      if progress < 1 then
        return null;
      end if;
      -- See goal_trigger_evaluations' own header: fixed to the rule's
      -- own id because "first" can only ever be true once.
      effective_source_event_id := target_rule_id;
    when 'threshold_percentage' then
      effective_threshold := ceil(goal.target_amount_paise::numeric * rule.threshold_percentage / 100.0);
      if target_source_event_id is null or progress < effective_threshold then
        return null;
      end if;
      effective_source_event_id := target_source_event_id;
    when 'threshold_absolute' then
      effective_threshold := rule.threshold_amount_paise;
      if target_source_event_id is null or progress < effective_threshold then
        return null;
      end if;
      effective_source_event_id := target_source_event_id;
    else
      raise exception 'unrecognised goal trigger type: %', rule.trigger_type using errcode = '22023';
  end case;

  begin
    new_id := gen_random_uuid();
    insert into public.goal_trigger_evaluations (
      id, rule_id, goal_id, repeat_mode, source_event_id, evaluated_progress_paise,
      target_amount_paise_at_evaluation, created_at
    ) values (
      new_id, rule.id, goal.id, rule.repeat_mode, effective_source_event_id, progress,
      goal.target_amount_paise, current_timestamp
    );
  exception when unique_violation then
    -- Already latched: either the exact same source event was retried,
    -- or (once_per_stream only) this rule has already fired once this
    -- goal's lifetime. Both are correct no-ops, not errors.
    return null;
  end;

  return new_id;
end
$$;

revoke execute on function app_private.evaluate_goal_trigger_rule(uuid, uuid) from public;
grant execute on function app_private.evaluate_goal_trigger_rule(uuid, uuid) to bsa_app;

create or replace function app_private.dispatch_goal_trigger_sequence(
  target_evaluation_id uuid
)
returns setof public.goal_trigger_action_runs
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  evaluation public.goal_trigger_evaluations%rowtype;
  rule public.goal_trigger_rules%rowtype;
  cond record;
  block_reason text;
  action_row record;
  severity text;
  run_status text;
  run_reason text;
begin
  select * into evaluation from public.goal_trigger_evaluations where id = target_evaluation_id;
  if not found then
    raise exception 'unknown goal trigger evaluation' using errcode = 'P0002';
  end if;

  -- Dispatch is itself idempotent: a retried caller for the same
  -- evaluation gets back the SAME run rows, never a second set.
  if exists (select 1 from public.goal_trigger_action_runs where evaluation_id = target_evaluation_id) then
    return query
      select * from public.goal_trigger_action_runs
       where evaluation_id = target_evaluation_id
       order by step_order asc;
    return;
  end if;

  select * into rule from public.goal_trigger_rules where id = evaluation.rule_id;

  -- GOA-19: rule-level conditions. The first failing/unevaluatable
  -- condition blocks the WHOLE sequence -- fail safe, never a silent
  -- pass on something this schema cannot actually check.
  block_reason := null;
  for cond in select * from public.goal_trigger_conditions where rule_id = rule.id order by created_at asc
  loop
    case cond.condition_type
      when 'only_live' then
        block_reason := 'only_live: unevaluatable -- no live/broadcast-status concept exists in this schema; fails safe (GOA-19)';
      when 'named_scene' then
        block_reason := 'named_scene: unevaluatable -- no scene-profile concept exists in this schema; fails safe (GOA-19)';
      when 'not_in_clutch' then
        block_reason := 'not_in_clutch: unevaluatable -- Clutch Mode (CMP-17) is absent from this repository; fails safe (GOA-19)';
      when 'not_during_sponsor_slot' then
        if exists (
          select 1 from public.sponsor_cards sc
           where sc.channel_id = rule.channel_id
             and sc.enabled
             and (
               (sc.schedule_starts_at is null and sc.schedule_ends_at is null)
               or (current_timestamp >= sc.schedule_starts_at and current_timestamp <= sc.schedule_ends_at)
             )
        ) then
          block_reason := 'not_during_sponsor_slot: a sponsor card is currently active for this channel (0145)';
        end if;
      else
        block_reason := format('%s: unrecognised condition type; fails safe', cond.condition_type);
    end case;
    exit when block_reason is not null;
  end loop;

  for action_row in select * from public.goal_trigger_actions where rule_id = rule.id order by step_order asc
  loop
    severity := app_private.goal_trigger_action_severity(action_row.action_type);

    if block_reason is not null then
      run_status := 'blocked_condition';
      run_reason := block_reason;
    elsif severity = 'loud_or_fullscreen' then
      -- GOA-20, UNCONDITIONAL. Reached purely from action_type via an
      -- IMMUTABLE lookup -- no column, parameter or stored flag anywhere
      -- in this schema changes this branch. Fails safe because Clutch
      -- Mode state cannot be evaluated (CMP-17 absent) -- identical
      -- reasoning to the not_in_clutch CONDITION above, but this path
      -- applies regardless of whether a creator ever added that
      -- condition to the rule.
      run_status := 'blocked_interlock';
      run_reason := 'loud_or_fullscreen actions are suppressed while Clutch Mode state cannot be evaluated (GOA-20; CMP-17 absent) -- not creator-configurable';
    elsif action_row.fire_mode = 'fire' then
      run_status := 'fired';
      run_reason := null;
    else
      run_status := 'prepared';
      run_reason := null;
    end if;

    insert into public.goal_trigger_action_runs (
      id, evaluation_id, action_id, step_order, delay_ms, status, blocked_reason, created_at
    ) values (
      gen_random_uuid(), target_evaluation_id, action_row.id, action_row.step_order, action_row.delay_ms,
      run_status, run_reason, current_timestamp
    );
  end loop;

  return query
    select * from public.goal_trigger_action_runs
     where evaluation_id = target_evaluation_id
     order by step_order asc;
end
$$;

revoke execute on function app_private.dispatch_goal_trigger_sequence(uuid) from public;
grant execute on function app_private.dispatch_goal_trigger_sequence(uuid) to bsa_app;

create or replace function app_private.list_goal_trigger_action_runs(
  target_channel_id uuid,
  target_evaluation_id uuid
)
returns table (
  run_id uuid,
  action_id uuid,
  step_order integer,
  delay_ms integer,
  status text,
  blocked_reason text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[]) then
    raise exception 'not authorized to view this channel''s goal triggers' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.goal_trigger_evaluations e
      join public.goal_trigger_rules r on r.id = e.rule_id
     where e.id = target_evaluation_id and r.channel_id = target_channel_id
  ) then
    raise exception 'goal trigger evaluation not found' using errcode = 'P0002';
  end if;

  return query
    select run.id, run.action_id, run.step_order, run.delay_ms, run.status, run.blocked_reason, run.created_at
      from public.goal_trigger_action_runs run
     where run.evaluation_id = target_evaluation_id
     order by run.step_order asc;
end
$$;

revoke execute on function app_private.list_goal_trigger_action_runs(uuid, uuid) from public;
grant execute on function app_private.list_goal_trigger_action_runs(uuid, uuid) to bsa_app;
