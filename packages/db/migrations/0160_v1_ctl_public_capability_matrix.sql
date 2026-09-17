-- CTL-10/CTL-11/CTL-12 -- the public capability matrix: a published,
-- versioned snapshot; the marketing-section flag as its own field; the
-- public unauthenticated read path.
--
-- AUTHORITY. FULL-PRODUCT-DEFINITION.md §20.2, §20.4 ("How the marketing
-- site follows automatically"), §20.5 ("Full site behind flags").
-- bharatstudio-requirements/reviews/2026-09-17-three-owner-decisions-
-- goa17-marketing-bootstrap.md §2 ("marketing_section -- a separate
-- field, not a seventh kind") -- the decision that unblocks this
-- migration; CTL-12's task wording is corrected by that decision, not by
-- this file, and this migration does NOT add a seventh value to
-- capability_registry.kind (migration 0153's own enum, untouched).
--
-- MIGRATION NUMBER: 0160, pre-assigned. Fixture range ...7400-...74ff,
-- pre-assigned, own self-contained fixture in packages/db/tests/
-- ctl_public_capability_matrix.sql -- this migration does not touch
-- packages/db/tests/fixtures/00_base_world.sql, the same posture 0152/
-- 0153/0155/0157 all already took. Two other migrations (0159, 0161) run
-- concurrently in separate worktrees, own numbers, own fixture ranges --
-- this file does not glob the migrations directory and touches no other
-- lane's files.
--
-- ============================================================
-- WHY capacity_class HAD TO BECOME NULLABLE -- THE STRUCTURAL PROBLEM
-- THE OWNER DECISION'S "OWN FIELD" CREATES, AND HOW THIS FILE RESOLVES
-- IT WITHOUT WEAKENING CTL-14.
-- ============================================================
-- capability_registry.capacity_class (migration 0149) is NOT NULL and a
-- CLOSED WHITELIST of eight "active capacity" concepts (CTL-14) -- it
-- exists ONLY to make "gate a durable creator record" unrepresentable. A
-- marketing section is neither an active-capacity concept NOR a durable
-- creator record -- it is page content. Forcing a marketing-section row
-- to pick one of the eight whitelist values (calling a pricing-page hero
-- section "active_widget", say) would not merely be inaccurate, it would
-- corrupt CTL-14's guard: a future reader scanning capacity_class values
-- to understand what this schema thinks "active capacity" means would
-- see a page region misfiled as one. The owner decision's "own field"
-- must therefore also mean "capacity_class does not apply" -- so this
-- migration relaxes capacity_class from NOT NULL to nullable, and adds a
-- single combined check constraint (capability_registry_row_shape_check,
-- below) that requires EXACTLY ONE of two shapes for every row:
--   (a) a real capability: is_marketing_section = false,
--       capacity_class IS NOT NULL (from CTL-14's untouched whitelist);
--   (b) a marketing section: is_marketing_section = true, kind IS NULL
--       AND capacity_class IS NULL.
-- CTL-14's own whitelist enum (capability_registry_capacity_class_check,
-- 0149) is NOT touched by this migration -- still exactly the same eight
-- values, still contains no durable-record concept. Relaxing NOT NULL is
-- backward-compatible: every row that exists before this migration
-- already has a non-null capacity_class, so the combined check is
-- trivially satisfied by every existing row without a data migration.
-- Proven in packages/db/tests/ctl_public_capability_matrix.sql: CTL-14's
-- nine forbidden classes are still rejected as capacity_class (behaviour
-- unchanged), AND a marketing-section row with a non-null capacity_class
-- is rejected by the NEW combined constraint, AND an ordinary capability
-- with a null capacity_class is rejected by the same constraint.
--
-- ============================================================
-- WHY A DEDICATED WRITE PATH FOR MARKETING-SECTION ROWS, NOT 0157'S
-- TWELVE-FIELD WORKFLOW -- REPORTED, NOT GLOSSED OVER.
-- ============================================================
-- app_private.staff_propose_capability_change (0152/0157) ALWAYS writes
-- proposed_capacity_class verbatim to app_private.set_capability_
-- registry_entry_unchecked -- capacity_class is full-replace, never
-- coalesced from the current row, for every change proposed through
-- that workflow (see 0157's own apply_due_capability_change, the five
-- original fields' semantics, untouched by this migration). Routing a
-- marketing-section row's kill_switch/marketing_visible/marketing_label/
-- marketing_blurb changes through that workflow would therefore FORCE a
-- non-null capacity_class back onto the row on every single change --
-- directly violating the row-shape constraint this migration just
-- added, on the very next propose/approve/apply cycle. That workflow is
-- not reachable for a marketing-section row without also widening
-- staff_propose_capability_change/apply_due_capability_change's
-- signatures, which this migration does not do (out of scope for
-- CTL-10/11/12, and both of those functions carry their own exact-
-- signature evidence this migration must not disturb -- see 0157's own
-- header for the two assertions a widened signature would break).
--
-- This migration therefore ships app_private.staff_create_marketing_
-- section (creates a NEW marketing-section row only) and app_private.
-- staff_set_capability_marketing_section (updates an EXISTING one only).
-- Neither is "a path that changes a [real] capability outside" 0157's
-- workflow: staff_set_capability_marketing_section's FIRST line, after
-- the admin gate, is `if not (select is_marketing_section from ...) then
-- raise exception`, so calling it against any row where is_marketing_
-- section is false (every real capability, by the row-shape constraint)
-- fails closed with 42501, structurally, before it can touch anything.
-- It can never be used to change kill_switch/marketing_visible/
-- marketing_label/marketing_blurb on a capability the two-person
-- workflow governs -- only on a row the owner decision itself says is
-- not a capability at all. This is the same posture 0153 took when it
-- first shipped single-admin immediate writes for kind/limits/beta/
-- marketing_visible/marketing_label/marketing_blurb, before 0157 later
-- layered two-person governance on top FOR REAL CAPABILITIES
-- specifically -- staging equivalent governance for marketing-section
-- rows (a propose/approve/apply variant scoped to is_marketing_section
-- rows) is real, bounded follow-up work, reported here exactly as 0153
-- reported its own gap, not built in this migration.
--
-- ============================================================
-- CTL-10 -- THE PUBLIC READ IS A PROPERTY OF THE DECLARED RETURN TYPE.
-- ============================================================
-- app_private.get_public_capability_matrix() returns table (capability_id
-- text, marketing_label text, marketing_blurb text, min_tier text,
-- is_marketing_section boolean, snapshot_version integer, published_at
-- timestamptz) -- SEVEN COLUMNS, period. §20.4's own line ("capability
-- id, marketing label, blurb, and the minimum tier") plus is_marketing_
-- section (CTL-12's field, so the marketing build can tell a page-region
-- flag from a capability entry in the ONE snapshot both now share -- see
-- the owner decision's own "cost, honestly" paragraph) plus the two
-- snapshot-identity fields every row in this response repeats
-- (snapshot_version, published_at) so a caller can tell WHICH published
-- version it is looking at without a second request. This is not a
-- serialiser choice -- there is no capacity_class, limits, rollout,
-- kill_switch, beta, audit, or channel-identifying column anywhere in
-- this function's OUT parameter list, so no code path through this
-- function, ever, in any future edit that does not also change this
-- signature, can return one. Proven in packages/db/tests/
-- ctl_public_capability_matrix.sql against information_schema.parameters
-- (the exact string, nothing else) and behaviourally (a capability with
-- every forbidden field populated appears in the response with ONLY the
-- seven allowed values, and a non-marketing_visible / killed capability
-- is entirely ABSENT, not merely nulled out).
--
-- No new grant to bsa_app on any table (CTL-03 preserved): bsa_app has
-- SELECT/INSERT/UPDATE/DELETE on nothing this migration creates --
-- capability_matrix_snapshots is revoked from public AND bsa_app, same
-- as every CTL-02/CTL-03 table before it. The only bsa_app-reachable
-- surface is EXECUTE on the two SECURITY DEFINER functions below
-- (get_public_capability_matrix, granted; the two staff functions,
-- also granted -- gated internally by is_platform_admin(), the same
-- posture every other staff write in this file already uses).
--
-- ============================================================
-- CTL-10/CTL-11 -- A PUBLISHED SNAPSHOT, NOT A LIVE QUERY.
-- ============================================================
-- capability_matrix_snapshots is append-only (app_private.
-- reject_table_mutation, migration 0155's shared trigger function,
-- reused verbatim -- before update or delete). app_private.staff_
-- publish_capability_matrix_snapshot computes ONE new row: every
-- capability_registry row where marketing_visible AND NOT kill_switch,
-- projected to exactly the four public-facing fields plus is_marketing_
-- section, as one jsonb array, with a strictly-increasing integer
-- version (max(version)+1, computed and inserted inside one function
-- call -- the ordinary small-concurrency-window caveat every other
-- max()+1 pattern in this schema already carries, not a new one).
-- get_public_capability_matrix reads ONLY the latest snapshot row -- it
-- never joins capability_registry at all, so a half-applied admin edit
-- (a propose approved but not yet applied; an UPDATE mid-transaction)
-- is never visible on the public path, and a caller comparing
-- snapshot_version across two reads can tell a stale CDN copy from a
-- fresh one by the version number alone, without needing published_at
-- (included anyway, for a human-readable staleness signal). Filtering
-- kill_switch = false AT PUBLISH TIME, not just marketing_visible, is a
-- deliberate reading of §20.3 ("global_kill -> off for everyone,
-- immediately") applied to the marketing surface: an emergency kill
-- (§20.6.1) stops the capability from rendering for a creator AND stops
-- the marketing site from claiming it works, in the same publish. This
-- is not a new numeric value or a new legal claim -- it is the existing
-- kill_switch column read the same way §20.3 already defines it.
--
-- ============================================================
-- CTL-11 -- WEBHOOK REVALIDATION HAS NO DATA-LAYER SURFACE HERE.
-- ============================================================
-- "The marketing build reads the snapshot; webhook revalidation" is an
-- API-layer and marketing-repo concern (apps/api/src/routes/
-- capability-matrix-admin.ts calls OUT to the marketing site's own
-- revalidation endpoint after a successful publish, carrying only the
-- new version number as a trigger signal -- never capability rows; see
-- that file's own header). Nothing in this migration accepts an inbound
-- webhook call or grants bsa_app any new inbound surface for one --
-- see this task's own "webhook must not become an authenticated hole"
-- constraint, which is why no such surface exists at the database layer
-- at all.
--
-- ============================================================
-- RESOLVER CHANGE -- MARKETING-SECTION ROWS NEVER ENTER A CHANNEL'S
-- RESOLVED CAPABILITY BLOB.
-- ============================================================
-- app_private.resolve_channel_capabilities (0149/0153) aggregates every
-- capability_registry row into one per-channel jsonb blob -- a creator/
-- dashboard concern (CTL-03). A marketing-section row is, by the owner
-- decision, "not something a creator is entitled to" -- it has no
-- meaningful per-channel resolution (no creator ever asks "is this page
-- region entitled for my channel"). Left unfiltered, is_marketing_
-- section rows would still flow into every channel's resolved blob
-- (harmless to CTL-03's signature -- the function still returns exactly
-- resolved/generation/resolved_at -- but semantically wrong: a page-
-- region flag has no business appearing next to a channel's real
-- capability entitlements). This migration adds ONE filter,
-- `where not reg.is_marketing_section`, to the resolver's aggregate
-- query -- body-only CREATE OR REPLACE, signature UNCHANGED from 0153,
-- verified unchanged against the SAME exact-output-column assertion
-- packages/db/tests/ctl_capability_registry.sql and packages/db/tests/
-- ctl_registry_spec_alignment.sql already run for this function. Proven
-- in this migration's own SQL test: a marketing-section row and an
-- ordinary capability both entitled the same way for the same channel
-- resolve to a blob containing ONLY the ordinary capability's key.
--
-- ============================================================
-- OUT OF SCOPE (deliberately).
-- ============================================================
--   - A propose/approve/apply variant of governance for marketing-
--     section rows -- reported above as real, bounded follow-up work.
--   - Any admin UI for the public matrix -- CTL-04/05/13, other
--     repositories/lanes, exactly as 0149's own header already drew
--     this line for the registry admin surface in general.
--   - apps/web/app/overlay/canvas/ -- not touched; this plane still has
--     no overlay-facing surface.
--   - The marketing repository's own build/webhook-receiver code --
--     touched in the SEPARATE bharatstudio-marketing repository this
--     task explicitly permits, reported in this task's own return
--     contract, NOT part of this migration or this repository's
--     committed history.
--
-- ROLLBACK: additive only, no production migration without separate
-- explicit approval.
--   drop function if exists app_private.get_public_capability_matrix();
--   drop function if exists app_private.staff_publish_capability_matrix_snapshot(text);
--   drop function if exists app_private.staff_list_capability_matrix_snapshots();
--   drop function if exists app_private.staff_set_capability_marketing_section(text, boolean, boolean, text, text);
--   drop function if exists app_private.staff_create_marketing_section(text, text, boolean, boolean, text, text);
--   drop function if exists app_private.resolve_channel_capabilities(uuid); -- restored to 0153's original body by re-running 0153 unmodified
--   drop table if exists public.capability_matrix_snapshots;
--   alter table public.capability_registry
--     drop constraint if exists capability_registry_row_shape_check,
--     drop column if exists is_marketing_section,
--     alter column capacity_class set not null; -- only safe if no row was actually written with a null capacity_class; the migration author of any future rollback must verify this first

-- =====================================================================
-- 1. capability_registry: relax capacity_class, add is_marketing_section,
--    add the combined row-shape constraint. See header for the full
--    reasoning.
-- =====================================================================
alter table public.capability_registry
  alter column capacity_class drop not null,
  add column is_marketing_section boolean not null default false,
  add constraint capability_registry_row_shape_check
    check (
      (is_marketing_section and kind is null and capacity_class is null)
      or
      (not is_marketing_section and capacity_class is not null)
    );

comment on column public.capability_registry.is_marketing_section is
  'CTL-12 (migration 0160), per the owner decision 2026-09-17 (bharatstudio-requirements/reviews/2026-09-17-three-owner-decisions-goa17-marketing-bootstrap.md, section 2): a marketing section is a page region, not a capability a creator is entitled to, so it gets its OWN field rather than a seventh value in kind''s enum. capability_registry_row_shape_check enforces the split structurally: true implies kind IS NULL and capacity_class IS NULL (never claims CTL-14''s active-capacity taxonomy or section 20.2''s capability-kind taxonomy); false (the default, every pre-existing row) implies capacity_class IS NOT NULL, unchanged from migration 0149. Never entitled per-channel -- app_private.resolve_channel_capabilities excludes every is_marketing_section row from its resolved blob (migration 0160). Created only via app_private.staff_create_marketing_section; kill_switch/marketing_visible/marketing_label/marketing_blurb updated only via app_private.staff_set_capability_marketing_section, which refuses any row where this column is false -- neither function can ever touch a real capability''s governed fields, so this is not a bypass of migration 0157''s two-person workflow.';

comment on constraint capability_registry_row_shape_check on public.capability_registry is
  'Migration 0160. Exactly two admissible shapes: a marketing section (is_marketing_section, kind and capacity_class both null) or an ordinary capability (not is_marketing_section, capacity_class required -- CTL-14''s closed whitelist, migration 0149, unchanged). A row can never claim both a capacity_class and marketing-section status, and can never omit capacity_class while claiming to be an ordinary capability.';

-- =====================================================================
-- 2. CTL-03 resolver: exclude marketing-section rows from the per-
--    channel resolved blob. Body-only CREATE OR REPLACE; signature
--    identical to 0149/0153 (resolved jsonb, generation bigint,
--    resolved_at timestamptz) -- every line below is 0153's own body
--    verbatim except the added `where not reg.is_marketing_section` on
--    the aggregate query.
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

  -- CTL-03 FAST PATH: cache hit, unchanged from 0149/0153 -- no join
  -- across capability_registry or any CTL-02 support table happens on
  -- this path at all.
  if cache_found and cached_generation = current_generation and cached_tier = current_tier then
    resolved := cached_resolved;
    generation := cached_generation;
    resolved_at := cached_resolved_at;
    return next;
    return;
  end if;

  -- §20.3 resolution order, unchanged from 0153 (kill -> denylist ->
  -- allowlist -> rollout -> tier -> override). The ONLY change in this
  -- migration: `where not reg.is_marketing_section` on the source scan
  -- -- a marketing-section row (CTL-12) never has a per-channel
  -- entitlement question to answer, so it never enters this blob.
  select coalesce(jsonb_object_agg(reg.capability_key, (
    case
      when reg.kill_switch then false
      when exists (
        select 1 from public.capability_denylist d
         where d.capability_key = reg.capability_key and d.channel_id = target_channel_id
      ) then false
      when exists (
        select 1 from public.capability_allowlist a
         where a.capability_key = reg.capability_key and a.channel_id = target_channel_id
      ) then true
      when app_private.capability_rollout_bucket(target_channel_id, reg.capability_key) >= reg.rollout_percentage then false
      else coalesce(
        (select o.overridden_enabled from public.capability_overrides o
          where o.capability_key = reg.capability_key and o.channel_id = target_channel_id),
        (reg.min_tier is null or app_private.capability_tier_rank(current_tier) >= app_private.capability_tier_rank(reg.min_tier))
      )
    end
  )), '{}'::jsonb)
    into fresh_resolved
    from public.capability_registry reg
   where not reg.is_marketing_section;

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

-- =====================================================================
-- 3. CTL-12 write path, part 1: create a brand-new marketing-section
--    row. Single-admin, immediate -- mirrors 0155 Job 3's own carve-out
--    ("creating a brand-new capability alone is acceptable, nothing is
--    live for it yet"), applied to marketing sections. Rejects an
--    existing capability_key outright (never overwrites either a real
--    capability or an existing marketing section -- use
--    staff_set_capability_marketing_section for the latter).
-- =====================================================================
create or replace function app_private.staff_create_marketing_section(
  target_capability_key text,
  target_description text,
  target_kill_switch boolean,
  target_marketing_visible boolean,
  target_marketing_label text,
  target_marketing_blurb text
)
returns table (
  capability_key text, description text, kill_switch boolean, is_marketing_section boolean,
  marketing_visible boolean, marketing_label text, marketing_blurb text,
  version integer, updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  actor uuid;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;

  if exists (select 1 from public.capability_registry reg where reg.capability_key = target_capability_key) then
    raise exception 'capability_key % already exists -- use staff_set_capability_marketing_section for an existing marketing section, or the two-person capability_change_requests workflow for an existing capability', target_capability_key using errcode = '42501';
  end if;

  actor := app_private.current_user_id();

  insert into public.capability_registry
    (capability_key, capacity_class, kind, description, kill_switch, rollout_percentage, min_tier,
     is_marketing_section, marketing_visible, marketing_label, marketing_blurb, updated_by)
  values
    (target_capability_key, null, null, target_description, coalesce(target_kill_switch, false), 100, null,
     true, coalesce(target_marketing_visible, false), target_marketing_label, target_marketing_blurb, actor)
  returning capability_registry.capability_key, capability_registry.description, capability_registry.kill_switch,
            capability_registry.is_marketing_section, capability_registry.marketing_visible,
            capability_registry.marketing_label, capability_registry.marketing_blurb,
            capability_registry.version, capability_registry.updated_at
    into capability_key, description, kill_switch, is_marketing_section, marketing_visible, marketing_label, marketing_blurb, version, updated_at;

  return next;
end
$$;

revoke execute on function app_private.staff_create_marketing_section(text, text, boolean, boolean, text, text) from public;
grant execute on function app_private.staff_create_marketing_section(text, text, boolean, boolean, text, text) to bsa_app;

-- =====================================================================
-- 4. CTL-12 write path, part 2: change an EXISTING marketing-section
--    row's kill_switch/marketing_visible/marketing_label/marketing_blurb.
--    Structurally cannot touch a real capability: the is_marketing_section
--    guard below is the FIRST thing checked after the admin gate, and
--    fails closed (42501) before any write is attempted. Full-replace
--    semantics for all four fields (the same "supply the complete
--    desired state" idiom 0149's own staff_upsert_capability_registry_
--    entry established) -- simpler than 0157's NULL-as-sentinel merge,
--    and correct here because this function's only two callers (a
--    human admin action, or a future admin UI) always have the current
--    row in hand already (this function's own companion read is
--    app_private.staff_get_capability_registry_entry, migration 0153,
--    unchanged, which already projects is_marketing_section via
--    `select *`-shaped... -- see note below on why that read is NOT
--    widened in this migration).
-- =====================================================================
create or replace function app_private.staff_set_capability_marketing_section(
  target_capability_key text,
  target_kill_switch boolean,
  target_marketing_visible boolean,
  target_marketing_label text,
  target_marketing_blurb text
)
returns table (
  capability_key text, description text, kill_switch boolean, is_marketing_section boolean,
  marketing_visible boolean, marketing_label text, marketing_blurb text,
  version integer, updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  actor uuid;
  row_is_section boolean;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;

  select reg.is_marketing_section into row_is_section
    from public.capability_registry reg
   where reg.capability_key = target_capability_key;

  if not found then
    raise exception 'capability_key % does not exist -- use staff_create_marketing_section to create it first', target_capability_key using errcode = '22023';
  end if;

  if not row_is_section then
    raise exception 'capability_key % is a real capability, not a marketing section -- its kill_switch/marketing_visible/marketing_label/marketing_blurb must go through the two-person capability_change_requests workflow (CTL-06/07), not this function', target_capability_key using errcode = '42501';
  end if;

  actor := app_private.current_user_id();

  update public.capability_registry reg
     set kill_switch = coalesce(target_kill_switch, false),
         marketing_visible = coalesce(target_marketing_visible, false),
         marketing_label = target_marketing_label,
         marketing_blurb = target_marketing_blurb,
         updated_by = actor
   where reg.capability_key = target_capability_key
  returning reg.capability_key, reg.description, reg.kill_switch, reg.is_marketing_section,
            reg.marketing_visible, reg.marketing_label, reg.marketing_blurb, reg.version, reg.updated_at
    into capability_key, description, kill_switch, is_marketing_section, marketing_visible, marketing_label, marketing_blurb, version, updated_at;

  return next;
end
$$;

revoke execute on function app_private.staff_set_capability_marketing_section(text, boolean, boolean, text, text) from public;
grant execute on function app_private.staff_set_capability_marketing_section(text, boolean, boolean, text, text) to bsa_app;

-- =====================================================================
-- 5. CTL-10: the published-snapshot table. Append-only (reject_table_
--    mutation, migration 0155's shared trigger function -- before
--    update or delete). Revoked from public AND bsa_app, same CTL-03
--    posture as every table in this plane -- the only reachable read
--    path is app_private.get_public_capability_matrix below.
-- =====================================================================
create table public.capability_matrix_snapshots (
  id uuid primary key default gen_random_uuid(),
  version integer not null,
  published_at timestamptz not null default current_timestamp,
  published_by uuid references public.app_users(id),
  reason text,
  row_count integer not null,
  rows jsonb not null
);

create unique index capability_matrix_snapshots_version_idx on public.capability_matrix_snapshots (version);

comment on table public.capability_matrix_snapshots is
  'CTL-10 (migration 0160): the published, versioned snapshot GET /v1/public/capability-matrix serves. Append-only -- see the trigger below. Written ONLY by app_private.staff_publish_capability_matrix_snapshot, from capability_registry rows where marketing_visible AND NOT kill_switch, projected to exactly capability_id/marketing_label/marketing_blurb/min_tier/is_marketing_section per row -- no capacity_class, limits, rollout, beta, or audit data is ever computed into a snapshot row, so the public read function cannot leak what was never written here. version is strictly increasing (max(version)+1 at publish time); a caller comparing snapshot_version across two reads of the public endpoint can identify a stale copy without a second field.';

revoke all on public.capability_matrix_snapshots from public;
revoke all on public.capability_matrix_snapshots from bsa_app;

create trigger capability_matrix_snapshots_append_only
  before update or delete on public.capability_matrix_snapshots
  for each row execute function app_private.reject_table_mutation();

-- =====================================================================
-- 6. CTL-10/CTL-11: publish a new snapshot. Staff-only. Computes the
--    public-facing projection in one aggregate query and inserts it as
--    the next version -- the ONLY writer of capability_matrix_snapshots.
-- =====================================================================
create or replace function app_private.staff_publish_capability_matrix_snapshot(target_reason text)
returns table (id uuid, version integer, published_at timestamptz, row_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  actor uuid;
  next_version integer;
  snapshot_rows jsonb;
  computed_row_count integer;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;

  actor := app_private.current_user_id();

  select coalesce(max(s.version), 0) + 1 into next_version from public.capability_matrix_snapshots s;

  select coalesce(jsonb_agg(jsonb_build_object(
           'capability_id', reg.capability_key,
           'marketing_label', reg.marketing_label,
           'marketing_blurb', reg.marketing_blurb,
           'min_tier', reg.min_tier,
           'is_marketing_section', reg.is_marketing_section
         ) order by reg.capability_key), '[]'::jsonb),
         count(*)
    into snapshot_rows, computed_row_count
    from public.capability_registry reg
   where reg.marketing_visible and not reg.kill_switch;

  insert into public.capability_matrix_snapshots (version, published_by, reason, row_count, rows)
  values (next_version, actor, target_reason, computed_row_count, snapshot_rows)
  returning capability_matrix_snapshots.id, capability_matrix_snapshots.version,
            capability_matrix_snapshots.published_at, capability_matrix_snapshots.row_count
    into id, version, published_at, row_count;

  return next;
end
$$;

revoke execute on function app_private.staff_publish_capability_matrix_snapshot(text) from public;
grant execute on function app_private.staff_publish_capability_matrix_snapshot(text) to bsa_app;

-- =====================================================================
-- 7. Staff introspection: snapshot publish history. Mirrors app_private.
--    staff_list_capability_registry_audit (0149) exactly -- an internal
--    accountability trail, not the public surface.
-- =====================================================================
create or replace function app_private.staff_list_capability_matrix_snapshots()
returns table (id uuid, version integer, published_at timestamptz, published_by uuid, reason text, row_count integer)
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
    select s.id, s.version, s.published_at, s.published_by, s.reason, s.row_count
      from public.capability_matrix_snapshots s
     order by s.version desc;
end
$$;

revoke execute on function app_private.staff_list_capability_matrix_snapshots() from public;
grant execute on function app_private.staff_list_capability_matrix_snapshots() to bsa_app;

-- =====================================================================
-- 8. CTL-10: the public, unauthenticated read. NO app_private.
--    is_platform_admin() gate -- this is deliberately the one capability
--    surface with no caller-identity check at all, matching this task's
--    own framing ("the one capability surface with no token at all").
--    STABLE (reads only). Reads ONLY capability_matrix_snapshots -- never
--    joins or reads capability_registry or any other CTL table, so a
--    half-applied admin edit is never visible here (see header). Returns
--    an EMPTY result set, not an error, when no snapshot has ever been
--    published -- an unauthenticated caller must never learn "nothing
--    has been published yet" versus any other internal state via an
--    error message shape.
-- =====================================================================
create or replace function app_private.get_public_capability_matrix()
returns table (
  capability_id text,
  marketing_label text,
  marketing_blurb text,
  min_tier text,
  is_marketing_section boolean,
  snapshot_version integer,
  published_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  latest_version integer;
  latest_published_at timestamptz;
  latest_rows jsonb;
begin
  select s.version, s.published_at, s.rows
    into latest_version, latest_published_at, latest_rows
    from public.capability_matrix_snapshots s
   order by s.version desc
   limit 1;

  if not found then
    return;
  end if;

  return query
    select
      (elem ->> 'capability_id')::text,
      (elem ->> 'marketing_label')::text,
      (elem ->> 'marketing_blurb')::text,
      (elem ->> 'min_tier')::text,
      (elem ->> 'is_marketing_section')::boolean,
      latest_version,
      latest_published_at
    from jsonb_array_elements(latest_rows) as elem
    order by (elem ->> 'capability_id')::text;
end
$$;

revoke execute on function app_private.get_public_capability_matrix() from public;
grant execute on function app_private.get_public_capability_matrix() to bsa_app;
