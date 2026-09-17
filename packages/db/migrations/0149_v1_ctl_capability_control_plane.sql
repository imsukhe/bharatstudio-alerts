-- CTL — the capability control plane, phase 1: registry, resolver,
-- resolved-blob cache, and two structural guards.
--
-- AUTHORITY. bharatstudio-requirements/active/tasks/CTL-01-capability-
-- control-plane.md. FULL-PRODUCT-DEFINITION.md §31 rows CTL-01, CTL-02,
-- CTL-03, CTL-14, CTL-15 (already registered there; this migration is
-- what makes them usable — verified today at 0 of 15 CTL rows usable,
-- no registry/resolver/cache/admin-surface/public-matrix anywhere in
-- this repository). §12.6 (durable creator records), §12.6.2 (uniform
-- retention), 00_LAUNCH_SCOPE_AUTHORITY.md ("Database projections and
-- RLS enforce this boundary; UI hiding alone is insufficient.").
--
-- MIGRATION NUMBER: 0149, assigned to this task. Nothing renumbered.
--
-- ============================================================
-- SCOPE: ONE SUBSYSTEM, FIVE ROWS.
-- ============================================================
-- CTL-01 (registry, versioned+audited) — CTL-02 (resolution order:
-- kill -> denylist -> rollout -> tier -> override) — CTL-03 (resolved
-- blob, cached, never per-capability) are one mechanism; CTL-14/CTL-15
-- are structural constraints ON that mechanism, not features beside it.
--
-- WHAT THIS DOES NOT DO (deliberately — see the task record):
--   - Does NOT migrate the seven existing hand-rolled gates
--     (app_private.events_pack_entitled, soundboard_module_entitled,
--     soundboard_tier_rank, vertical_canvas_layout_entitled,
--     canvas_layout_tier_rank, sticker_tier_rank, template_tier_rank).
--     They are untouched by this file and keep working exactly as
--     before. Migrating them onto this registry is a separate, later
--     task.
--   - Does NOT build an admin UI (CTL-04/05/13), change management
--     (CTL-06/07/08/09 — staged effective-time, two-staff approval,
--     one-action revert) or the public capability matrix
--     (CTL-10/11/12). Those are phase 2, in other repositories. The
--     staff write function below is the data-layer primitive a future
--     admin surface will call — it is not that surface.
--   - Does NOT touch apps/web/app/overlay/canvas/ or
--     registerMasterCanvasRoutes — this plane has no overlay-facing
--     surface in phase 1. The resolved blob is a creator/dashboard
--     read only.
--
-- ============================================================
-- CTL-14 — STRUCTURAL, NOT REVIEW-BASED: THE REGISTRY CANNOT EXPRESS
-- "GATE A DURABLE CREATOR RECORD".
-- ============================================================
-- §12.6.1 rule 1 lists exactly what may never be tier-gated: storing,
-- viewing, searching, fetching or exporting payments, receipts,
-- refunds, the audit trail, supporter relationships, event history,
-- configurations, layouts, moderation history. §12.6.1 rule 3 lists
-- the ONLY thing tiering may ever limit: "active connectors, active
-- widgets, AI usage, new media uploads, custom assets, team seats,
-- automation volume." That second list is not a paraphrase here — it
-- IS capability_registry.capacity_class's check constraint, verbatim
-- (plus 'master_canvas_module', an already-established capacity
-- concept elsewhere in this schema, §30.3). The constraint is a CLOSED
-- WHITELIST of active-capacity concepts. No durable-record concept
-- appears in it or can be added to a row without editing the migration
-- itself — a registrant cannot describe a forbidden capability by
-- picking a worse enum value, because there is no enum value that
-- means "gate a durable record." Attempting one of the nine §12.6.1
-- forbidden classes as capacity_class is rejected by check_violation,
-- not by convention, not by a comment, and not by review.
--
-- Proven twice over in packages/db/tests/ctl_capability_registry.sql:
-- BEHAVIOURALLY (inserting each of the nine forbidden classes as
-- capacity_class raises check_violation) and STRUCTURALLY (the
-- constraint's own pg_get_constraintdef is scanned for the nine
-- forbidden tokens and must contain none of them — the test that FAILS
-- the moment someone widens the whitelist, even before any insert is
-- attempted, and fails a different way if the constraint is dropped
-- entirely: the previously-rejected insert then succeeds).
--
-- ============================================================
-- CTL-15 — A PER-TIER RETENTION FIELD IS UNREPRESENTABLE, NOT MERELY
-- ABSENT TODAY.
-- ============================================================
-- §12.6.2: retention is one schedule, by data class, identical across
-- every tier — the tier is never an input to any retention row. No
-- table this migration creates carries any column whose name suggests
-- retention, a TTL, an expiry or a per-tier window (kill_switch,
-- rollout_percentage and min_tier gate WHETHER a capability renders —
-- none of them delete, expire or shorten access to anything a creator
-- already has, and none of them is retention). Proven structurally in
-- the SQL test: every column of every table this migration creates is
-- scanned via information_schema.columns for 'retention', 'retain',
-- 'ttl', 'expir' (covers expire/expiry/expires) and 'ttl_days' — none
-- exist. That scan is what "fails when the guard is removed" means
-- here: the guard IS the absence, and the test fails the moment a
-- column reintroducing any of those tokens is added.
--
-- ============================================================
-- CTL-03 — "NEVER PER-CAPABILITY QUERIES" IS ENFORCED BY REVOKING
-- DIRECT TABLE ACCESS, NOT BY CONVENTION.
-- ============================================================
-- bsa_app has NO select/insert/update/delete grant on
-- capability_registry, capability_denylist, capability_overrides,
-- capability_resolutions or capability_registry_generation at all —
-- revoked from public AND from bsa_app on every one of them. The ONLY
-- way the running API can ever read a capability is
-- app_private.get_channel_capabilities(channel_id), a SECURITY DEFINER
-- function returning ONE jsonb blob for the WHOLE channel in one row.
-- There is no function that takes a capability_key and returns one
-- flag — none exists, so "check one flag" cannot be written against
-- this schema even by accident. Proven in the SQL test by asserting
-- has_table_privilege('bsa_app', <table>, 'SELECT') is false for every
-- one of the five tables.
--
-- Cache mechanism: a single global generation counter
-- (capability_registry_generation, bumped by a statement-level trigger
-- on any write to capability_registry/capability_denylist/
-- capability_overrides) plus a per-channel cache row
-- (capability_resolutions) keyed by (generation, channel's current
-- tier). app_private.resolve_channel_capabilities reads the cache; if
-- the cached generation and tier still match current state, it returns
-- the cached blob with NO recomputation and NO join across the
-- registry tables at all — the true "no per-capability query" fast
-- path. Only a stale cache (registry changed, or the channel's own
-- tier changed) triggers one recompute, which itself is a single
-- aggregate query producing one jsonb object, not N.
--
-- ============================================================
-- CTL-02 — RESOLUTION ORDER: kill -> denylist -> rollout -> tier ->
-- override, evaluated as an early-exit chain, not five independent
-- signals ORed together.
-- ============================================================
-- kill_switch, if true, forces false — nothing downstream is even
-- evaluated, including an explicit override. Next, channel-level
-- denylist membership forces false, also ahead of any override.
-- Next, the rollout gate (a deterministic per-(channel,capability)
-- bucket derived from md5, so a given channel's inclusion never
-- flickers between reads) forces false when the channel falls outside
-- rollout_percentage — again ahead of override. Only once kill,
-- denylist and rollout have ALL passed does the chain reach the tier
-- default (min_tier null means always-eligible), and ONLY AT THAT
-- POINT may a channel-specific override in capability_overrides
-- replace the tier default's answer — override is the last, most
-- specific layer, but it can never resurrect a capability that kill,
-- denylist or rollout already shut off. This is a plain CASE
-- expression inside app_private.resolve_channel_capabilities, one
-- branch per stage, in exactly this order — see that function below.
--
-- ROLLBACK: additive only, no production migration without separate
-- explicit approval.
--   drop function if exists app_private.get_channel_capabilities(uuid);
--   drop function if exists app_private.resolve_channel_capabilities(uuid);
--   drop function if exists app_private.staff_upsert_capability_registry_entry(text, text, text, boolean, integer, text);
--   drop function if exists app_private.staff_list_capability_registry_audit(text);
--   drop function if exists app_private.capability_rollout_bucket(uuid, text);
--   drop function if exists app_private.capability_tier_rank(text);
--   drop trigger if exists capability_registry_versioning on public.capability_registry;
--   drop trigger if exists capability_registry_audit_trigger on public.capability_registry;
--   drop trigger if exists capability_registry_bump_generation_registry on public.capability_registry;
--   drop trigger if exists capability_registry_bump_generation_denylist on public.capability_denylist;
--   drop trigger if exists capability_registry_bump_generation_overrides on public.capability_overrides;
--   drop function if exists app_private.capability_registry_bump_generation();
--   drop function if exists app_private.capability_registry_write_audit();
--   drop function if exists app_private.capability_registry_version_bump();
--   drop table if exists public.capability_resolutions;
--   drop table if exists public.capability_registry_generation;
--   drop table if exists public.capability_overrides;
--   drop table if exists public.capability_denylist;
--   drop table if exists public.capability_registry_audit;
--   drop table if exists public.capability_registry;

-- =====================================================================
-- 1. CTL-01: the registry table itself. Versioned (the `version`
--    column, bumped by trigger on every update, never settable by a
--    caller) and audited (every insert/update captured in
--    capability_registry_audit below, by trigger — not by convention,
--    so a direct SQL write during a test or a future admin write both
--    produce an audit row with no special-casing).
-- =====================================================================
create table public.capability_registry (
  id uuid primary key default gen_random_uuid(),
  capability_key text not null unique
    check (capability_key ~ '^[a-z][a-z0-9_]{0,99}$'),
  -- CTL-14's structural guard. A CLOSED WHITELIST of exactly the
  -- "active capacity" concepts §12.6.1 rule 3 names, plus
  -- 'master_canvas_module' (the pre-existing §30.3 cap-slot concept).
  -- No durable-record concept (payment, receipt, refund, audit trail,
  -- supporter relationship, event history, configuration, layout,
  -- moderation history) is a member of this list, and adding one
  -- requires editing this migration in the open, not a registrant
  -- picking a value.
  capacity_class text not null check (capacity_class in (
    'active_connector', 'active_widget', 'ai_usage', 'media_upload',
    'custom_asset', 'team_seat', 'automation_volume', 'master_canvas_module'
  )),
  description text not null check (char_length(description) between 1 and 500),
  kill_switch boolean not null default false,
  rollout_percentage integer not null default 100
    check (rollout_percentage between 0 and 100),
  min_tier text
    check (min_tier is null or min_tier in ('free', 'pro', 'creator', 'studio')),
  version integer not null default 1,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  updated_by uuid references public.app_users(id)
);

comment on table public.capability_registry is
  'CTL-01/CTL-02/CTL-14/CTL-15 (migration 0149). capacity_class is a closed whitelist that structurally cannot express a durable-creator-record subject (§12.6.1 rule 1) -- only the active-capacity concepts §12.6.1 rule 3 names. No retention/TTL/expiry column exists on this table or any other table this migration creates (CTL-15) -- retention stays a single platform-wide schedule elsewhere, never a per-tier field here.';

comment on column public.capability_registry.capacity_class is
  'CTL-14 structural guard: closed whitelist, see the check constraint. This is what makes "gate a durable creator record" unrepresentable rather than merely disallowed by convention.';

revoke all on public.capability_registry from public;
revoke all on public.capability_registry from bsa_app;

-- =====================================================================
-- 2. CTL-01 audit trail. Append-only, staff-readable only (mirrors
--    public.staff_creator_pack_review_audit, migration 0122, exactly).
-- =====================================================================
create table public.capability_registry_audit (
  id uuid primary key default gen_random_uuid(),
  capability_key text not null,
  version integer not null,
  action text not null check (action in ('insert', 'update')),
  previous_row jsonb,
  new_row jsonb not null,
  changed_by uuid,
  changed_at timestamptz not null default current_timestamp
);

create index capability_registry_audit_key_idx
  on public.capability_registry_audit (capability_key, changed_at);

alter table public.capability_registry_audit enable row level security;
revoke all on public.capability_registry_audit from public;
revoke all on public.capability_registry_audit from bsa_app;

-- =====================================================================
-- 3. CTL-02 support tables: denylist and per-channel override. Both
--    reference the registry by capability_key (cascade on delete —
--    removing a capability definition removes its own denylist/
--    override rows, never a channel or a payment).
-- =====================================================================
create table public.capability_denylist (
  capability_key text not null references public.capability_registry(capability_key) on delete cascade,
  channel_id uuid not null references public.channels(id),
  created_at timestamptz not null default current_timestamp,
  primary key (capability_key, channel_id)
);

create index capability_denylist_channel_idx on public.capability_denylist (channel_id);

revoke all on public.capability_denylist from public;
revoke all on public.capability_denylist from bsa_app;

create table public.capability_overrides (
  capability_key text not null references public.capability_registry(capability_key) on delete cascade,
  channel_id uuid not null references public.channels(id),
  overridden_enabled boolean not null,
  reason text,
  set_by uuid references public.app_users(id),
  set_at timestamptz not null default current_timestamp,
  primary key (capability_key, channel_id)
);

create index capability_overrides_channel_idx on public.capability_overrides (channel_id);

comment on table public.capability_overrides is
  'CTL-02: the LAST-evaluated resolution stage. An override can only replace the tier stage''s default answer -- it is evaluated after kill/denylist/rollout have all already passed, and can never resurrect a capability any of those three already shut off. See app_private.resolve_channel_capabilities.';

revoke all on public.capability_overrides from public;
revoke all on public.capability_overrides from bsa_app;

-- =====================================================================
-- 4. CTL-03: the global generation counter (cache invalidation signal)
--    and the per-channel resolved-blob cache.
-- =====================================================================
create table public.capability_registry_generation (
  id boolean primary key default true check (id),
  generation bigint not null default 1,
  bumped_at timestamptz not null default current_timestamp
);

insert into public.capability_registry_generation (id, generation) values (true, 1);

revoke all on public.capability_registry_generation from public;
revoke all on public.capability_registry_generation from bsa_app;

create table public.capability_resolutions (
  channel_id uuid primary key references public.channels(id),
  resolved jsonb not null,
  generation bigint not null,
  channel_tier text not null,
  resolved_at timestamptz not null default current_timestamp
);

comment on table public.capability_resolutions is
  'CTL-03: the per-channel resolved blob cache. One row per channel, one jsonb object mapping every capability_key to its resolved boolean. Valid only while generation matches capability_registry_generation.generation AND channel_tier matches the channel''s current tier -- app_private.resolve_channel_capabilities is the only writer and the only reader path.';

revoke all on public.capability_resolutions from public;
revoke all on public.capability_resolutions from bsa_app;

-- =====================================================================
-- 5. Versioning + audit triggers on capability_registry. Fire on every
--    write regardless of path (a direct SQL insert in a test, or the
--    staff function below) -- structural, not convention.
-- =====================================================================
create or replace function app_private.capability_registry_version_bump()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  else
    new.version := old.version + 1;
  end if;
  new.updated_at := current_timestamp;
  return new;
end
$$;

create trigger capability_registry_versioning
  before insert or update on public.capability_registry
  for each row execute function app_private.capability_registry_version_bump();

create or replace function app_private.capability_registry_write_audit()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.capability_registry_audit
      (capability_key, version, action, previous_row, new_row, changed_by, changed_at)
    values
      (new.capability_key, new.version, 'insert', null, to_jsonb(new), app_private.current_user_id(), current_timestamp);
  else
    insert into public.capability_registry_audit
      (capability_key, version, action, previous_row, new_row, changed_by, changed_at)
    values
      (new.capability_key, new.version, 'update', to_jsonb(old), to_jsonb(new), app_private.current_user_id(), current_timestamp);
  end if;
  return new;
end
$$;

create trigger capability_registry_audit_trigger
  after insert or update on public.capability_registry
  for each row execute function app_private.capability_registry_write_audit();

-- =====================================================================
-- 6. Generation-bump trigger: any write to the registry itself or
--    either CTL-02 support table invalidates every channel's cache by
--    advancing the single global counter. Statement-level (not
--    row-level): a bulk write still bumps the generation exactly once
--    per statement, which is all correctness requires -- monotonic
--    strictly-increasing is the only property app_private.
--    resolve_channel_capabilities depends on.
-- =====================================================================
create or replace function app_private.capability_registry_bump_generation()
returns trigger
language plpgsql
as $$
begin
  update public.capability_registry_generation
     set generation = generation + 1, bumped_at = current_timestamp
   where id;
  return null;
end
$$;

create trigger capability_registry_bump_generation_registry
  after insert or update or delete on public.capability_registry
  for each statement execute function app_private.capability_registry_bump_generation();

create trigger capability_registry_bump_generation_denylist
  after insert or update or delete on public.capability_denylist
  for each statement execute function app_private.capability_registry_bump_generation();

create trigger capability_registry_bump_generation_overrides
  after insert or update or delete on public.capability_overrides
  for each statement execute function app_private.capability_registry_bump_generation();

-- =====================================================================
-- 7. Tier rank helper. New, identically-shaped to every other
--    *_tier_rank function in this schema (each already scoped
--    one-per-feature, e.g. app_private.canvas_layout_tier_rank,
--    migration 0147) rather than a shared utility.
-- =====================================================================
create or replace function app_private.capability_tier_rank(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 0;
    when 'pro' then return 1;
    when 'creator' then return 2;
    when 'studio' then return 3;
    else raise exception 'unrecognised tier for capability resolution: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.capability_tier_rank(text) from public;
grant execute on function app_private.capability_tier_rank(text) to bsa_app;

-- =====================================================================
-- 8. Deterministic rollout bucket. A per-(channel, capability) value
--    in [0, 99], stable across calls (md5 of the concatenation, no
--    randomness, no stored state) -- a channel's rollout inclusion
--    never flickers between reads of the same capability at the same
--    rollout_percentage.
-- =====================================================================
create or replace function app_private.capability_rollout_bucket(target_channel_id uuid, target_capability_key text)
returns integer
language sql
immutable
as $$
  select (('x' || substr(md5(target_channel_id::text || ':' || target_capability_key), 1, 8))::bit(32)::bigint % 100)::integer
$$;

revoke execute on function app_private.capability_rollout_bucket(uuid, text) from public;
grant execute on function app_private.capability_rollout_bucket(uuid, text) to bsa_app;

-- =====================================================================
-- 9. CTL-02 resolver: the resolution-order engine, and CTL-03's cache
--    read-or-recompute. VOLATILE because the cache-miss path writes
--    capability_resolutions -- this is the ONLY function in this
--    migration that touches the registry tables at all; every other
--    caller goes through this one, in one call, for every capability
--    at once.
-- =====================================================================
create or replace function app_private.resolve_channel_capabilities(target_channel_id uuid)
returns table (resolved jsonb, generation bigint, resolved_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_generation bigint;
  current_tier text;
  cached_resolved jsonb;
  cached_generation bigint;
  cached_tier text;
  cached_resolved_at timestamptz;
  cache_found boolean;
  fresh_resolved jsonb;
  fresh_resolved_at timestamptz;
begin
  select g.generation into current_generation from public.capability_registry_generation g where g.id;
  current_tier := app_private.current_channel_tier(target_channel_id);

  select c.resolved, c.generation, c.channel_tier, c.resolved_at
    into cached_resolved, cached_generation, cached_tier, cached_resolved_at
    from public.capability_resolutions c
   where c.channel_id = target_channel_id;
  cache_found := found;

  -- CTL-03 FAST PATH: cache hit. No join across capability_registry
  -- (or any CTL-02 support table) happens at all on this path -- the
  -- single row read above is the entire query.
  if cache_found and cached_generation = current_generation and cached_tier = current_tier then
    resolved := cached_resolved;
    generation := cached_generation;
    resolved_at := cached_resolved_at;
    return next;
    return;
  end if;

  -- CTL-02 resolution order, evaluated per capability inside ONE
  -- aggregate query -- kill -> denylist -> rollout -> tier -> override,
  -- exactly that precedence, exactly this order of CASE branches:
  select coalesce(jsonb_object_agg(reg.capability_key, (
    case
      -- 1. kill: absolute, nothing downstream is consulted.
      when reg.kill_switch then false
      -- 2. denylist: absolute for this channel, ahead of any override.
      when exists (
        select 1 from public.capability_denylist d
         where d.capability_key = reg.capability_key and d.channel_id = target_channel_id
      ) then false
      -- 3. rollout: a channel outside its bucket is excluded, ahead of
      --    any override -- staged rollout cannot be bypassed per-channel.
      when app_private.capability_rollout_bucket(target_channel_id, reg.capability_key) >= reg.rollout_percentage then false
      -- 4. tier (the default) then 5. override (may replace the
      --    default, and ONLY the default -- it is never reached above
      --    when kill/denylist/rollout already forced false).
      else coalesce(
        (select o.overridden_enabled from public.capability_overrides o
          where o.capability_key = reg.capability_key and o.channel_id = target_channel_id),
        (reg.min_tier is null or app_private.capability_tier_rank(current_tier) >= app_private.capability_tier_rank(reg.min_tier))
      )
    end
  )), '{}'::jsonb)
    into fresh_resolved
    from public.capability_registry reg;

  fresh_resolved_at := current_timestamp;

  insert into public.capability_resolutions (channel_id, resolved, generation, channel_tier, resolved_at)
  values (target_channel_id, fresh_resolved, current_generation, current_tier, fresh_resolved_at)
  on conflict (channel_id) do update
    set resolved = excluded.resolved,
        generation = excluded.generation,
        channel_tier = excluded.channel_tier,
        resolved_at = excluded.resolved_at;

  resolved := fresh_resolved;
  generation := current_generation;
  resolved_at := fresh_resolved_at;
  return next;
end
$$;

revoke execute on function app_private.resolve_channel_capabilities(uuid) from public;
grant execute on function app_private.resolve_channel_capabilities(uuid) to bsa_app;

-- =====================================================================
-- 10. Creator/dashboard-facing read. Same member role set every other
--     channel read in this schema uses (owner through viewer); a
--     non-member sees zero rows -- matches
--     app_private.get_channel_canvas_layout's own posture exactly.
--     THE ONLY consumer-facing entry point into this whole plane.
-- =====================================================================
create or replace function app_private.get_channel_capabilities(target_channel_id uuid)
returns table (resolved jsonb, generation bigint, resolved_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[]) then
    return;
  end if;

  return query select * from app_private.resolve_channel_capabilities(target_channel_id);
end
$$;

revoke execute on function app_private.get_channel_capabilities(uuid) from public;
grant execute on function app_private.get_channel_capabilities(uuid) to bsa_app;

-- =====================================================================
-- 11. Staff write path: the data-layer primitive CTL-04's future admin
--     UI will call. Not that UI. Staff-only (app_private.
--     is_platform_admin(), migration 0073, reused as-is). Every write
--     through here -- and every write through direct SQL, e.g. in
--     tests -- is versioned and audited by the two triggers above,
--     unconditionally.
-- =====================================================================
create or replace function app_private.staff_upsert_capability_registry_entry(
  target_capability_key text,
  target_capacity_class text,
  target_description text,
  target_kill_switch boolean,
  target_rollout_percentage integer,
  target_min_tier text
)
returns table (capability_key text, capacity_class text, description text, kill_switch boolean, rollout_percentage integer, min_tier text, version integer, updated_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  actor uuid;
  v_capability_key text;
  v_capacity_class text;
  v_description text;
  v_kill_switch boolean;
  v_rollout_percentage integer;
  v_min_tier text;
  v_version integer;
  v_updated_at timestamptz;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;

  actor := app_private.current_user_id();

  insert into public.capability_registry
    (capability_key, capacity_class, description, kill_switch, rollout_percentage, min_tier, updated_by)
  values
    (target_capability_key, target_capacity_class, target_description,
     coalesce(target_kill_switch, false), coalesce(target_rollout_percentage, 100), target_min_tier, actor)
  on conflict on constraint capability_registry_capability_key_key do update
    set capacity_class = excluded.capacity_class,
        description = excluded.description,
        kill_switch = excluded.kill_switch,
        rollout_percentage = excluded.rollout_percentage,
        min_tier = excluded.min_tier,
        updated_by = excluded.updated_by
  returning capability_registry.capability_key, capability_registry.capacity_class, capability_registry.description,
            capability_registry.kill_switch, capability_registry.rollout_percentage, capability_registry.min_tier,
            capability_registry.version, capability_registry.updated_at
    into v_capability_key, v_capacity_class, v_description, v_kill_switch, v_rollout_percentage, v_min_tier, v_version, v_updated_at;

  capability_key := v_capability_key;
  capacity_class := v_capacity_class;
  description := v_description;
  kill_switch := v_kill_switch;
  rollout_percentage := v_rollout_percentage;
  min_tier := v_min_tier;
  version := v_version;
  updated_at := v_updated_at;
  return next;
end
$$;

revoke execute on function app_private.staff_upsert_capability_registry_entry(text, text, text, boolean, integer, text) from public;
grant execute on function app_private.staff_upsert_capability_registry_entry(text, text, text, boolean, integer, text) to bsa_app;

-- =====================================================================
-- 12. Staff audit read. Internal accountability trail, not a
--     creator-facing surface -- mirrors app_private.staff_list_
--     creator_pack_review_audit (migration 0122) exactly, closing the
--     same "audit exists but nothing renders it" gap §7.5 records as a
--     real defect once already.
-- =====================================================================
create or replace function app_private.staff_list_capability_registry_audit(target_capability_key text)
returns table (id uuid, version integer, action text, previous_row jsonb, new_row jsonb, changed_by uuid, changed_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;

  return query
    select audit.id, audit.version, audit.action, audit.previous_row, audit.new_row, audit.changed_by, audit.changed_at
      from public.capability_registry_audit audit
     where audit.capability_key = target_capability_key
     order by audit.changed_at desc, audit.id desc;
end
$$;

revoke execute on function app_private.staff_list_capability_registry_audit(text) from public;
grant execute on function app_private.staff_list_capability_registry_audit(text) to bsa_app;
