-- ADM-07: the one-time, audited admin bootstrap seed.
--
-- AUTHORITY. bharatstudio-requirements/reviews/2026-09-17-three-owner-
-- decisions-goa17-marketing-bootstrap.md §3 (binding, read-only to this
-- migration). Read together with 0156 (the durable admin registry --
-- app_private.staff_set_platform_admin, the governed write path this
-- migration does NOT touch or replace) and 0155 (the owner + append-
-- only audit pattern this migration reuses rather than re-derives).
--
-- MIGRATION NUMBER: 0159, pre-assigned. Fixture range
-- ...7300-...73ff, pre-assigned, own self-contained fixture (this
-- migration does not touch packages/db/tests/fixtures/00_base_world.sql,
-- same posture 0152/0153/0155/0156 already took). Two other migrations
-- (0160, 0161) were assigned concurrently to other agents; this file
-- makes no change to any migration file other than itself.
--
-- ============================================================
-- THE PROBLEM, ALREADY PROVEN -- not re-derived here.
-- ============================================================
-- app_private.staff_set_platform_admin (0156) requires the CALLER to
-- already be a platform admin, and has no empty-registry branch --
-- proven behaviourally in packages/db/tests/adm_admin_registry.sql's own
-- "BOOTSTRAP" section, which zeroes the registry and shows BOTH self-
-- targeting and third-party grants fail 42501 for every caller, with no
-- special-cased path. A fresh deployment therefore has no admin and no
-- reachable way to create one except direct database access. This
-- predates 0156; 0156 neither introduced it nor fixed it (see 0156's own
-- "THE BOOTSTRAP PROBLEM" note).
--
-- ============================================================
-- THE FIX: app_private.staff_bootstrap_platform_admin().
-- ============================================================
-- A single function, callable only with direct database access (see
-- "REACHABILITY" below -- deliberately NOT granted to bsa_app, so it is
-- NOT reachable through the API layer at all, by any caller, under any
-- circumstance). It is:
--
--   INERT WHENEVER ANY ADMIN EXISTS. The very first check, before
--   anything else runs, is "does any row in app_users already have
--   is_platform_admin = true". If so: no read of configuration, no
--   write, no audit row -- the function returns seeded=false,
--   reason_code='admin_already_present' and stops. This is what makes
--   it safe to invoke on every deploy, forever, without becoming a
--   second standing authorisation path: once the registry is non-empty,
--   this function can never again change anything, structurally, not by
--   policy.
--
--   IDENTITY SOURCE: a deployment-provided value, configured but unset
--   by default -- current_setting('app.bootstrap_admin_email', true),
--   the SAME custom-GUC convention this codebase already uses for
--   request-scoped identity (app.user_id, app.channel_id,
--   app.overlay_session_id -- 0002; app.viewer_id -- 0084), here used at
--   deployment scope instead of request scope (e.g. `alter database ...
--   set app.bootstrap_admin_email = '...'`, set by infra/ops BEFORE this
--   migration or this function runs, entirely outside application code).
--   current_setting(..., true) (missing_ok) returns NULL, not an empty
--   string and not a guessed default, when the deployment has not set
--   it -- "unset" is therefore a real, distinguishable state, not a
--   sentinel value this migration invents.
--
--   NOT A NEW IDENTITY CONCEPT. The configured value is matched against
--   public.app_users.email -- the SAME column the Google sign-in
--   exchange (apps/api/src/auth/google.ts, POST /v1/auth/google/
--   exchange) already populates via app_private.create_user_session
--   (0075), normalised the SAME way google.ts already normalises it
--   (payload.email.trim().toLowerCase()) before it is ever compared, and
--   ONLY when email_verified is true -- the same trust bar 0075's own
--   upsert logic uses ("an unverified claim never overwrites an already-
--   verified address"). No new column, no new table, no email format
--   invented here: app_users.email/email_verified already exist and are
--   already the console's own identity claim.
--
--   CANNOT BOOTSTRAP A USER WHO HAS NEVER SIGNED IN. If the configured
--   email does not match any existing, verified, non-closed app_users
--   row, the function is a no-op (reason_code='bootstrap_identity_not_
--   found') -- it does not create a user, does not invent an identity,
--   and does not defer the write to "whenever they next sign in" (no
--   trigger is installed on app_users for this). The deployment operator
--   is expected to have the intended first admin sign in once (creating
--   their app_users row the same way every other user is created) before
--   this function can do anything; re-running it (it is safe to re-run
--   indefinitely, see INERT above) is how that ordering is satisfied.
--
--   WRITES AN AUDIT ROW LIKE ANY OTHER GRANT -- not exempt from 0155's
--   append-only trigger. public.platform_admin_audit (0156) is NOT
--   altered by this migration (no new column): the row this function
--   inserts uses the SAME five audited fields staff_set_platform_admin
--   writes, and is rejected by the SAME platform_admin_audit_append_
--   only trigger (app_private.reject_table_mutation, installed by 0155,
--   reused unmodified by 0156, reused unmodified here) on any later
--   UPDATE or DELETE attempt.
--
--   DISTINGUISHABLE FROM AN ORDINARY GRANT, STRUCTURALLY, not merely by
--   convention: staff_set_platform_admin (0156) REJECTS actor = target
--   (self-conferral, in either direction) -- so changed_by can never
--   equal target_user_id on any row that function writes. This
--   function's bootstrap row is the ONE case where no other admin can
--   possibly exist to act as a distinct actor, so it records
--   changed_by = target_user_id by construction. "changed_by =
--   target_user_id" is therefore a bootstrap row's signature and is
--   UNFORGEABLE through the ordinary governed path -- a reader does not
--   need to trust a text convention to tell the two apart, though the
--   reason text also carries a fixed, literal marker
--   ('ADM-07 BOOTSTRAP SEED (migration 0159):') for a human scanning the
--   table directly.
--
-- ============================================================
-- WHY THIS IS NOT THE ALLOWLIST ADM-07 JUST DELETED.
-- ============================================================
-- PLATFORM_ADMIN_EMAILS (bharatstudio-admin, deleted per ADM-07) was a
-- STANDING AUTHORISATION DECISION consulted on every request -- being
-- in the list made every subsequent request from that identity an
-- admin request, indefinitely, independent of any database state. This
-- function performs ONE audited write, after which app_private.
-- is_platform_admin() -- unmodified, same column, same body, since 0073
-- -- is the ONLY authority, exactly as 0156 already established for
-- every OTHER admin grant. Once a single admin row exists, this
-- function is permanently inert (see INERT above): the configured GUC
-- is never consulted again, on any request, by anything. A break-glass
-- credential that stays valid while the registry is empty was
-- considered by the owner and DECLINED for precisely this reason (owner
-- decision record §3) -- this migration does not build one: there is no
-- code path, anywhere, that re-checks app.bootstrap_admin_email once an
-- admin exists, on a per-request or any other recurring basis.
--
-- ============================================================
-- REACHABILITY -- deliberately narrower than every other function in
-- 0149-0158.
-- ============================================================
-- Every staff_* function in 0149-0158 is granted EXECUTE to bsa_app,
-- because each is reached through the API layer, gated by app_private.
-- is_platform_admin() (or is_platform_owner()) at the top of its own
-- body. This function is different IN KIND, not degree: it is the one
-- function in this entire migration range that must run with NO caller
-- gate at all (there is no admin yet to gate against), so it is not
-- granted to bsa_app and is therefore NOT reachable through the API
-- layer, by any authenticated caller, under any circumstance -- only
-- through the same direct database access already required to apply
-- this migration file, exactly the bootstrap posture 0156's own header
-- names ("the FIRST platform admin is still, and can only ever be, set
-- by direct database access"). This migration does not add an API route,
-- a config endpoint, or any apps/api change of any kind: the owner
-- decision record's "whatever API/config surface is genuinely needed --
-- if none is needed, do not invent one" is satisfied by inventing none.
--
-- ============================================================
-- WHAT THIS MIGRATION DOES AT APPLY TIME.
-- ============================================================
-- The function is invoked once, at the bottom of this file, inside a DO
-- block that RAISEs a NOTICE naming the outcome (seeded, or the exact
-- reason it did not) -- visible in migration-apply logs on every
-- deployment, so "the system says so" is true at apply time, not only
-- when an operator later queries reason_code by hand. The function
-- itself remains callable afterwards (direct DB access only, per
-- REACHABILITY above) for as many redeploys as it takes for the
-- configured identity to exist and sign in once -- each call before
-- that point is an audited no-op (no audit row is written for a no-op;
-- only an actual grant is audited, matching every other governed
-- function in this codebase, which never audits a rejected or no-op
-- call, only a completed write).
--
-- ============================================================
-- EXISTING GUARDS PRESERVED, UNCHANGED BY THIS MIGRATION.
-- ============================================================
-- app_private.is_platform_admin() (0073) -- untouched: same table
-- (public.app_users), same column (is_platform_admin), same body. Every
-- CTL-14/CTL-15/CTL-03 guard (0149), 0151's payment_decision/stored_
-- record_decision CHECK (= 'allow'), 0155's owner singleton index and
-- immutable-audit triggers, 0156's no-self-conferral and one-identity
-- posture -- none of these read or write anything this migration adds;
-- all continue to authorise exactly as before. public.platform_admin_
-- audit (0156) is not altered (no new column, no new trigger -- the
-- existing platform_admin_audit_append_only trigger from 0155/0156
-- already covers every row this function inserts).
--
-- ROLLBACK: additive only, no production migration without separate
-- explicit approval.
--   drop function if exists app_private.staff_bootstrap_platform_admin();

-- =====================================================================
-- The one-time, audited admin bootstrap seed.
-- =====================================================================
create or replace function app_private.staff_bootstrap_platform_admin()
returns table (
  seeded boolean,
  user_id uuid,
  reason_code text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  v_admin_exists boolean;
  v_configured text;
  v_target_id uuid;
  v_target_admin boolean;
begin
  -- Serialise concurrent invocations (e.g. two deploys racing) so the
  -- "does any admin exist" check and the eventual write can never
  -- interleave across sessions. Held for the transaction only.
  perform pg_advisory_xact_lock(hashtext('adm07_bootstrap_platform_admin'));

  -- INERT WHENEVER ANY ADMIN EXISTS -- checked first, unconditionally,
  -- before configuration is even read.
  select exists (
    select 1 from public.app_users where is_platform_admin and closed_at is null
  ) into v_admin_exists;

  if v_admin_exists then
    seeded := false;
    user_id := null;
    reason_code := 'admin_already_present';
    return next;
    return;
  end if;

  -- UNSET MEANS NO ADMIN IS SEEDED, AND THE SYSTEM SAYS SO. NULL (via
  -- missing_ok), never a guessed default.
  v_configured := nullif(trim(current_setting('app.bootstrap_admin_email', true)), '');

  if v_configured is null then
    seeded := false;
    user_id := null;
    reason_code := 'bootstrap_identity_unset';
    return next;
    return;
  end if;

  -- Match against the SAME identity the console already authenticates
  -- with (public.app_users.email, populated by the Google exchange via
  -- create_user_session -- 0075), normalised the same way google.ts
  -- normalises it, and only when Google verified it.
  select id, is_platform_admin into v_target_id, v_target_admin
    from public.app_users
   where email = lower(trim(v_configured))
     and email_verified
     and closed_at is null
   for update;

  if v_target_id is null then
    seeded := false;
    user_id := null;
    reason_code := 'bootstrap_identity_not_found';
    return next;
    return;
  end if;

  update public.app_users
     set is_platform_admin = true, updated_at = current_timestamp
   where id = v_target_id;

  -- Audited like any other grant, via the SAME table and the SAME
  -- append-only trigger 0156 installed -- not exempt. changed_by =
  -- target_user_id is this row's structural bootstrap signature: the
  -- governed path (staff_set_platform_admin) can never produce it, since
  -- that function rejects actor = target unconditionally.
  insert into public.platform_admin_audit
    (target_user_id, previous_value, new_value, changed_by, changed_at, reason)
  values (
    v_target_id,
    coalesce(v_target_admin, false),
    true,
    v_target_id,
    current_timestamp,
    'ADM-07 BOOTSTRAP SEED (migration 0159): first platform admin, identity from app.bootstrap_admin_email, no prior admin existed in the registry.'
  );

  seeded := true;
  user_id := v_target_id;
  reason_code := 'seeded';
  return next;
end
$$;

comment on function app_private.staff_bootstrap_platform_admin() is
  'ADM-07 (migration 0159): the one-time, audited seed that creates the FIRST platform admin. Inert whenever any app_users row already has is_platform_admin=true (checked before configuration is even read) -- once a single admin exists, calling this again forever changes nothing. Identity comes from current_setting(''app.bootstrap_admin_email'', true) (a deployment-provided value, configured but unset by default) matched against public.app_users.email/email_verified, the SAME identity the Google sign-in exchange already populates -- never a hardcoded address. NOT granted to bsa_app: unreachable through the API layer, by any caller, under any circumstance -- only through the same direct database access already required to run this migration. Not a standing authorisation path: the configured value is read at most once per call and never again after an admin exists; app_private.is_platform_admin() (0073, unmodified) remains the only authority afterwards. See this migration''s own header for the full reasoning.';

revoke execute on function app_private.staff_bootstrap_platform_admin() from public;
revoke execute on function app_private.staff_bootstrap_platform_admin() from bsa_app;

-- =====================================================================
-- Run it once, now, as part of applying this migration -- "the system
-- says so" at apply time: visible in migration-apply logs on every
-- deployment, not only when an operator later queries reason_code by
-- hand. A no-op (unset config, or no matching signed-in user yet) is
-- exactly as safe to leave running here as a real seed, per INERT above.
-- =====================================================================
do $$
declare
  v_result record;
begin
  select * into v_result from app_private.staff_bootstrap_platform_admin();
  case v_result.reason_code
    when 'seeded' then
      raise notice 'ADM-07 bootstrap (migration 0159): seeded first platform admin, user_id=%', v_result.user_id;
    when 'admin_already_present' then
      raise notice 'ADM-07 bootstrap (migration 0159): inert -- a platform admin already exists, no configuration read, nothing changed';
    when 'bootstrap_identity_unset' then
      raise notice 'ADM-07 bootstrap (migration 0159): no admin seeded -- app.bootstrap_admin_email is not configured for this deployment';
    when 'bootstrap_identity_not_found' then
      raise notice 'ADM-07 bootstrap (migration 0159): no admin seeded -- app.bootstrap_admin_email is configured but no verified app_users row matches it yet';
    else
      raise notice 'ADM-07 bootstrap (migration 0159): unexpected reason_code=%', v_result.reason_code;
  end case;
end
$$;
