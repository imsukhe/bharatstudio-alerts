-- CTL phase 2, Lane A — change management on top of the phase-1
-- capability control plane (migration 0149).
--
-- AUTHORITY. bharatstudio-requirements/active/tasks/CTL-06-change-management.md.
-- FULL-PRODUCT-DEFINITION.md §31.19 rows CTL-06, CTL-07, CTL-08, CTL-09.
-- CTL-01/02/03/14/15 (migration 0149) are read-only authority here --
-- this migration extends nothing in that file; it adds a NEW governance
-- layer in front of the ONE write path 0149 already ships
-- (app_private.staff_upsert_capability_registry_entry), and every actual
-- mutation of public.capability_registry below funnels back through that
-- exact function, never a parallel write path.
--
-- MIGRATION NUMBER: 0152, pre-assigned to this lane. Two other CTL
-- phase-2 lanes run concurrently in separate worktrees (Lane B: public
-- capability matrix; Lane C: admin UI, another repository) -- 0152 and
-- the packages/db/tests/fixtures/00_base_world.sql id block
-- ...6c00-...6cff are this lane's alone. This file does NOT touch
-- 00_base_world.sql: every fixture this task needs is self-contained in
-- packages/db/tests/ctl_change_management.sql, the same posture
-- packages/db/tests/ctl_capability_registry.sql already took for its own
-- ...5f00-...5f02 block -- per-file database isolation
-- (run-sql-suite.sh) makes a shared-fixtures touch unnecessary here.
--
-- ============================================================
-- SCOPE: FOUR ROWS, ONE GOVERNANCE LAYER OVER capability_registry.
-- ============================================================
-- CTL-06 (staged effective-time changes) -- CTL-07 (two-staff approval;
-- owner sign-off for paid->Free; single-admin global_kill) -- CTL-08
-- (one-action revert) -- CTL-09 (correctness dimensions structurally
-- unrepresentable in this panel) are one mechanism: a
-- capability_change_requests row is authored (CTL-06's staging), gated
-- into effect by capability_change_approvals (CTL-07), always resolved
-- via the exact same versioned/audited write 0149 built
-- (capability_registry's own triggers, never duplicated here), and its
-- capacity_class column carries the identical closed whitelist 0149's
-- own capability_registry.capacity_class carries (CTL-09, the CTL-14
-- precedent extended verbatim to this new surface).
--
-- WHAT THIS DOES NOT DO (deliberately -- see the task record):
--   - Does NOT migrate the seven existing hand-rolled gates onto the
--     registry (untouched, out of scope, a separate later task -- same
--     line 0149 already drew).
--   - Does NOT build an admin UI, an impact preview, or admin MFA
--     (CTL-04/05/13 -- a different repository, Lane C).
--   - Does NOT build the public capability matrix or marketing wiring
--     (CTL-10/11/12 -- Lane B, concurrent, same repository different
--     files).
--   - Does NOT touch apps/web/app/overlay/canvas/ -- this plane has no
--     overlay-facing surface, same as 0149.
--   - Does NOT modify migration 0149, 0150, or any SAF-*/GOA-* record.
--     Every reference to CTL-01/02/03/14/15 below is a READ of that
--     migration's existing shapes (its table, its one write function),
--     never an edit to it.
--
-- ============================================================
-- CTL-09 -- STRUCTURAL, NOT REVIEW-BASED: THIS PANEL CANNOT PROPOSE A
-- CORRECTNESS DIMENSION.
-- ============================================================
-- Exactly 0149's CTL-14 mechanism, extended to the one new surface that
-- can originate a capacity_class value: capability_change_requests.
-- proposed_capacity_class carries the IDENTICAL closed whitelist check
-- constraint as public.capability_registry.capacity_class (CTL-14) --
-- copied token-for-token, not referenced (Postgres has no cross-table
-- check-constraint reuse), so a widened whitelist on ONE table without
-- the other is exactly the drift the structural test below is built to
-- catch. No "correctness dimension" field exists anywhere on this
-- table -- the durable-record classes forbidden by §12.6.1 remain
-- absent from BOTH whitelists, unrepresentable in the panel, not merely
-- rejected by a runtime check a reviewer could accidentally loosen
-- without noticing the sibling constraint.
--
-- Proven, same technique as 0149's CTL-14: BEHAVIOURALLY (proposing any
-- of the nine forbidden classes raises check_violation) and
-- STRUCTURALLY (capability_change_requests_proposed_capacity_class_check's
-- own pg_get_constraintdef is scanned for the nine forbidden tokens and
-- must contain none -- the guard that fails when removed, because
-- dropping the constraint makes the previously-rejected propose call
-- succeed).
--
-- ============================================================
-- CTL-06 -- READ-TIME CORRECTNESS, NO SWEEPER REQUIRED FOR THIS PLANE'S
-- OWN SURFACE.
-- ============================================================
-- app_private.apply_due_capability_change is called at the START of
-- every read/write entry point below (capability_change_row -- the
-- shared row-shaping helper every propose/get/approve/reject/kill/revert
-- function returns through -- and staff_list_capability_changes' own
-- lazy-apply pass ahead of its listing query). A change that reached
-- status='approved' with effective_at already in the past is applied to
-- public.capability_registry (via 0149's own
-- staff_upsert_capability_registry_entry, so it is versioned and audited
-- exactly like every other registry write) THE MOMENT anyone reads or
-- lists it through this plane -- no scheduled sweep, no explicit "apply
-- now" call, is required for that read itself to be correct. Proven in
-- the SQL test: a change is authored, approved past a
-- deliberately-in-the-past effective_at, and the VERY NEXT call is a
-- plain get/list (never an apply/sweep call) -- the test asserts
-- status='applied' and public.capability_registry already reflects the
-- new values.
--
-- What this does NOT give you: a due change that nobody ever reads
-- through THIS plane again stays 'approved'-but-unapplied indefinitely
-- (public.capability_registry itself is untouched until something calls
-- in here), and 0149's own app_private.resolve_channel_capabilities /
-- get_channel_capabilities -- both frozen, unmodified in this migration
-- -- read public.capability_registry directly and so would keep serving
-- the pre-change value until that happens. A periodic sweep (the same
-- shape as RT-04/RT-05's leased outbox dispatcher, e.g. a cron calling
-- app_private.apply_due_capability_change over every due row on a
-- schedule) would close that latency gap for a change nobody happens to
-- browse -- not built here, flagged as a genuine follow-up, per this
-- task's own instruction that read-time correctness comes first and a
-- sweeper need is to be reported, not silently assumed unnecessary.
--
-- ============================================================
-- CTL-07 -- THREE SEPARATE AUTHORITY RULES, NOT ONE COLLAPSED RULE.
-- ============================================================
-- 1. TWO-STAFF, every ordinary change (change_kind='update'):
--    app_private.staff_approve_capability_change requires TWO DISTINCT
--    is_platform_admin() approvers of approval_kind='staff' (enforced by
--    UNIQUE(change_request_id, approver_id) plus an explicit count
--    check) before status can become 'approved' -- and explicitly
--    excludes the proposer from counting as one of the two (maker-
--    checker: req.created_by = actor is rejected). This is a real
--    two-PERSON control, not "the same admin clicks twice".
-- 2. OWNER SIGN-OFF, paid->Free moves only: requires_owner_signoff is
--    computed and frozen at propose time (an EXISTING capability whose
--    current min_tier is pro/creator/studio, proposed to null/free --
--    never true for a brand-new capability's own initial tier). When
--    true, 'approved' additionally requires >=1 approval_kind='owner'
--    row; approving with 'owner' when it is not required is rejected
--    (so an owner-labelled approval is never a meaningless no-op ON A
--    change that did not need it).
--
--    BLOCKER, reported per this task's own instruction rather than
--    solved by minting a role: app_users carries exactly ONE staff
--    concept, is_platform_admin (boolean, migration 0073) -- there is no
--    is_platform_owner or any rank distinguishing "the owner" from
--    ordinary platform staff anywhere in this schema, and
--    app_private.has_channel_role's owner/admin/... roles are PER
--    CHANNEL, meaningless for a platform-wide capability_registry row.
--    approval_kind='owner' is therefore gated by the SAME
--    is_platform_admin() check as 'staff' below -- ANY platform admin
--    can currently record an owner sign-off; nothing server-side
--    verifies the actor is actually the platform owner. The workflow
--    STEP (a distinct, required, explicitly-invoked approval_kind='owner'
--    row, structurally separate from the two staff approvals) is real
--    and enforced; the IDENTITY check behind it is not, because the
--    distinction the row needs does not exist in this schema yet. See
--    this task's own CTL-06-change-management.md and the review record
--    for the same note -- a future migration adding a real owner/staff
--    rank distinction is the fix, not something to invent here.
-- 3. SINGLE-ADMIN global_kill: app_private.staff_kill_capability_now
--    requires only is_platform_admin() -- ONE admin, no second
--    approver, applied to public.capability_registry immediately in the
--    same call. Recorded as its own change_kind='kill' row in the SAME
--    table as every governed change, for one unified incident/audit
--    trail, but it never enters the pending_approval/staff-approval
--    machinery at all -- an incident cannot wait for a second approver.
--    "global_kill" here means the existing PER-CAPABILITY kill_switch
--    0149 already ships (public.capability_registry.kill_switch),
--    reached through a fast single-admin path -- there is no
--    all-capabilities-at-once master switch anywhere in this schema, and
--    inventing one (a genuinely different, larger mechanism with no
--    existing authority or decided semantics) is out of scope here; if
--    an all-capabilities master switch was the intended reading, that is
--    a separate decision to make explicitly, not something to build
--    under this row's name.
--
-- ============================================================
-- CTL-08 -- ONE-ACTION REVERT, APPEND-ONLY.
-- ============================================================
-- app_private.staff_revert_capability_registry_entry(capability_key,
-- reason) is a SINGLE function call, is_platform_admin()-gated, that
-- looks up the capability's own capability_registry_audit trail (0149,
-- unmodified) for the row immediately BEFORE its current version, and
-- re-applies those exact field values through 0149's own
-- staff_upsert_capability_registry_entry -- the SAME write path, the
-- SAME versioning/audit triggers, every other change in this migration
-- uses. Restoring version N-1's values from version N does not edit or
-- delete the version-N (or any earlier) audit row: it produces a NEW
-- row at version N+1 whose new_row happens to match version N-1's --
-- governance/AGENTS.md's append-only correction discipline ("correct
-- them with linked compensating records"), applied to registry history
-- exactly as it already applies to payment history elsewhere in this
-- schema. reverts_audit_id on the resulting capability_change_requests
-- row names exactly which prior audit row was restored, for a readable
-- trail.
--
-- ROLLBACK: additive only, no production migration without separate
-- explicit approval.
--   drop function if exists app_private.staff_revert_capability_registry_entry(text, text);
--   drop function if exists app_private.staff_kill_capability_now(text, text);
--   drop function if exists app_private.staff_reject_capability_change(uuid, text);
--   drop function if exists app_private.staff_approve_capability_change(uuid, text);
--   drop function if exists app_private.staff_list_capability_change_approvals(uuid);
--   drop function if exists app_private.staff_list_capability_changes(text, integer);
--   drop function if exists app_private.staff_get_capability_change(uuid);
--   drop function if exists app_private.staff_propose_capability_change(text, text, text, boolean, integer, text, timestamptz, text);
--   drop function if exists app_private.capability_change_row(uuid);
--   drop function if exists app_private.apply_due_capability_change(uuid);
--   drop table if exists public.capability_change_approvals;
--   drop table if exists public.capability_change_requests;

-- =====================================================================
-- 1. CTL-06/07/09: the staged-change table itself. Every proposed
--    mutation of a capability_registry row (or a brand-new one) is
--    authored here first -- capability_registry itself is untouched
--    until a change reaches 'applied'.
-- =====================================================================
create table public.capability_change_requests (
  id uuid primary key default gen_random_uuid(),
  capability_key text not null
    check (capability_key ~ '^[a-z][a-z0-9_]{0,99}$'),
  change_kind text not null check (change_kind in ('update', 'kill', 'revert')),
  -- CTL-09's structural guard, copied token-for-token from 0149's
  -- capability_registry.capacity_class whitelist (CTL-14's own
  -- mechanism) -- see this migration's header for why a copy, not a
  -- reference, and why that makes the structural test meaningful.
  proposed_capacity_class text not null check (proposed_capacity_class in (
    'active_connector', 'active_widget', 'ai_usage', 'media_upload',
    'custom_asset', 'team_seat', 'automation_volume', 'master_canvas_module'
  )),
  proposed_description text not null check (char_length(proposed_description) between 1 and 500),
  proposed_kill_switch boolean not null default false,
  proposed_rollout_percentage integer not null default 100
    check (proposed_rollout_percentage between 0 and 100),
  proposed_min_tier text
    check (proposed_min_tier is null or proposed_min_tier in ('free', 'pro', 'creator', 'studio')),
  -- CTL-06: may be authored now, take effect later. Defaults to "now"
  -- (an ordinary change with no explicit staging) when not supplied by
  -- the caller.
  effective_at timestamptz not null default current_timestamp,
  -- CTL-07 rule 2: computed and frozen at propose time -- see the
  -- header. Always false for change_kind IN ('kill', 'revert'), which
  -- never pass through the approval machinery at all.
  requires_owner_signoff boolean not null default false,
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'applied', 'rejected')),
  -- Only populated for change_kind = 'revert' -- names exactly which
  -- prior capability_registry_audit row (0149) this revert restored.
  reverts_audit_id uuid references public.capability_registry_audit(id),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default current_timestamp,
  applied_at timestamptz,
  decided_at timestamptz,
  reason text
);

