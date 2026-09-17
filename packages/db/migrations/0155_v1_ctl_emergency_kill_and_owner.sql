-- CTL — three jobs over the approval model: real platform-owner
-- identity (Job 1), §20.6.1's full emergency global_kill path (Job 2),
-- and closing the single-admin bypass on §20.2's registry fields
-- (Job 3).
--
-- AUTHORITY. FULL-PRODUCT-DEFINITION.md §20.6 and §20.6.1 in full.
-- bharatstudio-requirements/reviews/2026-09-17-platform-owner-identity-
-- decision.md (binding, read-only to this migration). Migrations 0149
-- (phase-1 control plane, read-only authority), 0152 (change
-- management, extended here), 0153 (§20.2 field set + the registry
-- write function this migration restructures).
--
-- MIGRATION NUMBER: 0155, pre-assigned. Fixture range
-- ...6f00-...6fff, pre-assigned, own self-contained fixture (this
-- migration does not touch packages/db/tests/fixtures/00_base_world.sql,
-- same posture 0152/0153 both already took).
--
-- ============================================================
-- JOB 1 — REAL PLATFORM OWNER IDENTITY.
-- ============================================================
-- Implements bharatstudio-requirements/reviews/2026-09-17-platform-
-- owner-identity-decision.md exactly:
--   * public.app_users.is_platform_owner boolean not null default false.
--   * "One, for now" is carried by app_users_platform_owner_singleton_idx,
--     a PARTIAL UNIQUE INDEX admitting at most one true row -- NOT a
--     singleton table, NOT a hardcoded id. Expanding later is DROP THIS
--     INDEX: no data migration, no column change, no history rewrite.
--     (`create unique index ... on app_users (is_platform_owner) where
--     is_platform_owner` -- every row the partial index admits has the
--     SAME indexed value, true, so uniqueness alone forces at most one.)
--   * An owner approval requires is_platform_owner AND is_platform_admin
--     -- the flags are orthogonal in the schema (is_platform_owner does
--     not touch or imply is_platform_admin) and conjoint at the check:
--     app_private.staff_approve_capability_change (below, CREATE OR
--     REPLACE, same signature/output as 0152) still requires
--     is_platform_admin() at the top of its body for EVERY approval kind
--     (unchanged from 0152), and additionally requires
--     app_private.is_platform_owner() when, and only when,
--     target_approval_kind = 'owner'.
--   * Owner is never self-conferred: app_private.staff_set_platform_owner
--     is the ONLY path that can ever write app_users.is_platform_owner
--     (bsa_app holds no UPDATE grant on public.app_users at all --
--     packages/db/migrations/0003_v1_l03_application.sql:494 grants it
--     SELECT only; the users_self_update RLS policy,
--     0002_v1_security_rls_archive.sql:191, is consequently unreachable
--     for this column via any raw client path today, since RLS cannot
--     authorise what the base GRANT does not permit in the first place).
--     The function itself rejects actor = target_user_id, requires
--     is_platform_admin(), requires a non-empty reason, and every write
--     is captured in public.platform_owner_audit -- audited "like any
--     other capability change" per the decision record, append-only by
--     the same structural trigger this migration uses throughout (see
--     app_private.reject_table_mutation below), not a convention.
--
-- ============================================================
-- JOB 2 — §20.6.1's EMERGENCY KILL PATH, IN FULL.
-- ============================================================
-- 0152 built the single-actor action and the mandatory reason
-- (app_private.staff_kill_capability_now, UNTOUCHED by this migration --
-- it remains the ordinary, no-expiry, no-ratification per-capability
-- kill_switch path it always was). This migration builds the SEPARATE,
-- fuller emergency path §20.6.1's own table specifies, as its own
-- subsystem: app_private.staff_fire_global_kill and five new tables.
-- Every value below is copied verbatim from §20.6.1's table, cited by
-- row:
--   * Maximum duration: 24 hours (row "Maximum duration"). Fixed, not
--     admin-chosen -- no shorter/longer duration is a decided input
--     anywhere in that row, so this migration does not invent one:
--     capability_kill_events.expires_at is ALWAYS exactly
--     fired_at + interval '24 hours', enforced by a CHECK constraint,
--     not merely set that way by convention.
--   * Ratification: "a second platform admin must ratify within 4
--     hours" (row "Ratification") -- app_private.staff_ratify_kill_event,
--     one additional distinct admin (never the firer), recorded once
--     (UNIQUE(kill_event_id) on capability_kill_ratifications).
--   * Escalation: "an unratified kill still runs to its 24-hour expiry
--     but is escalated to the owner at the 4-hour mark" (same row) --
--     computed READ-TIME (not ratified AND now >= fired_at + 4 hours),
--     the same CTL-06 read-time-correctness discipline 0152 established
--     for staged changes, applied here to a derived fact instead of a
--     status transition. No sweeper, no stored "escalated" row.
--   * Extension: "Only by the two-person path, with a stated new
--     expiry. There is no indefinite kill" (row "Extension") --
--     app_private.staff_propose_kill_extension (one admin, a stated
--     new_expires_at, a reason) then app_private.staff_approve_kill_
--     extension (a SECOND, distinct admin) -- maker-checker, the same
--     shape 0152's own two-staff rule already established for ordinary
--     changes. Each extension GRANT is itself capped at the SAME
--     decided 24-hour figure from its own request time (CHECK
--     new_expires_at <= requested_at + interval '24 hours') -- reusing
--     the one number this table decides, not inventing a second,
--     larger one for a "total lifetime."
--
--     RECONCILING TWO ROWS, STATED EXPLICITLY (a judgment call, not an
--     invented number): the "Maximum duration" row says a kill
--     "auto-reverts... unless a second admin has ratified it," which
--     read in isolation could mean bare ratification (no new expiry)
--     removes the 24-hour ceiling entirely -- directly contradicting
--     "there is no indefinite kill" two rows later. This migration reads
--     the two rows together: bare ratification (staff_ratify_kill_event)
--     records agreement and clears the 4-hour escalation flag, but does
--     NOT by itself move the expiry -- only a completed two-person
--     EXTENSION (staff_propose_kill_extension +
--     staff_approve_kill_extension), with its own stated, bounded new
--     expiry, ever does that. Every path that delays auto-revert is
--     therefore an explicit, bounded, two-person-approved grant -- never
--     an open-ended "ratified = stays on forever" state -- which is what
--     makes "there is no indefinite kill" hold structurally even for an
--     incident an admin pair keeps legitimately re-extending.
--   * Logging: "actor, timestamp, capability, reason, affected channel
--     count, live-channel count, ratifier, expiry, revert" (row
--     "Logging") -- every one of those fields is either a column on
--     capability_kill_events (actor=fired_by, timestamp=fired_at,
--     capability=capability_key, reason, affected_channel_count,
--     live_channel_count, expiry=expires_at) or derived read-time by
--     app_private.capability_kill_event_row (ratifier, revert -- see
--     "not editable" below).
--   * "Not editable by any admin, including the one who fired it" (same
--     row) -- STRUCTURALLY true, not a policy note:
--     capability_kill_events, capability_kill_ratifications,
--     capability_kill_extension_requests, capability_kill_extension_
--     approvals and capability_kill_reviews EACH carry a BEFORE UPDATE
--     OR DELETE trigger (app_private.reject_table_mutation) that raises
--     unconditionally, for every role including the table owner's own
--     DDL-time superuser session (proven in packages/db/tests/
--     ctl_emergency_kill_and_owner.sql by attempting a direct UPDATE/
--     DELETE from the SAME superuser session the test itself runs as,
--     and asserting it is rejected). Ratification, extension and review
--     are consequently separate append-only tables referencing the
--     original fire event by id, never a column update on that row --
--     the SAME event-sourced-ledger technique 0152 already uses for
--     capability_change_approvals (never UPDATEd; membership in the
--     ledger IS the fact), extended here to the fire event's own row,
--     which 0152's capability_change_requests.status pattern does not
--     need (that table is legitimately mutable by design; this one is
--     not, by requirement).
--   * "affected channel count, live-channel count" -- CALLER-SUPPLIED
--     integers, not computed live by this migration. Computing a true
--     current affected/live count would mean scanning every channel's
--     resolved capability entitlement, exactly the expensive per-
--     capability query CTL-03's resolved-blob cache (0149) exists to
--     avoid, and no impact-preview computation exists anywhere in this
--     schema to call into (§20.6's own "every change previews an impact
--     count" is a documented, already-decided-to-exist ADMIN UI
--     feature -- CTL-04/05/13, a different repository, out of scope
--     here, per this task's own instructions). staff_fire_global_kill
--     takes them as parameters, exactly as it already takes `reason` as
--     a caller-supplied value.
--   * Notification / billing -- "affected creators are told... in
--     Companion and by email... never billed for a capability that is
--     off" (row "Notification"). NEITHER MECHANISM EXISTS IN THIS
--     SCHEMA and NEITHER IS BUILT HERE, per this task's own explicit
--     instruction not to invent one. What is missing, precisely: (1) no
--     Companion-push or email-notification dispatch exists anywhere in
--     this migration's reach that a kill event could enqueue into --
--     apps/api has no "notify creators of channel X" primitive this
--     migration can find and did not go looking for one outside its own
--     scope; (2) no billing/metering system reads capability_registry.
--     kill_switch at all today (grep across apps/api/src for a billing
--     read of kill_switch returns nothing), so "never billed for a
--     capability that is off" has no system to attach to yet -- it is
--     not merely unimplemented, there is no metering call site that
--     WOULD need a kill_switch check added. Both would attach to
--     capability_kill_events (a trigger-driven outbox entry on INSERT,
--     mirroring event_outbox's own established shape, is the natural
--     future mechanism for (1); a kill_switch guard in whatever future
--     billing/metering read path is built is the natural mechanism for
--     (2)) -- recorded here as follow-up, not invented as a stub.
--   * Post-incident review -- "Mandatory within 72 hours, written,
--     attached to the log entry. A kill with no review blocks further
--     kills by that actor until it is filed" (row "Post-incident
--     review"). app_private.staff_file_kill_review records one review
--     per kill event (UNIQUE(kill_event_id) on capability_kill_reviews).
--     The BLOCKING RULE is enforcement, not documentation:
--     staff_fire_global_kill's own body queries for any PRIOR kill event
--     fired by the SAME actor with no matching capability_kill_reviews
--     row and, if one exists, refuses to fire a new kill at all (SQLSTATE
--     55000, object_not_in_prerequisite_state) -- proven behaviourally in
--     the SQL test, not left as a comment. The 72-hour figure is
--     recorded as the SLA target (derived read-time: reviewed_at <=
--     fired_at + interval '72 hours') but filing is never hard-rejected
--     after 72 hours has passed -- "until it is filed" is read as
--     "filing (whenever it happens) is what unblocks," not "miss the
--     window and this admin can never fire another kill again," which
--     this migration does not read into that sentence and will not
--     invent.
--   * "global_kill may never perform a tier, limit or pricing change"
--     (§20.6.1's own closing sentence) -- STRUCTURALLY true:
--     app_private.staff_fire_global_kill's parameter list is
--     (capability_key, reason, affected_channel_count, live_channel_
--     count) -- there is no min_tier/limits/rollout_percentage/
--     capacity_class parameter anywhere on it, or on staff_ratify_
--     kill_event/staff_propose_kill_extension/staff_approve_kill_
--     extension/staff_file_kill_review, so a caller cannot REQUEST such
--     a change through this path even by accident (proven structurally
--     in the SQL test via information_schema.parameters, the same
--     technique CTL-14/CTL-09 already use for their own whitelists).
--     Internally, staff_fire_global_kill reads the capability's CURRENT
--     capacity_class/description/rollout_percentage/min_tier/kind/
--     limits/beta/marketing_* and passes them straight through
--     unchanged to the one write it performs (kill_switch=true, nothing
--     else) -- and the auto-revert path restores the EXACT pre-kill
--     audit snapshot, so neither direction of this subsystem can ever
--     drift those fields.
--   * READ-TIME CORRECTNESS FOR AUTO-REVERT, NO SWEEPER REQUIRED --
--     app_private.apply_due_kill_revert is called at the start of EVERY
--     read/write entry point below (via app_private.
--     capability_kill_event_row, the shared row-shaping helper every
--     fire/ratify/extend/review/get/list function returns through --
--     exactly capability_change_row's own 0152 pattern), so a kill
--     event whose effective expiry has already passed is restored to
--     its pre-kill state on the VERY NEXT read through this plane, with
--     no explicit apply/sweep call anywhere. Proven in the SQL test by
--     firing a kill, back-dating its expiry (via a direct UPDATE at the
--     TEST's own superuser level before this migration's append-only
--     trigger existed on that row -- see the test file's own comment on
--     why that one direct write is legitimate test setup, not a claim
--     that admins can do this), and asserting the VERY NEXT plain
--     get/list call both reports reverted=true AND finds capability_
--     registry.kill_switch already back to its pre-kill value, with no
--     apply/sweep call in between. A periodic sweep (RT-04/RT-05's
--     leased-outbox shape) would close the "nobody happened to read it"
--     latency gap the same way 0152's own header already flags for
--     staged changes -- not built here, same reasoning, same follow-up
--     posture.
--
-- ============================================================
-- JOB 3 — CLOSING THE SINGLE-ADMIN BYPASS ON app_private.staff_set_
-- capability_registry_entry (0153).
-- ============================================================
-- THE BYPASS: PUT /v1/admin/capability-registry/entries/{key} calls
-- app_private.staff_set_capability_registry_entry directly -- a single
-- platform admin, no approval round -- which until this migration could
-- change min_tier, kill_switch, rollout_percentage, limits and
-- capacity_class on an EXISTING capability immediately, bypassing
-- §20.6's "two-person approval for every capability change" and, via
-- min_tier, the paid->Free owner sign-off entirely. A guard INSIDE
-- staff_set_capability_registry_entry was prototyped and reverted:
-- 0152's approved-apply path for the ORIGINAL six fields is unaffected
-- (it calls 0149's staff_upsert_capability_registry_entry, a completely
-- separate function this migration does not touch), but 0153's own
-- staff_revert_capability_registry_entry (CTL-08) calls THIS function --
-- and revert is explicitly legitimate under §20.6 ("a capability can be
-- reverted to its previous version in one action"), so guarding the
-- function itself broke revert, which packages/db/tests/
-- ctl_registry_spec_alignment.sql's own CTL-08 assertions caught
-- immediately.
--
-- THE FIX -- a restructure, not a guard:
--   * app_private.set_capability_registry_entry_unchecked (NEW,
--     internal): the exact write body 0153's staff_set_capability_
--     registry_entry already had, MINUS the is_platform_admin() gate --
--     revoked from public, NOT granted to bsa_app at all. Reachable only
--     from another SECURITY DEFINER function owned by this migration's
--     own role (there is no grant path for the running API to call it
--     directly, by construction, not by convention).
--   * app_private.staff_set_capability_registry_entry (CREATE OR
--     REPLACE, IDENTICAL 12-argument signature and 14-column output to
--     0153 -- the route/store call this exact name, unchanged): still
--     requires is_platform_admin() first, exactly as before, THEN checks
--     whether target_capability_key already exists in capability_
--     registry. If it does NOT exist (a brand-new capability), the call
--     proceeds -- "creating a new capability single-admin is acceptable,
--     nothing is live for it yet," this task's own words. If it DOES
--     exist, the call is rejected (SQLSTATE 42501) with a message naming
--     the correct path (0152's propose/approve/apply workflow) -- this
--     is the exact bypass closure.
--   * app_private.staff_revert_capability_registry_entry (CREATE OR
--     REPLACE, IDENTICAL signature/output to 0152/0153): now calls
--     set_capability_registry_entry_unchecked directly instead of
--     staff_set_capability_registry_entry -- bypassing the "existing
--     capability" governance gate exactly the way revert is supposed
--     to, since it is restoring a KNOWN PRIOR AUDITED STATE, never
--     proposing a fresh, ungoverned one.
--   * Job 2's app_private.apply_due_kill_revert (auto-revert-at-expiry)
--     is the OTHER legitimate caller of the unguarded helper -- the
--     "approved-apply path" this task's own instructions name alongside
--     revert: it too restores a known prior audited snapshot
--     automatically, at read time, never a fresh change. Both callers
--     share the identical restore-from-audit-snapshot technique.
--
-- THE REPORTED GAP THIS CLOSURE LEAVES, NAMED RATHER THAN PAPERED OVER:
-- 0153's own header already recorded that kind/limits/beta/marketing_*
-- are NOT threaded through 0152's propose/approve/apply workflow (a
-- real, bounded follow-up, not done there). After this job, THAT is the
-- ONLY governed path §20.6 describes for those six fields, and it does
-- not yet exist for them -- so an admin cannot change kind/limits/beta/
-- marketing_* on an EXISTING capability through ANY path in this schema
-- until that follow-up (staff_propose_capability_registry_change /
-- staff_get/list_..._full, mirroring 0153's own staff_set/get/list
-- split) is built. This migration does not build it (out of scope,
-- exactly as 0153 already deferred it) and does not invent a narrower
-- allowance either -- §20.6 says "every capability change," and this
-- migration takes that at its word rather than quietly carving out an
-- exception for six fields because their governed path is not built
-- yet.
--
-- ============================================================
-- CTL-15, READ CAREFULLY: capability_kill_events.expires_at (and
-- capability_kill_extension_requests.new_expires_at) are NOT a
-- data-retention window.
-- ============================================================
-- CTL-15 (0149) forbids a PER-TIER RETENTION FIELD on the capability
-- registry -- a column that would shorten or extend how long a CREATOR's
-- own data (payments, receipts, event history, configuration, ...) is
-- kept, varying by tier. expires_at here is a KILL EVENT's own deadline
-- -- when THIS SPECIFIC EMERGENCY OVERRIDE of a capability's kill_switch
-- auto-reverts -- not a data-retention window on anything a creator
-- owns. It governs how long an ADMIN ACTION stays in effect, not how
-- long DATA is kept; no creator record's retention changes by one
-- second because a kill event exists or expires. §12.6.2's guarantee
-- (retention is one schedule, by data class, identical across every
-- tier, never a per-tier field) is completely undisturbed: nothing this
-- migration creates is keyed by tier at all. The CTL-15 scan in
-- packages/db/tests/ctl_capability_registry.sql (0149's own test) is
-- SCOPED to the tables 0149 itself created and is consequently
-- unaffected by this migration's tables either way; this migration
-- re-proves the SAME distinction over its OWN new tables in packages/db/
-- tests/ctl_emergency_kill_and_owner.sql -- scanning every column of
-- every table this migration creates for 'retention'/'retain'/'ttl' and
-- asserting NONE exist, and separately asserting the ONLY columns
-- matching 'expir' are the three named above, each on a KILL EVENT, not
-- a creator record.
--
-- ============================================================
-- EXISTING GUARDS PRESERVED, UNCHANGED BY THIS MIGRATION.
-- ============================================================
-- CTL-14 (capacity_class closed whitelist, 0149) -- not touched; this
-- migration adds no new capacity_class-bearing column anywhere. CTL-03
-- (bsa_app has zero table-level grant on any capability_registry* table)
-- -- every new table below follows the identical revoke-from-public-and-
-- bsa_app posture. 0151's payment_decision/stored_record_decision
-- CHECK (= 'allow') -- untouched, out of this migration's reach entirely.
--
-- ROLLBACK: additive only, no production migration without separate
-- explicit approval.
--   drop function if exists app_private.staff_list_kill_events(text, integer);
--   drop function if exists app_private.staff_get_kill_event(uuid);
--   drop function if exists app_private.staff_file_kill_review(uuid, text);
--   drop function if exists app_private.staff_approve_kill_extension(uuid);
--   drop function if exists app_private.staff_propose_kill_extension(uuid, timestamptz, text);
--   drop function if exists app_private.staff_ratify_kill_event(uuid);
--   drop function if exists app_private.staff_fire_global_kill(text, text, integer, integer);
--   drop function if exists app_private.capability_kill_event_row(uuid);
--   drop function if exists app_private.apply_due_kill_revert(uuid);
--   drop function if exists app_private.capability_kill_effective_expires_at(uuid);
--   drop table if exists public.capability_kill_reviews;
--   drop table if exists public.capability_kill_extension_approvals;
--   drop table if exists public.capability_kill_extension_requests;
--   drop table if exists public.capability_kill_ratifications;
--   drop table if exists public.capability_kill_events;
--   drop function if exists app_private.staff_revert_capability_registry_entry(text, text); -- restored to 0153's original body by re-running 0153 unmodified
--   drop function if exists app_private.staff_set_capability_registry_entry(text, text, text, boolean, integer, text, text, jsonb, boolean, boolean, text, text); -- restored to 0153's original body by re-running 0153 unmodified
--   drop function if exists app_private.set_capability_registry_entry_unchecked(text, text, text, boolean, integer, text, text, jsonb, boolean, boolean, text, text);
--   drop function if exists app_private.staff_approve_capability_change(uuid, text); -- restored to 0152's original body by re-running 0152 unmodified
--   drop function if exists app_private.staff_set_platform_owner(uuid, boolean, text);
--   drop function if exists app_private.is_platform_owner();
--   drop table if exists public.platform_owner_audit;
--   drop function if exists app_private.reject_table_mutation();
--   drop index if exists public.app_users_platform_owner_singleton_idx;
--   alter table public.app_users drop column if exists is_platform_owner;

-- =====================================================================
-- 0. Shared building block: a generic "this table is append-only"
--    trigger function, used by every new immutable-log table below.
-- =====================================================================
create or replace function app_private.reject_table_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only -- % is not permitted on this table, structurally, for any role', tg_table_name, tg_op
    using errcode = '0A000';
end
$$;

revoke execute on function app_private.reject_table_mutation() from public;

-- =====================================================================
-- JOB 1a: is_platform_owner, the singleton index, the audit trail, and
-- the read helper.
-- =====================================================================
alter table public.app_users add column is_platform_owner boolean not null default false;

comment on column public.app_users.is_platform_owner is
  'Owner decision 2026-09-17 (bharatstudio-requirements/reviews/2026-09-17-platform-owner-identity-decision.md). Orthogonal to is_platform_admin (0073) -- being owner does not imply admin; app_private.staff_approve_capability_change requires BOTH for approval_kind=''owner''. Settable ONLY via app_private.staff_set_platform_owner (never self-conferred, always audited in public.platform_owner_audit) -- bsa_app holds no UPDATE grant on this table at all (0003_v1_l03_application.sql:494, SELECT only), so no raw client path can write this column under any circumstance.';

create unique index app_users_platform_owner_singleton_idx
  on public.app_users (is_platform_owner)
  where is_platform_owner;

comment on index public.app_users_platform_owner_singleton_idx is
  'Owner decision 2026-09-17: "one owner for now, expandable later." Every row this partial index admits carries the SAME indexed value (true), so uniqueness alone forces at most one. TO EXPAND: DROP THIS INDEX. No data migration, no column change, no history rewrite -- every existing app_users row, every platform_owner_audit row and every capability_change_approvals row stays exactly as it is.';

create table public.platform_owner_audit (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null references public.app_users(id),
  previous_value boolean not null,
  new_value boolean not null,
  changed_by uuid not null references public.app_users(id),
  changed_at timestamptz not null default current_timestamp,
  reason text not null check (char_length(trim(reason)) > 0)
);

comment on table public.platform_owner_audit is
  'Job 1: append-only record of every is_platform_owner change -- "audited like any other capability change" per the owner decision record. Written ONLY by app_private.staff_set_platform_owner, in the same transaction as the app_users write it audits.';

create index platform_owner_audit_target_idx on public.platform_owner_audit (target_user_id, changed_at);

revoke all on public.platform_owner_audit from public;
revoke all on public.platform_owner_audit from bsa_app;

create trigger platform_owner_audit_append_only
  before update or delete on public.platform_owner_audit
  for each row execute function app_private.reject_table_mutation();

create or replace function app_private.is_platform_owner()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select exists (
    select 1 from public.app_users
     where id = app_private.current_user_id()
       and is_platform_owner
       and closed_at is null
  )
$$;

revoke execute on function app_private.is_platform_owner() from public;
grant execute on function app_private.is_platform_owner() to bsa_app;

-- =====================================================================
-- JOB 1b: the ONLY write path for is_platform_owner. Never self-
-- conferred (actor <> target, checked explicitly); requires
-- is_platform_admin(); a reason is mandatory; every write is captured
-- in platform_owner_audit inside the SAME transaction.
-- =====================================================================
create or replace function app_private.staff_set_platform_owner(
  target_user_id uuid,
  target_is_owner boolean,
  target_reason text
)
returns table (user_id uuid, is_platform_owner boolean, changed_by uuid, changed_at timestamptz, reason text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  actor uuid;
  prev_value boolean;
  v_changed_at timestamptz;
  v_new_value boolean;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  actor := app_private.current_user_id();

  if actor = target_user_id then
    raise exception 'platform owner status may not be self-conferred' using errcode = '42501';
  end if;
  if target_reason is null or length(trim(target_reason)) = 0 then
    raise exception 'a reason is required to change platform owner status' using errcode = '22023';
  end if;

  select au.is_platform_owner into prev_value from public.app_users au where au.id = target_user_id for update;
  if not found then
    raise exception 'user % does not exist', target_user_id using errcode = '22023';
  end if;

  v_new_value := coalesce(target_is_owner, false);

  update public.app_users set is_platform_owner = v_new_value, updated_at = current_timestamp
   where id = target_user_id;

  v_changed_at := current_timestamp;
  insert into public.platform_owner_audit (target_user_id, previous_value, new_value, changed_by, changed_at, reason)
  values (target_user_id, coalesce(prev_value, false), v_new_value, actor, v_changed_at, target_reason);

  user_id := target_user_id;
  is_platform_owner := v_new_value;
  changed_by := actor;
  changed_at := v_changed_at;
  reason := target_reason;
  return next;
end
$$;

revoke execute on function app_private.staff_set_platform_owner(uuid, boolean, text) from public;
grant execute on function app_private.staff_set_platform_owner(uuid, boolean, text) to bsa_app;

-- =====================================================================
-- JOB 1c: fix app_private.staff_approve_capability_change (0152).
-- CREATE OR REPLACE, IDENTICAL signature/output to 0152 -- body-only.
-- Every line is 0152's own body verbatim except the one new block
-- requiring app_private.is_platform_owner() for approval_kind='owner'.
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
  if target_approval_kind = 'owner' then
    if not req.requires_owner_signoff then
      raise exception 'this change does not require owner sign-off' using errcode = '22023';
    end if;
    -- Job 1 / owner decision 2026-09-17: an 'owner' approval demands
    -- REAL owner identity, not merely platform-admin membership.
    -- is_platform_admin() was already required above, unconditionally,
    -- for every approval kind -- this check is the ADDITIONAL, conjoint
    -- is_platform_owner() requirement, never skipped even though every
    -- caller reaching this line has already passed the admin gate.
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
-- Grants unchanged, inherited from 0152 (CREATE OR REPLACE preserves an
-- unchanged function's ACL): revoked from public, granted to bsa_app.

-- =====================================================================
-- JOB 3a: the internal unguarded write helper. Exact body 0153's
-- staff_set_capability_registry_entry already had, minus the
-- is_platform_admin() gate (callers below already gate). Revoked from
-- public; deliberately NOT granted to bsa_app at all.
-- =====================================================================
create or replace function app_private.set_capability_registry_entry_unchecked(
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

revoke execute on function app_private.set_capability_registry_entry_unchecked(text, text, text, boolean, integer, text, text, jsonb, boolean, boolean, text, text) from public;
-- Deliberately NOT granted to bsa_app -- see this migration's Job 3
-- header. Reachable only from another SECURITY DEFINER function owned
-- by this migration's own role.

-- =====================================================================
-- JOB 3b: the public, guarded entry point. CREATE OR REPLACE, IDENTICAL
-- 12-argument signature and 14-column output to 0153 -- the route/store
-- call this exact name unchanged. Still requires is_platform_admin()
-- first; NEW: rejects any call targeting an EXISTING capability.
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
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;

  -- Job 3 (migration 0155): §20.6 requires two-person approval for
  -- EVERY capability change. Creating a brand-new capability alone is
  -- acceptable -- nothing is live for it yet. CHANGING an existing
  -- capability's row through this single-admin entry point is the
  -- bypass this job closes -- see this migration's own Job 3 header for
  -- exactly what governed path exists today (0152's propose/approve/
  -- apply, for the original six fields only) and what does not yet
  -- (the same for kind/limits/beta/marketing_*, a reported follow-up).
  if exists (select 1 from public.capability_registry reg where reg.capability_key = target_capability_key) then
    raise exception 'changing an EXISTING capability''s registry fields must go through the two-person capability_change_requests workflow (CTL-06/07) -- this single-admin entry point may only CREATE a new capability' using errcode = '42501';
  end if;

  return query select * from app_private.set_capability_registry_entry_unchecked(
    target_capability_key, target_capacity_class, target_description, target_kill_switch,
    target_rollout_percentage, target_min_tier, target_kind, target_limits, target_beta,
    target_marketing_visible, target_marketing_label, target_marketing_blurb
  );
end
$$;
-- Grants unchanged, inherited from 0153.

-- =====================================================================
-- JOB 3c: CTL-08 revert now calls the UNGUARDED helper directly --
-- restoring a known prior audited state is exactly what revert is for,
-- and must bypass the "existing capability" gate JOB 3b just added.
-- CREATE OR REPLACE, IDENTICAL signature/output to 0152/0153 -- every
-- line is 0153's own body verbatim except the final call.
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
-- Grants unchanged, inherited from 0152/0153.

-- =====================================================================
-- JOB 2a: the five new tables. Every one revoked from public AND
-- bsa_app (CTL-03's posture extended here too) and carries the
-- append-only trigger.
-- =====================================================================
create table public.capability_kill_events (
  id uuid primary key default gen_random_uuid(),
  capability_key text not null references public.capability_registry(capability_key),
  fired_by uuid not null references public.app_users(id),
  fired_at timestamptz not null default current_timestamp,
  reason text not null check (char_length(trim(reason)) > 0),
  affected_channel_count integer not null check (affected_channel_count >= 0),
  live_channel_count integer not null check (live_channel_count >= 0 and live_channel_count <= affected_channel_count),
  pre_kill_audit_id uuid not null references public.capability_registry_audit(id),
  -- §20.6.1 "Maximum duration | 24 hours" -- fixed, not admin-chosen.
  expires_at timestamptz not null,
  check (expires_at = fired_at + interval '24 hours')
);

comment on table public.capability_kill_events is
  '§20.6.1 (migration 0155): the emergency global_kill path''s immutable, append-only incident log. Ratification, extension and post-incident review are SEPARATE append-only tables referencing this one by id -- never a column update here. See this migration''s Job 2 header for the full row-by-row mapping to §20.6.1''s table, and the CTL-15 note above for why expires_at is a kill-event deadline, not a data-retention window.';

revoke all on public.capability_kill_events from public;
revoke all on public.capability_kill_events from bsa_app;

create trigger capability_kill_events_append_only
  before update or delete on public.capability_kill_events
  for each row execute function app_private.reject_table_mutation();

create index capability_kill_events_capability_idx on public.capability_kill_events (capability_key, fired_at);
create index capability_kill_events_fired_by_idx on public.capability_kill_events (fired_by, fired_at);

create table public.capability_kill_ratifications (
  id uuid primary key default gen_random_uuid(),
  kill_event_id uuid not null references public.capability_kill_events(id),
  ratified_by uuid not null references public.app_users(id),
  ratified_at timestamptz not null default current_timestamp,
  unique (kill_event_id)
);

comment on table public.capability_kill_ratifications is
  '§20.6.1 "Ratification": one additional, distinct platform admin (never the firer) ratifying a kill event. UNIQUE(kill_event_id) -- one ratification per event. Append-only, same trigger as capability_kill_events.';

revoke all on public.capability_kill_ratifications from public;
revoke all on public.capability_kill_ratifications from bsa_app;

create trigger capability_kill_ratifications_append_only
  before update or delete on public.capability_kill_ratifications
  for each row execute function app_private.reject_table_mutation();

create table public.capability_kill_extension_requests (
  id uuid primary key default gen_random_uuid(),
  kill_event_id uuid not null references public.capability_kill_events(id),
  requested_by uuid not null references public.app_users(id),
  requested_at timestamptz not null default current_timestamp,
  new_expires_at timestamptz not null,
  reason text not null check (char_length(trim(reason)) > 0),
  -- Reuses §20.6.1's OWN "Maximum duration: 24 hours" figure as this
  -- grant's own ceiling -- see this migration's Job 2 header for why
  -- this is a reuse, not an invented second number.
  check (new_expires_at <= requested_at + interval '24 hours')
);

comment on table public.capability_kill_extension_requests is
  '§20.6.1 "Extension": the propose half of the two-person path. Approved by capability_kill_extension_approvals below (a distinct admin). Append-only.';

revoke all on public.capability_kill_extension_requests from public;
revoke all on public.capability_kill_extension_requests from bsa_app;

create trigger capability_kill_extension_requests_append_only
  before update or delete on public.capability_kill_extension_requests
  for each row execute function app_private.reject_table_mutation();

create table public.capability_kill_extension_approvals (
  id uuid primary key default gen_random_uuid(),
  extension_request_id uuid not null references public.capability_kill_extension_requests(id),
  approved_by uuid not null references public.app_users(id),
  approved_at timestamptz not null default current_timestamp,
  unique (extension_request_id)
);

comment on table public.capability_kill_extension_approvals is
  '§20.6.1 "Extension": the approve half. UNIQUE(extension_request_id) -- exactly one approval finalises an extension request (maker-checker, same shape as 0152''s own two-staff rule 1). Append-only.';

revoke all on public.capability_kill_extension_approvals from public;
revoke all on public.capability_kill_extension_approvals from bsa_app;

create trigger capability_kill_extension_approvals_append_only
  before update or delete on public.capability_kill_extension_approvals
  for each row execute function app_private.reject_table_mutation();

create table public.capability_kill_reviews (
  id uuid primary key default gen_random_uuid(),
  kill_event_id uuid not null references public.capability_kill_events(id),
  reviewed_by uuid not null references public.app_users(id),
  reviewed_at timestamptz not null default current_timestamp,
  review_text text not null check (char_length(trim(review_text)) > 0),
  unique (kill_event_id)
);

comment on table public.capability_kill_reviews is
  '§20.6.1 "Post-incident review": one written review per kill event (UNIQUE(kill_event_id)), attached to the log entry by kill_event_id. app_private.staff_fire_global_kill refuses to fire a new kill for an actor with any prior kill event missing a row here -- the blocking rule, enforced, not documented. Append-only.';

revoke all on public.capability_kill_reviews from public;
revoke all on public.capability_kill_reviews from bsa_app;

create trigger capability_kill_reviews_append_only
  before update or delete on public.capability_kill_reviews
  for each row execute function app_private.reject_table_mutation();

-- =====================================================================
-- JOB 2b: effective-expiry helper (base expiry, or the latest APPROVED
-- extension's stated new expiry, whichever is later).
-- =====================================================================
create or replace function app_private.capability_kill_effective_expires_at(target_kill_event_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select greatest(
    (select ev.expires_at from public.capability_kill_events ev where ev.id = target_kill_event_id),
    coalesce((
      select max(req.new_expires_at)
        from public.capability_kill_extension_requests req
        join public.capability_kill_extension_approvals appr on appr.extension_request_id = req.id
       where req.kill_event_id = target_kill_event_id
    ), '-infinity'::timestamptz)
  )
$$;

revoke execute on function app_private.capability_kill_effective_expires_at(uuid) from public;
grant execute on function app_private.capability_kill_effective_expires_at(uuid) to bsa_app;

-- =====================================================================
-- JOB 2c: read-time auto-revert. Called by capability_kill_event_row
-- (below), which every fire/ratify/extend/review/get/list function
-- returns through -- CTL-06's read-time-correctness discipline, applied
-- here. Idempotent: a no-op once the capability's kill_switch is
-- already back to false, by whatever path.
-- =====================================================================
create or replace function app_private.apply_due_kill_revert(target_kill_event_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  ev record;
  eff timestamptz;
  cur_kill boolean;
  snap jsonb;
begin
  select * into ev from public.capability_kill_events where capability_kill_events.id = target_kill_event_id;
  if not found then
    return;
  end if;

  eff := app_private.capability_kill_effective_expires_at(target_kill_event_id);
  if current_timestamp < eff then
    return;
  end if;

  select reg.kill_switch into cur_kill from public.capability_registry reg where reg.capability_key = ev.capability_key;
  if cur_kill is distinct from true then
    return;
  end if;

  select audit.new_row into snap from public.capability_registry_audit audit where audit.id = ev.pre_kill_audit_id;
  if snap is null then
    return;
  end if;

  -- Restore the EXACT full row snapshot captured immediately before this
  -- kill fired, via the SAME unguarded internal helper Job 3 introduced
  -- -- the "approved-apply path" that helper's own header names as a
  -- legitimate second caller alongside CTL-08 revert.
  perform app_private.set_capability_registry_entry_unchecked(
    ev.capability_key, snap ->> 'capacity_class', snap ->> 'description',
    (snap ->> 'kill_switch')::boolean, (snap ->> 'rollout_percentage')::integer, snap ->> 'min_tier',
    snap ->> 'kind', coalesce(snap -> 'limits', '{}'::jsonb),
    coalesce((snap ->> 'beta')::boolean, false), coalesce((snap ->> 'marketing_visible')::boolean, false),
    snap ->> 'marketing_label', snap ->> 'marketing_blurb'
  );
end
$$;

revoke execute on function app_private.apply_due_kill_revert(uuid) from public;
grant execute on function app_private.apply_due_kill_revert(uuid) to bsa_app;

-- =====================================================================
-- JOB 2d: the shared row-shaping helper. Lazy-applies auto-revert first,
-- then shapes the full row including read-time-derived fields
-- (escalated_to_owner, reverted, reviewed).
-- =====================================================================
create or replace function app_private.capability_kill_event_row(target_kill_event_id uuid)
returns table (
  id uuid, capability_key text, fired_by uuid, fired_at timestamptz, reason text,
  affected_channel_count integer, live_channel_count integer,
  expires_at timestamptz, ratified_by uuid, ratified_at timestamptz,
  escalated_to_owner boolean, reverted boolean,
  reviewed boolean, reviewed_by uuid, reviewed_at timestamptz, review_text text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  perform app_private.apply_due_kill_revert(target_kill_event_id);

  return query
    select
      ev.id, ev.capability_key, ev.fired_by, ev.fired_at, ev.reason,
      ev.affected_channel_count, ev.live_channel_count,
      app_private.capability_kill_effective_expires_at(ev.id),
      rat.ratified_by, rat.ratified_at,
      (rat.ratified_by is null and current_timestamp >= ev.fired_at + interval '4 hours'),
      (current_timestamp >= app_private.capability_kill_effective_expires_at(ev.id)),
      (rev.id is not null), rev.reviewed_by, rev.reviewed_at, rev.review_text
    from public.capability_kill_events ev
    left join public.capability_kill_ratifications rat on rat.kill_event_id = ev.id
    left join public.capability_kill_reviews rev on rev.kill_event_id = ev.id
    where ev.id = target_kill_event_id;
end
$$;

revoke execute on function app_private.capability_kill_event_row(uuid) from public;
grant execute on function app_private.capability_kill_event_row(uuid) to bsa_app;

-- =====================================================================
-- JOB 2e: fire. No min_tier/limits/rollout_percentage/capacity_class
-- parameter exists on this function -- see this migration's Job 2
-- header for why that is what makes "may never perform a tier, limit or
-- pricing change" structurally true. Enforces the review-blocks-next-
-- kill rule behaviourally before doing anything else.
-- =====================================================================
create or replace function app_private.staff_fire_global_kill(
  target_capability_key text,
  target_reason text,
  target_affected_channel_count integer,
  target_live_channel_count integer
)
returns table (
  id uuid, capability_key text, fired_by uuid, fired_at timestamptz, reason text,
  affected_channel_count integer, live_channel_count integer,
  expires_at timestamptz, ratified_by uuid, ratified_at timestamptz,
  escalated_to_owner boolean, reverted boolean,
  reviewed boolean, reviewed_by uuid, reviewed_at timestamptz, review_text text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  actor uuid;
  cur record;
  pre_audit_id uuid;
  new_event_id uuid;
  blocked boolean;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  if target_reason is null or length(trim(target_reason)) = 0 then
    raise exception 'a reason is required to fire an emergency kill' using errcode = '22023';
  end if;
  actor := app_private.current_user_id();

  -- §20.6.1: "A kill with no review blocks further kills by that actor
  -- until it is filed." Enforced, not documented.
  select exists (
    select 1 from public.capability_kill_events prior
     where prior.fired_by = actor
       and not exists (select 1 from public.capability_kill_reviews r where r.kill_event_id = prior.id)
  ) into blocked;
  if blocked then
    raise exception 'a previous emergency kill fired by this admin has no post-incident review on file -- file it before firing another' using errcode = '55000';
  end if;

  select reg.capacity_class, reg.description, reg.rollout_percentage, reg.min_tier,
         reg.kind, reg.limits, reg.beta, reg.marketing_visible, reg.marketing_label, reg.marketing_blurb
    into cur
    from public.capability_registry reg where reg.capability_key = target_capability_key;
  if not found then
    raise exception 'capability % does not exist', target_capability_key using errcode = '22023';
  end if;

  -- The pre-kill audit snapshot: the LATEST existing audit row for this
  -- capability, captured BEFORE the kill write below produces a new one.
  select audit.id into pre_audit_id
    from public.capability_registry_audit audit
   where audit.capability_key = target_capability_key
   order by audit.changed_at desc, audit.id desc
   limit 1;
  if pre_audit_id is null then
    raise exception 'no audit record found for %, cannot record a restorable kill', target_capability_key using errcode = '22023';
  end if;

  perform app_private.set_capability_registry_entry_unchecked(
    target_capability_key, cur.capacity_class, cur.description, true, cur.rollout_percentage, cur.min_tier,
    cur.kind, cur.limits, cur.beta, cur.marketing_visible, cur.marketing_label, cur.marketing_blurb
  );

  insert into public.capability_kill_events (
    capability_key, fired_by, reason, affected_channel_count, live_channel_count,
    pre_kill_audit_id, expires_at
  ) values (
    target_capability_key, actor, target_reason,
    coalesce(target_affected_channel_count, 0), coalesce(target_live_channel_count, 0),
    pre_audit_id, current_timestamp + interval '24 hours'
  ) returning capability_kill_events.id into new_event_id;

  return query select * from app_private.capability_kill_event_row(new_event_id);
end
$$;

revoke execute on function app_private.staff_fire_global_kill(text, text, integer, integer) from public;
grant execute on function app_private.staff_fire_global_kill(text, text, integer, integer) to bsa_app;

-- =====================================================================
-- JOB 2f: ratify. One additional, distinct admin, never the firer.
-- =====================================================================
create or replace function app_private.staff_ratify_kill_event(target_kill_event_id uuid)
returns table (
  id uuid, capability_key text, fired_by uuid, fired_at timestamptz, reason text,
  affected_channel_count integer, live_channel_count integer,
  expires_at timestamptz, ratified_by uuid, ratified_at timestamptz,
  escalated_to_owner boolean, reverted boolean,
  reviewed boolean, reviewed_by uuid, reviewed_at timestamptz, review_text text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  actor uuid;
  ev record;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  actor := app_private.current_user_id();

  select * into ev from public.capability_kill_events where capability_kill_events.id = target_kill_event_id;
  if not found then
    raise exception 'kill event not found' using errcode = '22023';
  end if;
  if ev.fired_by = actor then
    raise exception 'the admin who fired a kill may not also ratify it' using errcode = '42501';
  end if;

  insert into public.capability_kill_ratifications (kill_event_id, ratified_by)
  values (target_kill_event_id, actor);

  return query select * from app_private.capability_kill_event_row(target_kill_event_id);
end
$$;

revoke execute on function app_private.staff_ratify_kill_event(uuid) from public;
grant execute on function app_private.staff_ratify_kill_event(uuid) to bsa_app;

-- =====================================================================
-- JOB 2g: extension, propose half. Capped at requested_at + 24h by the
-- table's own CHECK constraint; must move the expiry forward.
-- =====================================================================
create or replace function app_private.staff_propose_kill_extension(
  target_kill_event_id uuid,
  target_new_expires_at timestamptz,
  target_reason text
)
returns table (id uuid, kill_event_id uuid, requested_by uuid, requested_at timestamptz, new_expires_at timestamptz, reason text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  actor uuid;
  cur_eff timestamptz;
  new_id uuid;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  if target_reason is null or length(trim(target_reason)) = 0 then
    raise exception 'a reason is required to propose a kill extension' using errcode = '22023';
  end if;
  actor := app_private.current_user_id();

  if not exists (select 1 from public.capability_kill_events where capability_kill_events.id = target_kill_event_id) then
    raise exception 'kill event not found' using errcode = '22023';
  end if;

  cur_eff := app_private.capability_kill_effective_expires_at(target_kill_event_id);
  if current_timestamp >= cur_eff then
    raise exception 'this kill event has already expired -- an extension only applies to a still-active kill' using errcode = '22023';
  end if;
  if target_new_expires_at <= cur_eff then
    raise exception 'an extension must move the expiry forward, got % which is not after the current effective expiry %', target_new_expires_at, cur_eff using errcode = '22023';
  end if;

  insert into public.capability_kill_extension_requests (kill_event_id, requested_by, new_expires_at, reason)
  values (target_kill_event_id, actor, target_new_expires_at, target_reason)
  returning capability_kill_extension_requests.id into new_id;

  return query
    select r.id, r.kill_event_id, r.requested_by, r.requested_at, r.new_expires_at, r.reason
      from public.capability_kill_extension_requests r where r.id = new_id;
end
$$;

revoke execute on function app_private.staff_propose_kill_extension(uuid, timestamptz, text) from public;
grant execute on function app_private.staff_propose_kill_extension(uuid, timestamptz, text) to bsa_app;

-- =====================================================================
-- JOB 2h: extension, approve half. A second, distinct admin (never the
-- proposer) finalises it -- maker-checker.
-- =====================================================================
create or replace function app_private.staff_approve_kill_extension(target_extension_request_id uuid)
returns table (
  id uuid, capability_key text, fired_by uuid, fired_at timestamptz, reason text,
  affected_channel_count integer, live_channel_count integer,
  expires_at timestamptz, ratified_by uuid, ratified_at timestamptz,
  escalated_to_owner boolean, reverted boolean,
  reviewed boolean, reviewed_by uuid, reviewed_at timestamptz, review_text text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  actor uuid;
  req record;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  actor := app_private.current_user_id();

  select * into req from public.capability_kill_extension_requests where capability_kill_extension_requests.id = target_extension_request_id;
  if not found then
    raise exception 'extension request not found' using errcode = '22023';
  end if;
  if req.requested_by = actor then
    raise exception 'the admin who proposed a kill extension may not also approve it' using errcode = '42501';
  end if;

  insert into public.capability_kill_extension_approvals (extension_request_id, approved_by)
  values (target_extension_request_id, actor);

  return query select * from app_private.capability_kill_event_row(req.kill_event_id);
end
$$;

revoke execute on function app_private.staff_approve_kill_extension(uuid) from public;
grant execute on function app_private.staff_approve_kill_extension(uuid) to bsa_app;

-- =====================================================================
-- JOB 2i: post-incident review. One per kill event.
-- =====================================================================
create or replace function app_private.staff_file_kill_review(
  target_kill_event_id uuid,
  target_review_text text
)
returns table (
  id uuid, capability_key text, fired_by uuid, fired_at timestamptz, reason text,
  affected_channel_count integer, live_channel_count integer,
  expires_at timestamptz, ratified_by uuid, ratified_at timestamptz,
  escalated_to_owner boolean, reverted boolean,
  reviewed boolean, reviewed_by uuid, reviewed_at timestamptz, review_text text
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
  if target_review_text is null or length(trim(target_review_text)) = 0 then
    raise exception 'a review is required' using errcode = '22023';
  end if;
  actor := app_private.current_user_id();

  if not exists (select 1 from public.capability_kill_events where capability_kill_events.id = target_kill_event_id) then
    raise exception 'kill event not found' using errcode = '22023';
  end if;

  insert into public.capability_kill_reviews (kill_event_id, reviewed_by, review_text)
  values (target_kill_event_id, actor, target_review_text);

  return query select * from app_private.capability_kill_event_row(target_kill_event_id);
end
$$;

revoke execute on function app_private.staff_file_kill_review(uuid, text) from public;
grant execute on function app_private.staff_file_kill_review(uuid, text) to bsa_app;

-- =====================================================================
-- JOB 2j: reads.
-- =====================================================================
create or replace function app_private.staff_get_kill_event(target_kill_event_id uuid)
returns table (
  id uuid, capability_key text, fired_by uuid, fired_at timestamptz, reason text,
  affected_channel_count integer, live_channel_count integer,
  expires_at timestamptz, ratified_by uuid, ratified_at timestamptz,
  escalated_to_owner boolean, reverted boolean,
  reviewed boolean, reviewed_by uuid, reviewed_at timestamptz, review_text text
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
  return query select * from app_private.capability_kill_event_row(target_kill_event_id);
end
$$;

revoke execute on function app_private.staff_get_kill_event(uuid) from public;
grant execute on function app_private.staff_get_kill_event(uuid) to bsa_app;

create or replace function app_private.staff_list_kill_events(target_capability_key text, target_limit integer)
returns table (
  id uuid, capability_key text, fired_by uuid, fired_at timestamptz, reason text,
  affected_channel_count integer, live_channel_count integer,
  expires_at timestamptz, ratified_by uuid, ratified_at timestamptz,
  escalated_to_owner boolean, reverted boolean,
  reviewed boolean, reviewed_by uuid, reviewed_at timestamptz, review_text text
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
    select ev.id from public.capability_kill_events ev
     where target_capability_key is null or ev.capability_key = target_capability_key
  loop
    perform app_private.apply_due_kill_revert(due.id);
  end loop;

  return query
    select row.*
      from public.capability_kill_events ev
      cross join lateral app_private.capability_kill_event_row(ev.id) row
     where target_capability_key is null or ev.capability_key = target_capability_key
     order by ev.fired_at desc, ev.id desc
     limit target_limit;
end
$$;

revoke execute on function app_private.staff_list_kill_events(text, integer) from public;
grant execute on function app_private.staff_list_kill_events(text, integer) to bsa_app;
