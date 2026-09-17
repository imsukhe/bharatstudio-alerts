-- CTL — bringing the capability registry (migration 0149) to §20.2's
-- actual declared field set, and §20.3's actual resolution order.
--
-- AUTHORITY. FULL-PRODUCT-DEFINITION.md §20 ("The control plane — flags,
-- tiers and limits as data"), §20.1-§20.6 in full — the section that
-- specifies this control plane. bharatstudio-requirements/active/tasks/
-- CTL-01-capability-control-plane.md, its "CORRECTION, 2026-09-17"
-- section (three gaps: §20.2's field set, §20.3's resolution order, and
-- §20.6.1's emergency-kill rails — the third is migration 0154's, NOT
-- this file's; see "OUT OF SCOPE" below).
--
-- WHY THIS MIGRATION EXISTS: migration 0149 was built against the WRONG
-- section (its own header cites §12.6, §30.3, §31, §7.5 — never §20,
-- because the task record that dispatched it pointed at §30 instead of
-- §20). Its guards (CTL-14, CTL-15) are sound and are preserved here
-- UNCHANGED — this migration does not touch their constraints, only
-- widens the schema around them, and re-proves both guards hold over the
-- widened schema in packages/db/tests/ctl_registry_spec_alignment.sql.
-- Its field set (capability_key, capacity_class, description,
-- kill_switch, rollout_percentage, min_tier, version, created_at,
-- updated_at, updated_by) is INCOMPLETE against §20.2. This migration
-- completes it.
--
-- MIGRATION NUMBER: 0153, pre-assigned to this lane (CTL-01's own
-- correction record). Fixture range ...6d00-...6dff, pre-assigned to
-- this lane, verified free against packages/db/tests/fixtures/
-- 00_base_world.sql's own running note (its "next free" line already
-- named ...6d00 upward; grepped for any existing ...6d00-...6dff
-- reference across packages/db/tests/*.sql and found none).
--
-- ============================================================
-- GAP 1 — §20.2's declared row shape.
-- ============================================================
-- §20.2 lists the capability row shape verbatim:
--   capability_id, kind, min_tier, limits, global_kill, rollout, beta,
--   marketing_visible, marketing_label, marketing_blurb, effective_from,
--   created_by / reason.
-- Cross-walked against what 0149 already shipped (capability_key ==
-- capability_id under a different name, min_tier, kill_switch ==
-- global_kill, rollout_percentage/denylist == rollout, created_at/
-- updated_at/updated_by == the audit half), the fields 0149 lacks are:
-- kind, limits, beta, marketing_visible, marketing_label,
-- marketing_blurb. Added to public.capability_registry below.
--
-- `effective_from`: NOT added. §20.1's promise ("changing a limit is an
-- audited admin action") and §20.6's staging requirement are ALREADY
-- built — migration 0152's capability_change_requests.effective_at IS
-- the staged-effective-time mechanism (CTL-06), applied read-time the
-- moment a change is both approved and due
-- (app_private.apply_due_capability_change, 0152, untouched by this
-- file). Adding a second effective-time field directly on
-- capability_registry would duplicate a mechanism that already exists,
-- which this task's own instructions say not to do.
--
-- `kind` vs `capacity_class` — NOT the same concept, and this migration
-- keeps BOTH:
--   * capacity_class (0149) is §12.6.1's closed set of eight "active
--     capacity" concepts (plus master_canvas_module, §30.3) — it exists
--     ONLY to make CTL-14 structurally true: the whitelist that makes
--     "gate a durable creator record" unrepresentable. It is not a
--     taxonomy of capability TYPES.
--   * kind (this migration) is §20.2's own taxonomy: widget | module |
--     feature | hub_lane | lobby_mode | ai_feature — what CTL-12 reads
--     ("marketing sections behind flags, kind = marketing_section") and
--     what a future admin UI groups capabilities by.
-- Neither replaces the other. A future reader must not "simplify" them
-- into one column — capacity_class stays CTL-14's structural guard
-- column, completely unrelated to kind's taxonomy purpose, and this
-- migration adds no bridge or derivation between the two.
--
-- BLOCKER, reported rather than invented: §20.2's kind enum
-- (widget | module | feature | hub_lane | lobby_mode | ai_feature) does
-- NOT contain `marketing_section`, and CTL-12
-- (bharatstudio-requirements/active/tasks/CTL-01-capability-control-
-- plane.md's own phase-2 Lane B row) is literally "marketing sections
-- behind flags (kind = marketing_section)". This migration does NOT add
-- a ninth kind value to close that gap — §20.2 is this field's authority
-- and it does not name that value; inventing one here would be exactly
-- the kind of unauthorized value invention this task's own hard
-- constraints forbid. CTL-12 remains blocked on this until whoever owns
-- §20.2/§20.5's relationship (a marketing_section capability might
-- belong on a DIFFERENT enum, or §20.2's list might need a documented,
-- reviewed addition) makes that call explicitly.
--
-- `limits` ships EMPTY. §20.2's example ({"max_instances": 3,
-- "max_duration_ms": 8000}) is illustrative of the shape, not a value to
-- seed — no row this migration touches gets a non-empty `limits` value,
-- because no numeric limit for any real capability has been decided
-- anywhere this migration can cite. The column exists so a FUTURE
-- audited admin action (§20.1) can set one.
--
-- ============================================================
-- GAP 2 — §20.3's resolution order was missing the allowlist stage.
-- ============================================================
-- §20.3, verbatim order:
--   global_kill -> denylist -> allowlist/rollout % -> min_tier vs tier
--   -> per-channel override -> [creator enabled flag -> creator
--   configuration -> runtime activation]
-- 0149 implemented kill -> denylist -> rollout-exclusion -> tier ->
-- override — sound, but missing the allowlist half of step 3. §20.3 is
-- explicit that allowlist/rollout means "on for this channel regardless
-- of tier" — an INCLUSION that overrides the tier gate, not merely
-- rollout's existing EXCLUSION (rollout_percentage already only ever
-- turns a capability off for channels outside its bucket; it never turns
-- one on below tier). This migration adds public.capability_allowlist
-- (mirrors capability_denylist's own shape exactly) as the missing
-- inclusion mechanism, in the position §20.3 states: after denylist,
-- ahead of rollout-exclusion AND tier — an allowlisted channel is
-- entitled regardless of BOTH the rollout bucket and min_tier. It cannot
-- resurrect what kill or denylist already shut off (evaluated strictly
-- after both in the CASE chain below), matching the exact precedent
-- 0149's own override stage already established for "ahead of tier,
-- never ahead of kill/denylist". Override (the LAST, most specific
-- stage, unchanged from 0149) is therefore never consulted for an
-- allowlisted channel, the same way it was never consulted for a
-- kill/denylist/rollout-excluded one before this migration — allowlist
-- joins that same precedence tier, one step earlier than rollout, per
-- §20.3's own ordering. Proven in packages/db/tests/
-- ctl_registry_spec_alignment.sql: a channel below a capability's
-- min_tier (the LOWER-precedence rule, left in place, unchanged) still
-- resolves true once allowlisted (the HIGHER-precedence rule deciding),
-- exactly the "leave a lower-precedence rule in place, prove the higher
-- one still decides" technique 0149's own CTL-02 section uses throughout.
--
-- The LAST THREE §20.3 steps (creator enabled flag, creator
-- configuration, runtime activation) are explicitly NOT part of this
-- resolver. §20.3's own text calls them "the creator's four-switch model
-- from §15" — a DIFFERENT layer, live at the creator/dashboard
-- configuration level (whether a creator has turned a capability on for
-- THEIR channel and configured it, and whether its runtime dependency is
-- live), not a platform-wide registry concern. This resolver
-- (app_private.resolve_channel_capabilities) answers exactly one
-- question — "is this channel ENTITLED to this capability" — and the
-- three creator-level steps compose AFTER that answer, in whatever
-- consumes the resolved blob (a widget's own runtime config read, not
-- this migration's surface). Recorded explicitly, not silently omitted:
-- building them is out of scope for the capability CONTROL PLANE and
-- belongs wherever each capability's own creator-configuration surface
-- already lives (or will live) — this migration invents no such surface.
--
-- ============================================================
-- WHY TWO WRITE FUNCTIONS, NOT ONE WIDENED FUNCTION.
-- ============================================================
-- app_private.staff_upsert_capability_registry_entry (0149) is NOT
-- widened, touched, dropped, or replaced by this migration — it is
-- byte-for-byte the function 0149 shipped, its exact 6-argument
-- signature and exact 8-column output untouched. Two of 0149's own SQL
-- assertions (packages/db/tests/ctl_capability_registry.sql) reference
-- it in ways a widened signature or output would break outright, not
-- merely drift: (1) a has_function_privilege probe cast against the
-- LITERAL text 'app_private.staff_upsert_capability_registry_entry(text,
-- text, text, boolean, integer, text)' — dropping that exact overload
-- makes the regprocedure cast itself raise undefined_function, not fail
-- an assertion; (2) an exact information_schema.parameters string match
-- on its OUT columns ('capability_key,capacity_class,description,
-- kill_switch,rollout_percentage,min_tier,version,updated_at') — adding
-- a column to that projection is a silent widening the whole point of
-- that assertion is to catch. Both are "0149's guards... must still
-- pass" in the most literal sense: not just CTL-14/CTL-15, but this
-- exact function's exact shape. So this migration adds a SECOND,
-- independently-named function, app_private.
-- staff_set_capability_registry_entry, for the full §20.2 field set —
-- same table, same is_platform_admin() gate, same versioning/audit/
-- generation-bump triggers (table-level, fire identically regardless of
-- which function performs the write, exactly as 0149's own CTL-01
-- section proves for a bare SQL UPDATE with no function involved at
-- all). staff_upsert_capability_registry_entry remains fully usable by
-- any existing or future caller that only ever needs the original six
-- fields; it is not deprecated, wrapped, or shadowed.
--
-- ============================================================
-- 0152 (change management) — touched in exactly ONE place, body-only.
-- ============================================================
-- capability_change_requests gets six new NULLABLE columns
-- (proposed_kind/proposed_limits/proposed_beta/
-- proposed_marketing_visible/proposed_marketing_label/
-- proposed_marketing_blurb) so a capability_registry_audit snapshot
-- (to_jsonb(new), which captures every column automatically) taken
-- AFTER this migration carries the full row, and so CTL-08 revert can
-- restore it in full. Nothing else about 0152 changes:
-- staff_propose_capability_change, staff_get_capability_change,
-- staff_list_capability_changes, staff_approve_capability_change,
-- staff_reject_capability_change, staff_kill_capability_now and
-- apply_due_capability_change are BYTE-FOR-BYTE what 0152 shipped — not
-- one line touched. (staff_get_capability_change and
-- staff_list_capability_changes carry their own exact-output-column
-- assertion in packages/db/tests/ctl_change_management.sql, shared
-- across both; widening either's output, or capability_change_row's
-- (which both call via `select *`), breaks that assertion the same way
-- described above for 0149 — so the two-staff-approved CTL-06/07
-- workflow is NOT widened to stage/approve changes to the six new fields
-- in this migration. They are settable only via the immediate,
-- single-admin staff_set_capability_registry_entry above — reported
-- precisely, not half-built: extending propose/approve/apply to cover
-- them as well is real, bounded follow-up work (a parallel
-- staff_propose_capability_registry_change + staff_get/list_..._full
-- read side, mirroring this migration's staff_set/get/list split for
-- capability_registry itself), not done here.)
--
-- The ONE exception: app_private.staff_revert_capability_registry_entry
-- is CREATE OR REPLACEd — its external signature (text, text) ->
-- identical 18-column table is UNCHANGED (no exact-output assertion
-- covers this function, confirmed against ctl_change_management.sql),
-- only its body, to route through staff_set_capability_registry_entry
-- instead of staff_upsert_capability_registry_entry so a revert restores
-- kind/limits/beta/marketing_visible/marketing_label/marketing_blurb
-- from the SAME prior-version audit snapshot it already restores
-- capacity_class/description/kill_switch/rollout_percentage/min_tier
-- from. Left unfixed, revert would silently leave the six new fields at
-- their CURRENT (post-change) values instead of the prior version's —
-- a real correctness gap for CTL-08 over the widened schema, worth this
-- one narrow, signature-preserving fix. staff_kill_capability_now is NOT
-- touched: it already calls staff_upsert_capability_registry_entry with
-- exactly six positional arguments, whose own `on conflict do update set
-- ...` clause never mentions kind/limits/beta/marketing_* at all — an
-- unlisted column in an UPDATE...SET keeps its current value by plain
-- SQL semantics, so kill already preserves the six new fields correctly,
-- with no change needed.
--
-- ============================================================
-- OUT OF SCOPE (deliberately — see the task record and CTL-01's own
-- correction section).
-- ============================================================
--   - CTL-04/05/13 (admin UI, impact preview, admin MFA) and
--     CTL-10/11/12 (public capability matrix, marketing wiring) — other
--     repositories / other lanes. CTL-10/11/12 additionally stay BLOCKED
--     on the marketing_section gap reported above even once built.
--   - §20.6.1's emergency-kill rails (24h auto-revert, 4h ratification
--     escalation, immutable incident log, creator notification, 72h
--     post-incident review) — migration 0154's, per CTL-01's own
--     correction section. This migration does not touch
--     staff_kill_capability_now's single-admin-immediate behaviour at
--     all beyond confirming it still preserves the six new fields.
--   - Migrating the seven hand-rolled entitlement gates onto this
--     registry — untouched, a separate later task, same line 0149 and
--     0152 both already drew.
--   - apps/web/app/overlay/canvas/ — not touched; this plane has no
--     overlay-facing surface, same posture 0149 and 0152 both took.
--
-- ROLLBACK: additive only, no production migration without separate
-- explicit approval.
--   drop function if exists app_private.staff_revert_capability_registry_entry(text, text); -- restored to 0152's original body by re-running 0152 unmodified
--   drop function if exists app_private.staff_set_capability_registry_entry(text, text, text, boolean, integer, text, text, jsonb, boolean, boolean, text, text);
--   drop function if exists app_private.staff_list_capability_registry_entries();
--   drop function if exists app_private.staff_get_capability_registry_entry(text);
--   drop function if exists app_private.resolve_channel_capabilities(uuid); -- restored to 0149's original body by re-running 0149 unmodified
--   drop trigger if exists capability_registry_bump_generation_allowlist on public.capability_allowlist;
--   drop table if exists public.capability_allowlist;
--   alter table public.capability_change_requests
--     drop column if exists proposed_kind,
--     drop column if exists proposed_limits,
--     drop column if exists proposed_beta,
--     drop column if exists proposed_marketing_visible,
--     drop column if exists proposed_marketing_label,
--     drop column if exists proposed_marketing_blurb;
--   alter table public.capability_registry
--     drop column if exists kind,
--     drop column if exists limits,
--     drop column if exists beta,
--     drop column if exists marketing_visible,
--     drop column if exists marketing_label,
--     drop column if exists marketing_blurb;

-- =====================================================================
-- 1. GAP 1: widen capability_registry with §20.2's remaining fields.
-- =====================================================================
alter table public.capability_registry
  add column kind text
    check (kind is null or kind in ('widget', 'module', 'feature', 'hub_lane', 'lobby_mode', 'ai_feature')),
  add column limits jsonb not null default '{}'::jsonb,
  add column beta boolean not null default false,
  add column marketing_visible boolean not null default false,
  add column marketing_label text,
  add column marketing_blurb text,
  add constraint capability_registry_marketing_copy_check
    check (not marketing_visible or (marketing_label is not null and marketing_blurb is not null));

comment on column public.capability_registry.kind is
  '§20.2''s taxonomy (widget | module | feature | hub_lane | lobby_mode | ai_feature) -- NOT the same concept as capacity_class (CTL-14''s closed active-capacity whitelist, §12.6.1). Both columns are kept; neither replaces the other. Nullable: no legacy row written before this migration (0153) has a value here, and this migration does not guess one -- backfilling real classifications for pre-existing capabilities is a product decision, not something to invent in a migration. NOTE: §20.2''s own enum here does not contain "marketing_section", which CTL-12 needs -- see this migration''s header for why that is reported as a blocker, not solved by adding a ninth value.';

comment on column public.capability_registry.limits is
  '§20.2: jsonb, e.g. {"max_instances": 3, "max_duration_ms": 8000}. Ships empty ({}) on every row this migration touches -- §20.1''s "changing a limit is an audited admin action" means a FUTURE staff write sets a real value; no numeric limit is invented here.';

comment on column public.capability_registry.marketing_visible is
  '§20.2/§20.4: filters GET /v1/public/capability-matrix (CTL-10, not built in this migration). Defaults false -- a capability is internal until a staff action explicitly publishes it, the same "never advertise what does not exist" posture §20.4 describes.';

-- =====================================================================
-- 2. GAP 2: the allowlist table -- §20.3 step 3's missing inclusion
--    half. Same shape as capability_denylist (0149) exactly: composite
--    PK, references the registry by capability_key (cascade on delete),
--    references a real channel, revoked from public AND bsa_app (CTL-03
--    posture extended to this new table, same as every other CTL-02
--    support table).
-- =====================================================================
create table public.capability_allowlist (
  capability_key text not null references public.capability_registry(capability_key) on delete cascade,
  channel_id uuid not null references public.channels(id),
  created_at timestamptz not null default current_timestamp,
  primary key (capability_key, channel_id)
);

create index capability_allowlist_channel_idx on public.capability_allowlist (channel_id);

comment on table public.capability_allowlist is
  '§20.3 step 3 (migration 0153): "allowlist / rollout % -> on for this channel regardless of tier." Evaluated in app_private.resolve_channel_capabilities strictly AFTER kill_switch and capability_denylist (cannot resurrect what either already shut off) and strictly BEFORE rollout_percentage and min_tier (bypasses both) -- an allowlisted channel is entitled regardless of its rollout bucket or tier. Like capability_denylist and capability_overrides, never queried per-capability from the app layer -- CTL-03''s resolved blob is still the only reachable read path.';

revoke all on public.capability_allowlist from public;
revoke all on public.capability_allowlist from bsa_app;

create trigger capability_registry_bump_generation_allowlist
  after insert or update or delete on public.capability_allowlist
  for each statement execute function app_private.capability_registry_bump_generation();

-- =====================================================================
-- 3. GAP 2: the resolver, with the allowlist stage inserted at §20.3's
--    position. Signature (target_channel_id uuid) -> table (resolved
--    jsonb, generation bigint, resolved_at timestamptz) is UNCHANGED
--    from 0149 -- this is a body-only CREATE OR REPLACE, verified
--    against ctl_capability_registry.sql's own exact-output-column
--    assertion for this function (which this migration does not touch
--    or need to touch, since the output truly did not change). Every
--    line below is 0149's own body verbatim, with exactly one new `when
--    exists (...) then true` branch inserted between the denylist and
--    rollout-exclusion branches -- diff-minimal by design, so the
--    change this migration makes to CTL-02's chain is visible at a
--    glance against 0149's own source.
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

  -- CTL-03 FAST PATH: cache hit, unchanged from 0149 -- no join across
  -- capability_registry or any CTL-02 support table (including the new
  -- capability_allowlist) happens on this path at all.
  if cache_found and cached_generation = current_generation and cached_tier = current_tier then
    resolved := cached_resolved;
    generation := cached_generation;
    resolved_at := cached_resolved_at;
    return next;
    return;
  end if;

  -- §20.3 resolution order, evaluated per capability inside ONE
  -- aggregate query -- kill -> denylist -> allowlist -> rollout -> tier
  -- -> override, exactly that precedence, exactly this order of CASE
  -- branches. Only the third branch (allowlist) is new; every other
  -- branch and its ordering relative to the others is 0149's own,
  -- unmodified.
  select coalesce(jsonb_object_agg(reg.capability_key, (
    case
      -- 1. kill: absolute, nothing downstream is even evaluated.
      when reg.kill_switch then false
      -- 2. denylist: absolute for this channel, ahead of allowlist,
      --    rollout and any override.
      when exists (
        select 1 from public.capability_denylist d
         where d.capability_key = reg.capability_key and d.channel_id = target_channel_id
      ) then false
      -- 3. NEW: allowlist. "On for this channel regardless of tier"
      --    (§20.3) -- also ahead of the rollout-exclusion stage: an
      --    explicit per-channel grant is not something a percentage
      --    bucket should be able to override. Cannot resurrect what
      --    kill or denylist already decided (both already returned
      --    above); can never be reached by, and never consults, the
      --    override stage below -- allowlist joins the same
      --    "ahead of override" precedence tier kill/denylist/rollout
      --    already occupied in 0149, one step earlier than rollout.
      when exists (
        select 1 from public.capability_allowlist a
         where a.capability_key = reg.capability_key and a.channel_id = target_channel_id
      ) then true
      -- 4. rollout: a channel outside its bucket is excluded, ahead of
      --    any override -- staged rollout cannot be bypassed per-channel
      --    (unchanged from 0149).
      when app_private.capability_rollout_bucket(target_channel_id, reg.capability_key) >= reg.rollout_percentage then false
      -- 5. tier (the default) then 6. override (may replace the
      --    default, and ONLY the default -- unchanged from 0149).
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

-- =====================================================================
-- 4. Staff read: one capability's full §20.2 row. NEW function -- 0149
--    shipped no "read one capability" surface at all (only the
--    audit-by-key list); this is genuinely additive, not a replacement
--    of anything. Staff-only, SECURITY DEFINER, same posture as every
--    other function in this file -- NOT a new per-capability query path
--    for the CONSUMER/runtime side (CTL-03's own concern): this is the
--    staff/admin introspection path, exactly analogous to 0149's own
--    staff_list_capability_registry_audit, which already reads the full
--    registry internals for staff without touching CTL-03's "the
--    resolved blob is the only CONSUMER read path" guarantee. bsa_app
--    still has zero table-level grant on capability_registry itself.
-- =====================================================================
create or replace function app_private.staff_get_capability_registry_entry(target_capability_key text)
returns table (
  capability_key text, capacity_class text, description text, kill_switch boolean,
  rollout_percentage integer, min_tier text, kind text, limits jsonb, beta boolean,
  marketing_visible boolean, marketing_label text, marketing_blurb text,
  version integer, created_at timestamptz, updated_at timestamptz, updated_by uuid
)
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
    select reg.capability_key, reg.capacity_class, reg.description, reg.kill_switch,
           reg.rollout_percentage, reg.min_tier, reg.kind, reg.limits, reg.beta,
           reg.marketing_visible, reg.marketing_label, reg.marketing_blurb,
           reg.version, reg.created_at, reg.updated_at, reg.updated_by
      from public.capability_registry reg
     where reg.capability_key = target_capability_key;
end
$$;

revoke execute on function app_private.staff_get_capability_registry_entry(text) from public;
grant execute on function app_private.staff_get_capability_registry_entry(text) to bsa_app;

-- =====================================================================
-- 5. Staff read: every capability's full §20.2 row. NEW function, same
--    posture as #4 above -- there was no "list every capability" staff
--    surface anywhere before this migration.
-- =====================================================================
create or replace function app_private.staff_list_capability_registry_entries()
returns table (
  capability_key text, capacity_class text, description text, kill_switch boolean,
  rollout_percentage integer, min_tier text, kind text, limits jsonb, beta boolean,
  marketing_visible boolean, marketing_label text, marketing_blurb text,
  version integer, created_at timestamptz, updated_at timestamptz, updated_by uuid
)
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
    select reg.capability_key, reg.capacity_class, reg.description, reg.kill_switch,
           reg.rollout_percentage, reg.min_tier, reg.kind, reg.limits, reg.beta,
           reg.marketing_visible, reg.marketing_label, reg.marketing_blurb,
           reg.version, reg.created_at, reg.updated_at, reg.updated_by
      from public.capability_registry reg
     order by reg.capability_key;
end
$$;

revoke execute on function app_private.staff_list_capability_registry_entries() from public;
grant execute on function app_private.staff_list_capability_registry_entries() to bsa_app;

-- =====================================================================
-- 6. Staff write: the full §20.2 row, all twelve fields required every
--    call -- the SAME "supply the complete desired state, nothing is
--    silently preserved" idiom app_private.
--    staff_upsert_capability_registry_entry (0149) already established
--    for its own six fields (see this migration's header for why this
--    is a SECOND function rather than a widening of that one). Same
--    table, same is_platform_admin() gate, same versioning/audit/
--    generation-bump triggers (table-level -- fire identically
--    regardless of which function performs the write; 0149's own CTL-01
--    test already proves this for a bare SQL UPDATE with no function at
--    all).
-- =====================================================================
create or replace function app_private.staff_set_capability_registry_entry(
  target_capability_key text,
  target_capacity_class text,
  target_description text,
  target_kill_switch boolean,
  target_rollout_percentage integer,
  target_min_tier text,
  target_kind text,
  target_limits jsonb,
  target_beta boolean,
  target_marketing_visible boolean,
  target_marketing_label text,
  target_marketing_blurb text
)
returns table (
  capability_key text, capacity_class text, description text, kill_switch boolean,
  rollout_percentage integer, min_tier text, kind text, limits jsonb, beta boolean,
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
  v_capability_key text;
  v_capacity_class text;
  v_description text;
  v_kill_switch boolean;
  v_rollout_percentage integer;
  v_min_tier text;
  v_kind text;
  v_limits jsonb;
  v_beta boolean;
  v_marketing_visible boolean;
  v_marketing_label text;
  v_marketing_blurb text;
  v_version integer;
  v_updated_at timestamptz;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;

  actor := app_private.current_user_id();

  insert into public.capability_registry
    (capability_key, capacity_class, description, kill_switch, rollout_percentage, min_tier,
     kind, limits, beta, marketing_visible, marketing_label, marketing_blurb, updated_by)
  values
    (target_capability_key, target_capacity_class, target_description,
     coalesce(target_kill_switch, false), coalesce(target_rollout_percentage, 100), target_min_tier,
     target_kind, coalesce(target_limits, '{}'::jsonb), coalesce(target_beta, false),
     coalesce(target_marketing_visible, false), target_marketing_label, target_marketing_blurb, actor)
  on conflict on constraint capability_registry_capability_key_key do update
    set capacity_class = excluded.capacity_class,
        description = excluded.description,
        kill_switch = excluded.kill_switch,
        rollout_percentage = excluded.rollout_percentage,
        min_tier = excluded.min_tier,
        kind = excluded.kind,
        limits = excluded.limits,
        beta = excluded.beta,
        marketing_visible = excluded.marketing_visible,
        marketing_label = excluded.marketing_label,
        marketing_blurb = excluded.marketing_blurb,
        updated_by = excluded.updated_by
  returning capability_registry.capability_key, capability_registry.capacity_class, capability_registry.description,
            capability_registry.kill_switch, capability_registry.rollout_percentage, capability_registry.min_tier,
            capability_registry.kind, capability_registry.limits, capability_registry.beta,
            capability_registry.marketing_visible, capability_registry.marketing_label, capability_registry.marketing_blurb,
            capability_registry.version, capability_registry.updated_at
    into v_capability_key, v_capacity_class, v_description, v_kill_switch, v_rollout_percentage, v_min_tier,
         v_kind, v_limits, v_beta, v_marketing_visible, v_marketing_label, v_marketing_blurb, v_version, v_updated_at;

  capability_key := v_capability_key;
  capacity_class := v_capacity_class;
  description := v_description;
  kill_switch := v_kill_switch;
  rollout_percentage := v_rollout_percentage;
  min_tier := v_min_tier;
  kind := v_kind;
  limits := v_limits;
  beta := v_beta;
  marketing_visible := v_marketing_visible;
  marketing_label := v_marketing_label;
  marketing_blurb := v_marketing_blurb;
  version := v_version;
  updated_at := v_updated_at;
  return next;
end
$$;

revoke execute on function app_private.staff_set_capability_registry_entry(text, text, text, boolean, integer, text, text, jsonb, boolean, boolean, text, text) from public;
grant execute on function app_private.staff_set_capability_registry_entry(text, text, text, boolean, integer, text, text, jsonb, boolean, boolean, text, text) to bsa_app;

-- =====================================================================
-- 7. 0152's change-management table: widen with the six new proposed_*
--    columns, all nullable, no default. NULL here means "this change
--    does not touch this field" ONLY for a row written before this
--    migration (every pre-existing capability_change_requests row, and
--    any future row inserted by 0152's own unmodified
--    staff_propose_capability_change, which never mentions these
--    columns) -- there is no code path in this migration that reads
--    these columns expecting NULL-as-sentinel semantics on a WRITE it
--    performs itself (staff_revert_capability_registry_entry, the one
--    0152 function this migration touches, always writes real
--    extracted-from-audit values, never NULL-as-sentinel). proposed_kind
--    carries the identical enum-or-null check as capability_registry.
--    kind, same CTL-09/CTL-14 "copy the whitelist, don't reference it"
--    precedent 0152 itself already established for proposed_capacity_class.
-- =====================================================================
alter table public.capability_change_requests
  add column proposed_kind text
    check (proposed_kind is null or proposed_kind in ('widget', 'module', 'feature', 'hub_lane', 'lobby_mode', 'ai_feature')),
  add column proposed_limits jsonb,
  add column proposed_beta boolean,
  add column proposed_marketing_visible boolean,
  add column proposed_marketing_label text,
  add column proposed_marketing_blurb text;

comment on column public.capability_change_requests.proposed_kind is
  'Migration 0153. NULL on every row written by 0152''s own staff_propose_capability_change (untouched by this migration) -- these six columns exist so capability_registry_audit''s to_jsonb(new) snapshot (which captures every column automatically) carries the full §20.2 row from this migration forward, which is what lets staff_revert_capability_registry_entry restore kind/limits/beta/marketing_* correctly. NOT threaded through the CTL-06/07 propose/approve/apply workflow in this migration -- see this migration''s header for why, and for the reported follow-up.';

-- =====================================================================
-- 8. The ONE 0152 function this migration touches: CTL-08 revert.
--    External signature (target_capability_key text, target_reason
--    text) -> the SAME 18-column table 0152 shipped is UNCHANGED --
--    body-only CREATE OR REPLACE. Every line is 0152's own body
--    verbatim except the single call at the end, which now routes
--    through staff_set_capability_registry_entry (this migration, #6
--    above) instead of staff_upsert_capability_registry_entry, so a
--    revert restores the full §20.2 row from the SAME prior-version
--    audit snapshot it already restores capacity_class/description/
--    kill_switch/rollout_percentage/min_tier from -- not just those
--    five. prev_row is the same capability_registry_audit.new_row jsonb
--    0152 already reads; it now also carries kind/limits/beta/
--    marketing_visible/marketing_label/marketing_blurb automatically
--    (to_jsonb(new) captures every column of the row that existed at
--    audit time) for any audit row created after this migration widened
--    the table. An audit row from BEFORE this migration simply lacks
--    those jsonb keys -- ->> returns NULL for a missing key, handled by
--    the same coalesce-to-a-sane-default pattern used for limits/beta/
--    marketing_visible below (a fallback for "this audit predates the
--    column", not a preserve-current-value sentinel).
-- =====================================================================
create or replace function app_private.staff_revert_capability_registry_entry(
  target_capability_key text,
  target_reason text
)
returns table (
  id uuid, capability_key text, change_kind text, status text,
  proposed_capacity_class text, proposed_description text, proposed_kill_switch boolean,
  proposed_rollout_percentage integer, proposed_min_tier text,
  effective_at timestamptz, requires_owner_signoff boolean,
  staff_approval_count integer, owner_approval_count integer,
  created_by uuid, created_at timestamptz, applied_at timestamptz, decided_at timestamptz, reason text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  actor uuid;
  cur_version integer;
  prev_audit_id uuid;
  prev_row jsonb;
  new_id uuid;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  actor := app_private.current_user_id();

  select reg.version into cur_version from public.capability_registry reg
   where reg.capability_key = target_capability_key;
  if not found then
    raise exception 'capability % does not exist', target_capability_key using errcode = '22023';
  end if;
  if cur_version <= 1 then
    raise exception 'capability % has no previous version to revert to', target_capability_key using errcode = '22023';
  end if;

  select audit.id, audit.new_row into prev_audit_id, prev_row
    from public.capability_registry_audit audit
   where audit.capability_key = target_capability_key and audit.version = cur_version - 1
   order by audit.changed_at desc, audit.id desc
   limit 1;
  if prev_row is null then
    raise exception 'no audit record found for the previous version of %', target_capability_key using errcode = '22023';
  end if;

  insert into public.capability_change_requests (
    capability_key, change_kind, proposed_capacity_class, proposed_description,
    proposed_kill_switch, proposed_rollout_percentage, proposed_min_tier,
    proposed_kind, proposed_limits, proposed_beta, proposed_marketing_visible,
    proposed_marketing_label, proposed_marketing_blurb,
    effective_at, requires_owner_signoff, status, created_by, applied_at, reverts_audit_id, reason
  ) values (
    target_capability_key, 'revert',
    prev_row ->> 'capacity_class', prev_row ->> 'description',
    (prev_row ->> 'kill_switch')::boolean, (prev_row ->> 'rollout_percentage')::integer, prev_row ->> 'min_tier',
    prev_row ->> 'kind', coalesce(prev_row -> 'limits', '{}'::jsonb),
    coalesce((prev_row ->> 'beta')::boolean, false), coalesce((prev_row ->> 'marketing_visible')::boolean, false),
    prev_row ->> 'marketing_label', prev_row ->> 'marketing_blurb',
    current_timestamp, false, 'applied', actor, current_timestamp, prev_audit_id, target_reason
  ) returning capability_change_requests.id into new_id;

  perform app_private.staff_set_capability_registry_entry(
    target_capability_key, prev_row ->> 'capacity_class', prev_row ->> 'description',
    (prev_row ->> 'kill_switch')::boolean, (prev_row ->> 'rollout_percentage')::integer, prev_row ->> 'min_tier',
    prev_row ->> 'kind', coalesce(prev_row -> 'limits', '{}'::jsonb),
    coalesce((prev_row ->> 'beta')::boolean, false), coalesce((prev_row ->> 'marketing_visible')::boolean, false),
    prev_row ->> 'marketing_label', prev_row ->> 'marketing_blurb'
  );

  return query select * from app_private.capability_change_row(new_id);
end
$$;

revoke execute on function app_private.staff_revert_capability_registry_entry(text, text) from public;
grant execute on function app_private.staff_revert_capability_registry_entry(text, text) to bsa_app;