comment on table public.capability_change_requests is
  'CTL-06/07/08/09 (migration 0152), phase 2 Lane A. Every mutation of public.capability_registry proposed through this governance layer, staged (CTL-06 effective_at may be future), gated by capability_change_approvals (CTL-07), and -- once applied -- always written through 0149''s own app_private.staff_upsert_capability_registry_entry, never a parallel write path. proposed_capacity_class carries the identical closed whitelist as capability_registry.capacity_class (CTL-09/CTL-14): a durable-creator-record subject remains structurally unrepresentable here too.';

comment on column public.capability_change_requests.requires_owner_signoff is
  'CTL-07 rule 2: true only when this change moves an EXISTING capability whose current min_tier is pro/creator/studio to null/free (a paid->Free move) -- computed once at propose time, never recomputed at approval/apply time. See this migration''s header for the identity gap this rule''s enforcement still has (no is_platform_owner concept exists in app_users).';

create index capability_change_requests_capability_key_idx
  on public.capability_change_requests (capability_key, status);

create index capability_change_requests_status_idx
  on public.capability_change_requests (status, effective_at);

revoke all on public.capability_change_requests from public;
revoke all on public.capability_change_requests from bsa_app;

-- =====================================================================
-- 2. CTL-07: the approval ledger. One row per (change, approver) --
--    UNIQUE prevents the same person approving the same change twice,
--    which is what makes "two-staff" a two-PERSON count, not a
--    two-click count.
-- =====================================================================
create table public.capability_change_approvals (
  id uuid primary key default gen_random_uuid(),
  change_request_id uuid not null references public.capability_change_requests(id) on delete cascade,
  approval_kind text not null check (approval_kind in ('staff', 'owner')),
  approver_id uuid not null references public.app_users(id),
  approved_at timestamptz not null default current_timestamp,
  unique (change_request_id, approver_id)
);

