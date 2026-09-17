-- CTL -- widening the change-management workflow (migration 0152) to
-- carry all twelve §20.2 registry fields, not just the original six.
--
-- AUTHORITY. FULL-PRODUCT-DEFINITION.md §20.1 ("changing a limit is an
-- audited admin action") and §20.6/§20.6.1 ("two-person approval for
-- every capability change"). bharatstudio-requirements/active/tasks/
-- CTL-06-twelve-field-change-workflow.md.
--
-- MIGRATION NUMBER: 0157, pre-assigned. Fixture range
-- ...7100-...71ff, pre-assigned, own self-contained fixture in
-- packages/db/tests/ctl_change_management_twelve_fields.sql -- this
-- migration does not touch packages/db/tests/fixtures/00_base_world.sql,
-- same posture 0152/0153/0155 all already took. Two other migrations
-- (0156, 0158) run concurrently in separate worktrees, own numbers and
-- own fixture ranges -- this file does not glob the migrations
-- directory and touches no other lane's files.
--
-- ============================================================
-- THE GAP THIS CLOSES.
-- ============================================================
-- Migration 0149 shipped six registry fields (capacity_class,
-- description, kill_switch, rollout_percentage, min_tier -- plus
-- capability_key/version) and ONE governed write path,
-- app_private.staff_upsert_capability_registry_entry. Migration 0152
-- built propose -> two-staff-approve -> apply staging over exactly
-- those six. Migration 0153 added §20.2's remaining six fields (kind,
-- limits, beta, marketing_visible, marketing_label, marketing_blurb) to
-- capability_registry, but explicitly did NOT widen 0152's workflow to
-- carry them -- widening staff_get_capability_change/staff_list_
-- capability_changes' exact-output-column shape was test-breaking, so
-- 0153 shipped a SEPARATE single-admin, immediate write function
-- (staff_set_capability_registry_entry) for the six new fields instead,
-- and reported the propose/approve/apply gap as real, bounded follow-up
-- work rather than solving it. Migration 0155 then correctly closed the
-- single-admin bypass: staff_set_capability_registry_entry now REJECTS
-- any call targeting an EXISTING capability (42501) -- an admin must go
-- through 0152's two-person workflow instead. 0155's own Job 3 header
-- named the resulting gap explicitly: "an admin cannot change kind/
-- limits/beta/marketing_* on an EXISTING capability through ANY path in
-- this schema" until propose/approve/apply is widened. This migration
-- is that widening.
--
-- ============================================================
-- THE PROPOSED-* COLUMNS ALREADY EXIST -- 0153 ADDED THEM, UNUSED.
-- ============================================================
-- capability_change_requests.proposed_kind/proposed_limits/proposed_beta/
-- proposed_marketing_visible/proposed_marketing_label/proposed_marketing_blurb
-- were added by migration 0153 (nullable, no default) precisely so a
-- capability_registry_audit snapshot taken after 0153 would carry the
-- full row and CTL-08 revert could restore it -- 0153's own comment on
-- proposed_kind says outright these columns are "NOT threaded through
-- the CTL-06/07 propose/approve/apply workflow in this migration" and
-- that there is "no code path ... expecting NULL-as-sentinel semantics
-- on a WRITE it performs itself." This migration is that later code
-- path, and NULL-as-sentinel is exactly the semantics it gives those six
-- columns (see MERGE SEMANTICS below) -- 0153 left the room this
-- migration now uses, deliberately, not by accident. No ALTER TABLE is
-- needed to add these columns; they are already there.
--
-- ============================================================
-- MERGE SEMANTICS FOR THE SIX NEW FIELDS -- WHY, AND THE ONE NAMED
-- LIMITATION.
-- ============================================================
-- The ORIGINAL six proposed_* fields (capacity_class, description,
-- kill_switch, rollout_percentage, min_tier) keep their existing
-- FULL-REPLACE semantics, unchanged since 0152: every propose call
-- states the complete desired value for each of them, and apply writes
-- exactly what was proposed. Widening the six NEW fields to that same
-- "always required" idiom would force every existing ordinary six-field
-- change (a tier tweak, a rollout percentage bump) to also restate
-- kind/limits/beta/marketing_* on every call, and -- far more
-- seriously -- would make an ordinary six-field propose call silently
-- WIPE those six fields to NULL/false/{} on apply, via the widened
-- write path, unless the caller happened to already know and re-state
-- the capability's current kind/limits/beta/marketing_* values. That is
-- exactly the "changing a limit is an audited admin action" promise
-- turning into "changing a limit silently deletes an unrelated
-- classification" -- not something to ship.
--
-- Instead: a NULL proposed_kind/proposed_limits/proposed_beta/
-- proposed_marketing_visible/proposed_marketing_label/proposed_marketing_blurb
-- means "this change does not touch this field" -- app_private.
-- apply_due_capability_change (widened below) reads the capability's
-- CURRENT registry row and coalesces each of these six onto whatever
-- was proposed, so an ordinary six-field change (which leaves all six
-- new parameters at their SQL default of NULL) round-trips the
-- capability's existing kind/limits/beta/marketing_* untouched -- the
-- exact behaviour packages/db/tests/ctl_registry_spec_alignment.sql's
-- own "0152's unmodified apply path must PRESERVE kind/beta/
-- marketing_visible" proof already demands, now made a genuine,
-- documented, permanent feature of the widened apply path rather than
-- an accident of the narrower one it replaces. A caller who DOES want
-- to change one of these six fields supplies a real (non-NULL) value
-- for it; an explicit `false` or `'{}'::jsonb` is a real value, not a
-- sentinel, and is written verbatim.
--
-- THE ONE NAMED LIMITATION this creates, reported rather than solved:
-- marketing_label and marketing_blurb are themselves nullable, real-
-- valued columns on capability_registry (NULL there legitimately means
-- "no label set", not merely "unspecified"). Under this migration's
-- sentinel scheme, a governed change CANNOT explicitly clear a
-- previously-set marketing_label/marketing_blurb back to NULL through
-- capability_change_requests -- proposing NULL for either is
-- indistinguishable from "do not touch this field" and preserves
-- whatever is already there. Clearing one to NULL, if ever needed,
-- still requires a fresh capability (no prior value to preserve) or a
-- future migration that adds an explicit "clear this field" flag
-- alongside the value -- not invented here.
--
-- A related, deliberately-unsolved case: capability_registry_marketing_
-- copy_check (0153: marketing_visible=true requires both label and
-- blurb non-null) cannot be evaluated at PROPOSE time when the six new
-- fields use merge semantics, because the eventual merged state depends
-- on the registry row as it exists at APPLY time, which may be staged
-- arbitrarily far in the future (CTL-06) and may change in the
-- meantime. This migration does not attempt propose-time prediction of
-- that merge; capability_registry's own check constraint remains the
-- actual enforcement, firing inside app_private.set_capability_registry_
-- entry_unchecked's INSERT/UPDATE at apply time exactly as it already
-- does for the direct single-admin path -- a change that would produce
-- an invalid merged marketing state fails with check_violation when it
-- is applied (surfaced through whichever read next triggers CTL-06's
-- lazy apply), not at propose or approve time. Reported, not silently
-- special-cased.
--
-- ============================================================
-- THE FROZEN-OUTPUT-SHAPE PROBLEM, SOLVED PROPERLY THIS TIME.
-- ============================================================
-- 0153 avoided widening staff_get_capability_change/staff_list_
-- capability_changes because packages/db/tests/ctl_change_management.sql
-- carries an exact information_schema.parameters assertion on their OUT
-- column list, and PostgreSQL's CREATE OR REPLACE FUNCTION cannot change
-- a function's return type (including a returns table(...) column list)
-- -- doing so requires DROP FUNCTION first (the same technique this
-- repository already used once before, migration 0127's get_overlay_
-- events, per check-plans.mjs's own comment). This migration does
-- exactly that for every function in the capability_change_row family
-- (capability_change_row itself, staff_propose_capability_change,
-- staff_get_capability_change, staff_list_capability_changes,
-- staff_approve_capability_change, staff_reject_capability_change,
-- staff_kill_capability_now, staff_revert_capability_registry_entry) --
-- DROP then CREATE, widening every one to the SAME 24-column shape (the
-- original 18 plus proposed_kind/proposed_limits/proposed_beta/
-- proposed_marketing_visible/proposed_marketing_label/proposed_marketing_blurb,
-- placed immediately after proposed_min_tier), and re-grants execute to
-- bsa_app on each (a DROP FUNCTION discards existing grants -- CREATE OR
-- REPLACE would have preserved them, DROP+CREATE does not). packages/db/
-- tests/ctl_change_management.sql's own exact-output-column assertion
-- (for staff_get_capability_change/staff_list_capability_changes) and
-- its grants-lockdown regprocedure text (for staff_propose_capability_
-- change, whose INPUT signature also widens from 8 to 14 parameters) are
-- updated in place to match -- see this migration's own SHARED FILES
-- note in the task return contract for the exact hunks. No second
-- function is added anywhere in this migration; every existing caller of
-- every one of these eight functions keeps calling the SAME name.
--
-- staff_propose_capability_change's six new trailing parameters
-- (target_kind, target_limits, target_beta, target_marketing_visible,
-- target_marketing_label, target_marketing_blurb) all default to NULL --
-- an existing 8-positional-argument call (every call site in packages/
-- db/tests/ctl_change_management.sql, ctl_registry_spec_alignment.sql
-- and ctl_emergency_kill_and_owner.sql predating this migration) keeps
-- compiling and running unchanged, and correctly proposes "no change" to
-- the six new fields under the merge semantics above -- these call sites
-- did not need to be touched for this migration to be correct, only the
-- one exact-signature assertion naming staff_propose_capability_change's
-- full parameter TYPE list (which always includes defaulted trailing
-- parameters, per PostgreSQL's own regprocedure resolution).
--
-- ============================================================
-- THE ONE WRITE PATH apply_due_capability_change NOW USES, AND WHY IT IS
-- NOT A SECOND PATH THAT SKIPS APPROVAL.
-- ============================================================
-- Before this migration, apply_due_capability_change called 0149's
-- app_private.staff_upsert_capability_registry_entry (six arguments) --
-- a function that structurally cannot mention kind/limits/beta/
-- marketing_*, which is exactly why those six fields survived every
-- change 0152's workflow ever applied, untouched, by accident of that
-- function's own narrower SET clause. Carrying all twelve fields through
-- apply requires a write path that CAN set all twelve -- that is 0155
-- Job 3's app_private.set_capability_registry_entry_unchecked, the
-- internal helper revoked from public and NOT granted to bsa_app at all,
-- reachable only from another SECURITY DEFINER function this migration's
-- own role owns. It is NOT app_private.staff_set_capability_registry_
-- entry (0155 Job 3b), which since 0155 REJECTS any call targeting an
-- EXISTING capability precisely so a single admin cannot bypass §20.6's
-- two-person approval -- calling THAT function from apply would either
-- break every existing-capability change outright (42501) or, if it were
-- weakened to allow it, reopen the exact bypass 0155 closed.
--
-- Calling the unguarded helper from apply_due_capability_change is not a
-- new bypass, for the same reason 0155's own revert (Job 3c) and
-- Job 2's kill auto-revert-at-expiry already call it directly: by the
-- time apply_due_capability_change ever reaches this line, the request's
-- status is ALREADY 'approved' -- which for change_kind='update' means
-- app_private.staff_approve_capability_change has already recorded two
-- DISTINCT staff approvals (and, when requires_owner_signoff, a REAL
-- owner-identity approval; CTL-07 rules 1 and 2, both migration 0152/
-- 0155, untouched by this file) BEFORE this function is ever called.
-- Widening WHAT apply writes (from six fields to twelve) does not widen
-- WHO may cause it to write, or how many approvals that requires -- the
-- exact same two-staff-approved (or two-staff-plus-owner) status
-- transition gates this write exactly as it always has. No route in
-- apps/api/src/routes/capability-change-management.ts or capability-
-- registry-admin.ts is added or changed to reach set_capability_registry_
-- entry_unchecked directly; the single-admin route (PUT .../entries/
-- :capabilityKey) still goes through staff_set_capability_registry_entry,
-- still rejected for an existing capability, unchanged.
--
-- ============================================================
-- WHAT IS NOT TOUCHED.
-- ============================================================
--   - CTL-07's three authority rules (two-staff, owner sign-off for
--     paid->Free, single-admin global_kill) -- staff_approve_capability_
--     change's body is byte-for-byte 0155's own (only its declared
--     returns table widens); staff_kill_capability_now still calls
--     0149's staff_upsert_capability_registry_entry with exactly six
--     positional arguments, unchanged, so a kill event's own
--     capability_change_requests row leaves proposed_kind/limits/beta/
--     marketing_* NULL (this migration does not manufacture values for
--     fields a kill never touches) while the registry write itself
--     still preserves them exactly as 0153's own header already proved.
--   - CTL-09's guard: proposed_capacity_class's closed whitelist (0152)
--     is not touched by this migration -- still copied token-for-token
--     from capability_registry.capacity_class, still scanned structurally
--     in both places by packages/db/tests/ctl_change_management_twelve_
--     fields.sql (this migration's own test), re-proving the same
--     "durable-creator-record subject unrepresentable" property CTL-09
--     always asserted, now re-checked over the widened row shape too.
--   - CTL-14/CTL-15/CTL-03: no new column, table, or grant this
--     migration adds names retention/TTL/expiry, and bsa_app is granted
--     no new direct table-level access -- every new/widened surface is a
--     function grant only, exactly the existing posture.
--   - app_private.staff_list_capability_change_approvals: not touched at
--     all, same 4-column shape, same body.
--   - apps/web/app/overlay/canvas/: not touched; this plane has no
--     overlay-facing surface, same posture every prior CTL migration
--     took.
--   - Who counts as a platform admin, or CTL-10/11/12/CTL-04/05/13 (out
--     of scope, other lanes/repositories, same boundary 0149/0152/0153/
--     0155 all already drew).
--
-- ROLLBACK: additive only, no production migration without separate
-- explicit approval.
--   drop function if exists app_private.capability_change_row(uuid);
--   drop function if exists app_private.staff_propose_capability_change(text, text, text, boolean, integer, text, timestamptz, text, text, jsonb, boolean, boolean, text, text);
--   drop function if exists app_private.staff_get_capability_change(uuid);
--   drop function if exists app_private.staff_list_capability_changes(text, integer);
--   drop function if exists app_private.staff_approve_capability_change(uuid, text);
--   drop function if exists app_private.staff_reject_capability_change(uuid, text);
--   drop function if exists app_private.staff_kill_capability_now(text, text);
--   drop function if exists app_private.staff_revert_capability_registry_entry(text, text);
--   -- then re-run migrations 0149 through 0155 in order (unmodified) to
--   -- restore every one of the above to its pre-0157 shape, and revert
--   -- packages/db/tests/ctl_change_management.sql's grants-lockdown
--   -- signature text and exact-output-column assertion to their
--   -- pre-0157 wording (both noted in this task's own return contract).
--   -- apply_due_capability_change is body-only CREATE OR REPLACE
--   -- (its void return type never changed) -- restored to 0152's
--   -- original body by re-running 0152 unmodified after the drops above.

-- =====================================================================
-- 1. capability_change_row: internal row-shaping helper every other
--    function below returns through. Widened to 24 columns.
-- =====================================================================
drop function if exists app_private.capability_change_row(uuid);

create function app_private.capability_change_row(target_change_request_id uuid)
returns table (
  id uuid, capability_key text, change_kind text, status text,
  proposed_capacity_class text, proposed_description text, proposed_kill_switch boolean,
  proposed_rollout_percentage integer, proposed_min_tier text,
  proposed_kind text, proposed_limits jsonb, proposed_beta boolean,
  proposed_marketing_visible boolean, proposed_marketing_label text, proposed_marketing_blurb text,
  effective_at timestamptz, requires_owner_signoff boolean,
  staff_approval_count integer, owner_approval_count integer,
  created_by uuid, created_at timestamptz, applied_at timestamptz, decided_at timestamptz, reason text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  perform app_private.apply_due_capability_change(target_change_request_id);

  return query
    select
      r.id, r.capability_key, r.change_kind, r.status,
      r.proposed_capacity_class, r.proposed_description, r.proposed_kill_switch,
      r.proposed_rollout_percentage, r.proposed_min_tier,
      r.proposed_kind, r.proposed_limits, r.proposed_beta,
      r.proposed_marketing_visible, r.proposed_marketing_label, r.proposed_marketing_blurb,
      r.effective_at, r.requires_owner_signoff,
      coalesce((select count(*)::integer from public.capability_change_approvals a
                 where a.change_request_id = r.id and a.approval_kind = 'staff'), 0),
      coalesce((select count(*)::integer from public.capability_change_approvals a
                 where a.change_request_id = r.id and a.approval_kind = 'owner'), 0),
      r.created_by, r.created_at, r.applied_at, r.decided_at, r.reason
    from public.capability_change_requests r
    where r.id = target_change_request_id;
end
$$;

revoke execute on function app_private.capability_change_row(uuid) from public;
grant execute on function app_private.capability_change_row(uuid) to bsa_app;

-- =====================================================================
-- 2. CTL-06: apply a due change. Widened to write all twelve fields via
--    the unguarded internal helper (0155 Job 3a), with merge semantics
--    for the six new fields -- see this migration's header. Return type
--    (void) is unchanged, so this is a body-only CREATE OR REPLACE.
-- =====================================================================
create or replace function app_private.apply_due_capability_change(target_change_request_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  req record;
  cur record;
  v_kind text;
  v_limits jsonb;
  v_beta boolean;
  v_marketing_visible boolean;
  v_marketing_label text;
  v_marketing_blurb text;
begin
  select * into req from public.capability_change_requests where id = target_change_request_id for update;
  if not found then
    return;
  end if;
  if req.status <> 'approved' then
    return;
  end if;
  if req.effective_at > current_timestamp then
    return;
  end if;

  -- MERGE, not replace, for the six §20.2 fields 0153 added: a NULL
  -- proposed_* value means "this change does not touch this field" --
  -- see this migration's header for why, and for the one named
  -- limitation (clearing marketing_label/marketing_blurb to NULL is not
  -- expressible this way). cur.* is NULL in every field when the
  -- capability does not exist yet (a brand-new capability proposed
  -- through this same workflow) -- coalesce then simply passes through
  -- whatever was proposed (possibly NULL too), and app_private.
  -- set_capability_registry_entry_unchecked's own INSERT-path defaulting
  -- (coalesce(target_limits, '{}'::jsonb), coalesce(target_beta, false),
  -- coalesce(target_marketing_visible, false)) takes it from there,
  -- exactly as it already does for a brand-new capability created via
  -- the direct single-admin path.
  select reg.kind, reg.limits, reg.beta, reg.marketing_visible, reg.marketing_label, reg.marketing_blurb
    into cur
    from public.capability_registry reg
   where reg.capability_key = req.capability_key;

  v_kind := coalesce(req.proposed_kind, cur.kind);
  v_limits := coalesce(req.proposed_limits, cur.limits);
  v_beta := coalesce(req.proposed_beta, cur.beta);
  v_marketing_visible := coalesce(req.proposed_marketing_visible, cur.marketing_visible);
  v_marketing_label := coalesce(req.proposed_marketing_label, cur.marketing_label);
  v_marketing_blurb := coalesce(req.proposed_marketing_blurb, cur.marketing_blurb);

  -- The ONE write path for a governed change: the internal unguarded
  -- helper (0155 Job 3a), never app_private.staff_set_capability_
  -- registry_entry (0155 Job 3b, which rejects an existing capability) --
  -- see this migration's header for why this is not a second path that
  -- skips approval: this function only ever reaches this line for a
  -- request whose status is already 'approved', which CTL-07's own
  -- two-staff-or-owner gate in staff_approve_capability_change (0152/
  -- 0155, untouched) already enforced before this line can run.
  perform app_private.set_capability_registry_entry_unchecked(
    req.capability_key, req.proposed_capacity_class, req.proposed_description,
    req.proposed_kill_switch, req.proposed_rollout_percentage, req.proposed_min_tier,
    v_kind, v_limits, v_beta, v_marketing_visible, v_marketing_label, v_marketing_blurb
  );

  update public.capability_change_requests
     set status = 'applied', applied_at = current_timestamp
   where id = target_change_request_id;
end
$$;

-- Grants unchanged, inherited from 0152 (CREATE OR REPLACE preserves an
-- unchanged function's ACL): revoked from public, granted to bsa_app.

-- =====================================================================
-- 3. CTL-06: propose. Input signature widened (8 -> 14 parameters, the
--    six new ones trailing with a NULL default -- see this migration's
--    header for why every pre-existing call site keeps working
--    unchanged) and output widened to 24 columns. DROP + CREATE (input
--    AND output both change).
-- =====================================================================
drop function if exists app_private.staff_propose_capability_change(text, text, text, boolean, integer, text, timestamptz, text);

create function app_private.staff_propose_capability_change(
  target_capability_key text,
  target_capacity_class text,
  target_description text,
  target_kill_switch boolean,
  target_rollout_percentage integer,
  target_min_tier text,
  target_effective_at timestamptz,
  target_reason text,
  target_kind text default null,
  target_limits jsonb default null,
  target_beta boolean default null,
  target_marketing_visible boolean default null,
  target_marketing_label text default null,
  target_marketing_blurb text default null
)
returns table (
  id uuid, capability_key text, change_kind text, status text,
  proposed_capacity_class text, proposed_description text, proposed_kill_switch boolean,
  proposed_rollout_percentage integer, proposed_min_tier text,
  proposed_kind text, proposed_limits jsonb, proposed_beta boolean,
  proposed_marketing_visible boolean, proposed_marketing_label text, proposed_marketing_blurb text,
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
  cur_exists boolean := false;
  cur_min_tier text;
  owner_needed boolean;
  new_id uuid;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  actor := app_private.current_user_id();

  select true, reg.min_tier into cur_exists, cur_min_tier
    from public.capability_registry reg where reg.capability_key = target_capability_key;
  cur_exists := coalesce(cur_exists, false);

  -- CTL-07 rule 2: UNCHANGED from 0152 -- based solely on min_tier, the
  -- six new fields never factor into whether owner sign-off is required.
  owner_needed := cur_exists
    and cur_min_tier is not null and cur_min_tier <> 'free'
    and (target_min_tier is null or target_min_tier = 'free');

  insert into public.capability_change_requests (
    capability_key, change_kind, proposed_capacity_class, proposed_description,
    proposed_kill_switch, proposed_rollout_percentage, proposed_min_tier,
    proposed_kind, proposed_limits, proposed_beta, proposed_marketing_visible,
    proposed_marketing_label, proposed_marketing_blurb,
    effective_at, requires_owner_signoff, status, created_by, reason
  ) values (
    target_capability_key, 'update', target_capacity_class, target_description,
    coalesce(target_kill_switch, false), coalesce(target_rollout_percentage, 100), target_min_tier,
    target_kind, target_limits, target_beta, target_marketing_visible,
    target_marketing_label, target_marketing_blurb,
    coalesce(target_effective_at, current_timestamp), owner_needed, 'pending_approval', actor, target_reason
  ) returning capability_change_requests.id into new_id;

  return query select * from app_private.capability_change_row(new_id);
end
$$;

revoke execute on function app_private.staff_propose_capability_change(text, text, text, boolean, integer, text, timestamptz, text, text, jsonb, boolean, boolean, text, text) from public;
grant execute on function app_private.staff_propose_capability_change(text, text, text, boolean, integer, text, timestamptz, text, text, jsonb, boolean, boolean, text, text) to bsa_app;

-- =====================================================================
-- 4. Reads: get one, list. Output widened to 24 columns; input
--    signatures unchanged. DROP + CREATE (output-only change).
-- =====================================================================
drop function if exists app_private.staff_get_capability_change(uuid);

create function app_private.staff_get_capability_change(target_change_request_id uuid)
returns table (
  id uuid, capability_key text, change_kind text, status text,
  proposed_capacity_class text, proposed_description text, proposed_kill_switch boolean,
  proposed_rollout_percentage integer, proposed_min_tier text,
  proposed_kind text, proposed_limits jsonb, proposed_beta boolean,
  proposed_marketing_visible boolean, proposed_marketing_label text, proposed_marketing_blurb text,
  effective_at timestamptz, requires_owner_signoff boolean,
  staff_approval_count integer, owner_approval_count integer,
  created_by uuid, created_at timestamptz, applied_at timestamptz, decided_at timestamptz, reason text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  return query select * from app_private.capability_change_row(target_change_request_id);
end
$$;

revoke execute on function app_private.staff_get_capability_change(uuid) from public;
grant execute on function app_private.staff_get_capability_change(uuid) to bsa_app;

drop function if exists app_private.staff_list_capability_changes(text, integer);

create function app_private.staff_list_capability_changes(target_status text, target_limit integer)
returns table (
  id uuid, capability_key text, change_kind text, status text,
  proposed_capacity_class text, proposed_description text, proposed_kill_switch boolean,
  proposed_rollout_percentage integer, proposed_min_tier text,
  proposed_kind text, proposed_limits jsonb, proposed_beta boolean,
  proposed_marketing_visible boolean, proposed_marketing_label text, proposed_marketing_blurb text,
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
  due record;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;

  for due in
    select cr.id from public.capability_change_requests cr
     where cr.status = 'approved' and cr.effective_at <= current_timestamp
  loop
    perform app_private.apply_due_capability_change(due.id);
  end loop;

  return query
    select
      cr.id, cr.capability_key, cr.change_kind, cr.status,
      cr.proposed_capacity_class, cr.proposed_description, cr.proposed_kill_switch,
      cr.proposed_rollout_percentage, cr.proposed_min_tier,
      cr.proposed_kind, cr.proposed_limits, cr.proposed_beta,
      cr.proposed_marketing_visible, cr.proposed_marketing_label, cr.proposed_marketing_blurb,
      cr.effective_at, cr.requires_owner_signoff,
      coalesce((select count(*)::integer from public.capability_change_approvals a
                 where a.change_request_id = cr.id and a.approval_kind = 'staff'), 0),
      coalesce((select count(*)::integer from public.capability_change_approvals a
                 where a.change_request_id = cr.id and a.approval_kind = 'owner'), 0),
      cr.created_by, cr.created_at, cr.applied_at, cr.decided_at, cr.reason
    from public.capability_change_requests cr
    where target_status is null or cr.status = target_status
    order by cr.created_at desc, cr.id desc
    limit target_limit;
end
$$;

revoke execute on function app_private.staff_list_capability_changes(text, integer) from public;
grant execute on function app_private.staff_list_capability_changes(text, integer) to bsa_app;

-- =====================================================================
-- 5. CTL-07 rules 1+2: approve. Body byte-for-byte 0155's own (Job 1c) --
--    only the declared returns table widens. DROP + CREATE.
-- =====================================================================
drop function if exists app_private.staff_approve_capability_change(uuid, text);

create function app_private.staff_approve_capability_change(
  target_change_request_id uuid,
  target_approval_kind text
)
returns table (
  id uuid, capability_key text, change_kind text, status text,
  proposed_capacity_class text, proposed_description text, proposed_kill_switch boolean,
  proposed_rollout_percentage integer, proposed_min_tier text,
  proposed_kind text, proposed_limits jsonb, proposed_beta boolean,
  proposed_marketing_visible boolean, proposed_marketing_label text, proposed_marketing_blurb text,
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
  req record;
  staff_count integer;
  owner_count integer;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  if target_approval_kind not in ('staff', 'owner') then
    raise exception 'unrecognised approval kind %', target_approval_kind using errcode = '22023';
  end if;
  actor := app_private.current_user_id();

  select * into req from public.capability_change_requests cr where cr.id = target_change_request_id for update;
  if not found then
    raise exception 'change request not found' using errcode = '22023';
  end if;
  if req.change_kind <> 'update' or req.status <> 'pending_approval' then
    raise exception 'change request is not open for approval' using errcode = '22023';
  end if;
  if req.created_by = actor then
    raise exception 'the proposer of a change may not also approve it' using errcode = '22023';
  end if;
  if target_approval_kind = 'owner' then
    if not req.requires_owner_signoff then
      raise exception 'this change does not require owner sign-off' using errcode = '22023';
    end if;
    -- Migration 0155, Job 1 / owner decision 2026-09-17: unchanged --
    -- an 'owner' approval demands REAL owner identity, not merely
    -- platform-admin membership.
    if not app_private.is_platform_owner() then
      raise exception 'an owner approval requires real platform owner identity' using errcode = '42501';
    end if;
  end if;

  insert into public.capability_change_approvals (change_request_id, approval_kind, approver_id)
  values (target_change_request_id, target_approval_kind, actor);

  select count(*) filter (where a.approval_kind = 'staff'), count(*) filter (where a.approval_kind = 'owner')
    into staff_count, owner_count
    from public.capability_change_approvals a
   where a.change_request_id = target_change_request_id;

  if staff_count >= 2 and (not req.requires_owner_signoff or owner_count >= 1) then
    update public.capability_change_requests cr set status = 'approved' where cr.id = target_change_request_id;
  end if;

  return query select * from app_private.capability_change_row(target_change_request_id);
end
$$;

revoke execute on function app_private.staff_approve_capability_change(uuid, text) from public;
grant execute on function app_private.staff_approve_capability_change(uuid, text) to bsa_app;

-- =====================================================================
-- 6. Reject. Body byte-for-byte 0152's own -- only the declared returns
--    table widens. DROP + CREATE.
-- =====================================================================
drop function if exists app_private.staff_reject_capability_change(uuid, text);

create function app_private.staff_reject_capability_change(
  target_change_request_id uuid,
  target_reason text
)
returns table (
  id uuid, capability_key text, change_kind text, status text,
  proposed_capacity_class text, proposed_description text, proposed_kill_switch boolean,
  proposed_rollout_percentage integer, proposed_min_tier text,
  proposed_kind text, proposed_limits jsonb, proposed_beta boolean,
  proposed_marketing_visible boolean, proposed_marketing_label text, proposed_marketing_blurb text,
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
  req record;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  if target_reason is null or length(trim(target_reason)) = 0 then
    raise exception 'a reason is required to reject a capability change' using errcode = '22023';
  end if;

  select * into req from public.capability_change_requests cr where cr.id = target_change_request_id for update;
  if not found then
    raise exception 'change request not found' using errcode = '22023';
  end if;
  if req.status <> 'pending_approval' then
    raise exception 'change request is not open for rejection' using errcode = '22023';
  end if;

  update public.capability_change_requests
     set status = 'rejected', decided_at = current_timestamp, reason = target_reason
   where capability_change_requests.id = target_change_request_id;

  return query select * from app_private.capability_change_row(target_change_request_id);
end
$$;

revoke execute on function app_private.staff_reject_capability_change(uuid, text) from public;
grant execute on function app_private.staff_reject_capability_change(uuid, text) to bsa_app;

-- =====================================================================
-- 7. CTL-07 rule 3: single-admin global_kill. Body byte-for-byte 0152's
--    own -- still calls 0149's six-argument staff_upsert_capability_
--    registry_entry, unchanged, so a kill still preserves kind/limits/
--    beta/marketing_* exactly as 0153's own header already proved (that
--    function's SET clause never mentions those columns). This
--    migration does not manufacture proposed_kind/limits/beta/
--    marketing_* values for a kill event's own audit row -- they stay
--    NULL, honestly reflecting that a kill never touches them. Only the
--    declared returns table widens. DROP + CREATE.
-- =====================================================================
drop function if exists app_private.staff_kill_capability_now(text, text);

create function app_private.staff_kill_capability_now(
  target_capability_key text,
  target_reason text
)
returns table (
  id uuid, capability_key text, change_kind text, status text,
  proposed_capacity_class text, proposed_description text, proposed_kill_switch boolean,
  proposed_rollout_percentage integer, proposed_min_tier text,
  proposed_kind text, proposed_limits jsonb, proposed_beta boolean,
  proposed_marketing_visible boolean, proposed_marketing_label text, proposed_marketing_blurb text,
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
  cur record;
  new_id uuid;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  actor := app_private.current_user_id();

  select reg.capacity_class, reg.description, reg.rollout_percentage, reg.min_tier
    into cur
    from public.capability_registry reg where reg.capability_key = target_capability_key;
  if not found then
    raise exception 'capability % does not exist', target_capability_key using errcode = '22023';
  end if;

  insert into public.capability_change_requests (
    capability_key, change_kind, proposed_capacity_class, proposed_description,
    proposed_kill_switch, proposed_rollout_percentage, proposed_min_tier,
    effective_at, requires_owner_signoff, status, created_by, applied_at, reason
  ) values (
    target_capability_key, 'kill', cur.capacity_class, cur.description,
    true, cur.rollout_percentage, cur.min_tier,
    current_timestamp, false, 'applied', actor, current_timestamp, target_reason
  ) returning capability_change_requests.id into new_id;

  perform app_private.staff_upsert_capability_registry_entry(
    target_capability_key, cur.capacity_class, cur.description, true, cur.rollout_percentage, cur.min_tier
  );

  return query select * from app_private.capability_change_row(new_id);
end
$$;

revoke execute on function app_private.staff_kill_capability_now(text, text) from public;
grant execute on function app_private.staff_kill_capability_now(text, text) to bsa_app;

-- =====================================================================
-- 8. CTL-08: one-action revert. Body byte-for-byte 0155's own (Job 3c) --
--    already restores all twelve fields from the prior audit snapshot,
--    already calls the unguarded helper directly. Only the declared
--    returns table widens. DROP + CREATE.
-- =====================================================================
drop function if exists app_private.staff_revert_capability_registry_entry(text, text);

create function app_private.staff_revert_capability_registry_entry(
  target_capability_key text,
  target_reason text
)
returns table (
  id uuid, capability_key text, change_kind text, status text,
  proposed_capacity_class text, proposed_description text, proposed_kill_switch boolean,
  proposed_rollout_percentage integer, proposed_min_tier text,
  proposed_kind text, proposed_limits jsonb, proposed_beta boolean,
  proposed_marketing_visible boolean, proposed_marketing_label text, proposed_marketing_blurb text,
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

  perform app_private.set_capability_registry_entry_unchecked(
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