comment on table public.capability_change_approvals is
  'CTL-07: an append-only approval ledger. UNIQUE(change_request_id, approver_id) makes "two-staff" a two-DISTINCT-PERSON requirement, not two clicks from one account -- see app_private.staff_approve_capability_change, which additionally rejects the proposer approving their own change.';

revoke all on public.capability_change_approvals from public;
revoke all on public.capability_change_approvals from bsa_app;

-- =====================================================================
-- 3. CTL-06 engine: apply a change to capability_registry the moment it
--    is due (status='approved' and effective_at has passed), called by
--    every read/write entry point below rather than by any scheduler.
--    See this migration's header for exactly what this does and does
--    not guarantee.
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

  -- The ONE write path: 0149's own staff_upsert_capability_registry_entry.
  -- Its own triggers (versioning + audit + generation bump) fire exactly
  -- as they would for any other caller -- this function invents no
  -- parallel mutation of capability_registry.
  perform app_private.staff_upsert_capability_registry_entry(
    req.capability_key, req.proposed_capacity_class, req.proposed_description,
    req.proposed_kill_switch, req.proposed_rollout_percentage, req.proposed_min_tier
  );

  update public.capability_change_requests
     set status = 'applied', applied_at = current_timestamp
   where id = target_change_request_id;
end
$$;

revoke execute on function app_private.apply_due_capability_change(uuid) from public;
grant execute on function app_private.apply_due_capability_change(uuid) to bsa_app;

-- =====================================================================
-- 4. Shared row-shaping helper. Every function below that returns a
--    change-request row returns it through this one, so the lazy-apply
--    check above runs on every read, not just some -- CTL-06 made
--    structural rather than remembered per call site.
-- =====================================================================
create or replace function app_private.capability_change_row(target_change_request_id uuid)
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
begin
  perform app_private.apply_due_capability_change(target_change_request_id);

  return query
    select
      r.id, r.capability_key, r.change_kind, r.status,
      r.proposed_capacity_class, r.proposed_description, r.proposed_kill_switch,
      r.proposed_rollout_percentage, r.proposed_min_tier,
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
-- 5. CTL-06: propose an ordinary governed change (change_kind='update').
--    Every constraint on capability_change_requests -- including CTL-09's
--    whitelist -- is the actual enforcement; this function adds no
--    parallel validation of the same fields, only the CTL-07 rule-2
--    computation, which cannot live in a CHECK constraint (it reads the
--    CURRENT registry row).
-- =====================================================================
create or replace function app_private.staff_propose_capability_change(
  target_capability_key text,
  target_capacity_class text,
  target_description text,
  target_kill_switch boolean,
  target_rollout_percentage integer,
  target_min_tier text,
  target_effective_at timestamptz,
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

  -- CTL-07 rule 2: see this migration's header. Only an EXISTING
  -- capability currently gated at a paid tier, moving to null/free,
  -- counts as a paid->Free move.
  owner_needed := cur_exists
    and cur_min_tier is not null and cur_min_tier <> 'free'
    and (target_min_tier is null or target_min_tier = 'free');

  insert into public.capability_change_requests (
    capability_key, change_kind, proposed_capacity_class, proposed_description,
    proposed_kill_switch, proposed_rollout_percentage, proposed_min_tier,
    effective_at, requires_owner_signoff, status, created_by, reason
  ) values (
    target_capability_key, 'update', target_capacity_class, target_description,
    coalesce(target_kill_switch, false), coalesce(target_rollout_percentage, 100), target_min_tier,
    coalesce(target_effective_at, current_timestamp), owner_needed, 'pending_approval', actor, target_reason
  ) returning capability_change_requests.id into new_id;

  return query select * from app_private.capability_change_row(new_id);
end
$$;

revoke execute on function app_private.staff_propose_capability_change(text, text, text, boolean, integer, text, timestamptz, text) from public;
grant execute on function app_private.staff_propose_capability_change(text, text, text, boolean, integer, text, timestamptz, text) to bsa_app;

-- =====================================================================
-- 6. Reads: get one, list (with its own lazy-apply pass over every due
--    row ahead of the listing query, so a list is never stale either).
-- =====================================================================
create or replace function app_private.staff_get_capability_change(target_change_request_id uuid)
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
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  return query select * from app_private.capability_change_row(target_change_request_id);
end
$$;

revoke execute on function app_private.staff_get_capability_change(uuid) from public;
grant execute on function app_private.staff_get_capability_change(uuid) to bsa_app;

create or replace function app_private.staff_list_capability_changes(target_status text, target_limit integer)
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

create or replace function app_private.staff_list_capability_change_approvals(target_change_request_id uuid)
returns table (id uuid, approval_kind text, approver_id uuid, approved_at timestamptz)
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
    select a.id, a.approval_kind, a.approver_id, a.approved_at
      from public.capability_change_approvals a
     where a.change_request_id = target_change_request_id
     order by a.approved_at, a.id;
end
$$;

revoke execute on function app_private.staff_list_capability_change_approvals(uuid) from public;
grant execute on function app_private.staff_list_capability_change_approvals(uuid) to bsa_app;

-- =====================================================================
-- 7. CTL-07 rule 1 + rule 2: approve. Records one approval, then flips
--    status to 'approved' the moment the required set is satisfied --
--    two DISTINCT 'staff' approvals always, plus one 'owner' approval
--    when requires_owner_signoff is true. The proposer may never approve
--    their own change (maker-checker).
-- =====================================================================
create or replace function app_private.staff_approve_capability_change(
  target_change_request_id uuid,
  target_approval_kind text
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
  if target_approval_kind = 'owner' and not req.requires_owner_signoff then
    raise exception 'this change does not require owner sign-off' using errcode = '22023';
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
-- 8. Reject: only while pending_approval, a reason is mandatory.
-- =====================================================================
create or replace function app_private.staff_reject_capability_change(
  target_change_request_id uuid,
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
-- 9. CTL-07 rule 3: single-admin global_kill. No approval, applied
--    immediately, recorded in the same table for a unified trail.
-- =====================================================================
create or replace function app_private.staff_kill_capability_now(
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
-- 10. CTL-08: one-action revert. See this migration's header.
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
    effective_at, requires_owner_signoff, status, created_by, applied_at, reverts_audit_id, reason
  ) values (
    target_capability_key, 'revert',
    prev_row ->> 'capacity_class', prev_row ->> 'description',
    (prev_row ->> 'kill_switch')::boolean, (prev_row ->> 'rollout_percentage')::integer, prev_row ->> 'min_tier',
    current_timestamp, false, 'applied', actor, current_timestamp, prev_audit_id, target_reason
  ) returning capability_change_requests.id into new_id;

  perform app_private.staff_upsert_capability_registry_entry(
    target_capability_key, prev_row ->> 'capacity_class', prev_row ->> 'description',
    (prev_row ->> 'kill_switch')::boolean, (prev_row ->> 'rollout_percentage')::integer, prev_row ->> 'min_tier'
  );

  return query select * from app_private.capability_change_row(new_id);
end
$$;

revoke execute on function app_private.staff_revert_capability_registry_entry(text, text) from public;
grant execute on function app_private.staff_revert_capability_registry_entry(text, text) to bsa_app;
