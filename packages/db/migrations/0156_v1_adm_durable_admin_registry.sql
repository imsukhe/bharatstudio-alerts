-- ADM-07: a durable admin registry, and ONE admin identity.
--
-- AUTHORITY. bharatstudio-requirements/active/tasks/ADM-07-durable-admin-
-- registry.md. Register row: "Admin OIDC + MFA, durable admin registry
-- (vs allowlist)".
--
-- MIGRATION NUMBER: 0156, pre-assigned. Fixture range
-- ...7000-...70ff, pre-assigned, own self-contained fixture (this
-- migration does not touch packages/db/tests/fixtures/00_base_world.sql,
-- same posture 0152/0153/0155 already took).
--
-- ============================================================
-- THE FINDING THIS CLOSES.
-- ============================================================
-- public.app_users.is_platform_admin (migration 0073) is already read by
-- every platform-staff function in 0149-0155 via app_private.
-- is_platform_admin() -- that boolean IS the durable registry on the
-- database side, and this migration does NOT replace it, restructure it,
-- or point it at a different table. What migration 0073 never built is a
-- WRITE path: bsa_app holds SELECT only on public.app_users (0003_v1_l03_
-- application.sql:494, same grant line 0155's header cites for
-- is_platform_owner), so until this migration is_platform_admin could
-- only ever be set by someone with raw production database access --
-- every SQL test fixture in this repo seeds it by direct INSERT because
-- there has never been any other way, in application code, to become the
-- second admin, let alone the first.
--
-- Separately, bharatstudio-admin (a different repository, Next.js
-- console) has never referenced app_users or is_platform_admin at all.
-- Its own authorisation decision is isPlatformAdminEmail(email) against
-- process.env.PLATFORM_ADMIN_EMAILS, entirely independent of this
-- database. A person can be a platform admin in one system and not the
-- other, silently, in either direction -- the two-identity problem this
-- task exists to close.
--
-- THE FIX, database side (this migration; the console side is a
-- separate, uncommitted change to bharatstudio-admin, reported
-- alongside this migration, not part of it): a governed, audited,
-- append-only write path for is_platform_admin --
-- app_private.staff_set_platform_admin -- built as the SAME shape
-- 0155 Job 1 already established for is_platform_owner: never
-- self-conferred, requires an existing admin to act, requires a
-- non-empty reason, every write captured in a new append-only
-- public.platform_admin_audit table. is_platform_admin() itself is NOT
-- touched -- its signature, body and semantics are byte-for-byte what
-- 0073 left them, so every one of the 0149-0155 functions that call it
-- keeps authorising exactly as before, unconditionally, without needing
-- to change a single line of any of those migrations. Proven in
-- packages/db/tests/adm_admin_registry.sql by granting admin through
-- the NEW function to a freshly-seeded non-admin user and then calling a
-- representative platform-admin-gated function from each of 0149, 0151,
-- 0152, 0153 and each of 0155's three jobs, then revoking and reproving
-- every one of those calls now fails with 42501.
--
-- THE BOOTSTRAP PROBLEM, NAMED RATHER THAN PAPERED OVER: app_private.
-- staff_set_platform_admin requires app_private.is_platform_admin() to
-- already be true for the caller (see its own self-conferral check
-- below) -- by construction, it can never create the FIRST admin, for
-- any actor, including one calling it against themselves when zero
-- admins currently exist. There is no "if the registry is empty, allow
-- it" branch anywhere in this migration, because that branch is exactly
-- the self-conferral hole 0155's own owner rule was written to close,
-- and a bootstrap exception would silently reopen it the moment the
-- registry were ever fully revoked (deliberately or by mistake). The
-- honest state of the world after this migration: the FIRST platform
-- admin is still, and can only ever be, set by direct database access
-- (a migration, a seed, or an operator with production DB credentials
-- running the same `update app_users set is_platform_admin = true where
-- id = ...` every fixture in this repo already runs) -- exactly the
-- access level required to run this migration file itself. That is not
-- a gap this migration introduces; it is the SAME bootstrap posture that
-- has existed since 0073 shipped with zero write path of any kind. What
-- this migration changes is everything AFTER the first admin: before
-- 0156, every subsequent admin ALSO required raw SQL, unaudited, with no
-- self-conferral check, no reason, no append-only trail; after 0156,
-- every admin from the second onward is granted through a governed,
-- audited, self-conferral-safe function, callable through the API layer
-- (JOB 2 in apps/api, see routes/platform-admin.ts).
--
-- ZERO-ADMIN LOCKOUT IS STRUCTURALLY IMPOSSIBLE THROUGH THIS FUNCTION,
-- NOT MERELY GUARDED: staff_set_platform_admin requires the CALLER to
-- already be an admin (is_platform_admin()), and rejects actor =
-- target_user_id (self-conferral, in either direction -- an admin can
-- no more revoke themselves through this path than grant themselves).
-- So on every call that reaches the actual write, the acting admin is,
-- by construction, an admin distinct from whatever row is being written
-- -- the registry can never legitimately lose its last member through
-- this function, with no separate "don't revoke the last admin" branch
-- needed or written. (A run of raw SQL with production DB credentials
-- can still zero the table, same as it can today for every other column
-- in this schema -- that is the same bootstrap-level access this
-- migration's own bootstrap note already names, not a hole in the
-- governed path.) Proven behaviourally in packages/db/tests/
-- adm_admin_registry.sql by attempting self-revocation and asserting it
-- is rejected the same way self-promotion is.
--
-- ============================================================
-- EXISTING GUARDS PRESERVED, UNCHANGED BY THIS MIGRATION.
-- ============================================================
-- app_private.is_platform_admin() (0073) -- untouched: same table
-- (public.app_users), same column (is_platform_admin), same body. Every
-- CTL-14/CTL-15/CTL-03 guard (0149), 0151's payment_decision/stored_
-- record_decision CHECK (= 'allow'), 0155's owner singleton index and
-- immutable-audit triggers, 0155's is_platform_owner()/is_platform_admin()
-- conjoint owner-approval rule -- none of these read or write anything
-- this migration adds; all continue to authorise exactly as before.
--
-- ROLLBACK: additive only, no production migration without separate
-- explicit approval.
--   drop function if exists app_private.staff_list_platform_admins();
--   drop function if exists app_private.staff_set_platform_admin(uuid, boolean, text);
--   drop table if exists public.platform_admin_audit;

-- =====================================================================
-- 1. Audit trail. Append-only via app_private.reject_table_mutation(),
--    the same generic trigger function 0155 installed for platform_
--    owner_audit and every capability_kill_* table -- not recreated
--    here, just reused (create or replace already ran in 0155).
-- =====================================================================
create table public.platform_admin_audit (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null references public.app_users(id),
  previous_value boolean not null,
  new_value boolean not null,
  changed_by uuid not null references public.app_users(id),
  changed_at timestamptz not null default current_timestamp,
  reason text not null check (char_length(trim(reason)) > 0)
);

comment on table public.platform_admin_audit is
  'ADM-07 (migration 0156): append-only record of every is_platform_admin change made through app_private.staff_set_platform_admin -- the ONLY function that can ever write public.app_users.is_platform_admin through the application layer (bsa_app holds SELECT only on app_users, 0003_v1_l03_application.sql:494). The first admin in any deployment predates this table -- it is set by direct database access before any application traffic exists to audit; see this migration''s own bootstrap note.';

create index platform_admin_audit_target_idx on public.platform_admin_audit (target_user_id, changed_at);

revoke all on public.platform_admin_audit from public;
revoke all on public.platform_admin_audit from bsa_app;

create trigger platform_admin_audit_append_only
  before update or delete on public.platform_admin_audit
  for each row execute function app_private.reject_table_mutation();

-- =====================================================================
-- 2. The ONLY application-layer write path for is_platform_admin.
--    Requires an existing admin to act (so it can never create the
--    first admin -- see bootstrap note above); never self-conferred in
--    either direction (actor <> target, same blanket rule 0155's
--    staff_set_platform_owner uses -- this is also what makes zero-admin
--    lockout through this function structurally impossible, see above);
--    a reason is mandatory; every write is captured in
--    platform_admin_audit in the SAME transaction.
-- =====================================================================
create or replace function app_private.staff_set_platform_admin(
  target_user_id uuid,
  target_is_admin boolean,
  target_reason text
)
returns table (user_id uuid, is_platform_admin boolean, changed_by uuid, changed_at timestamptz, reason text)
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
    raise exception 'platform admin status may not be self-conferred' using errcode = '42501';
  end if;
  if target_reason is null or length(trim(target_reason)) = 0 then
    raise exception 'a reason is required to change platform admin status' using errcode = '22023';
  end if;

  select au.is_platform_admin into prev_value from public.app_users au where au.id = target_user_id for update;
  if not found then
    raise exception 'user % does not exist', target_user_id using errcode = '22023';
  end if;

  v_new_value := coalesce(target_is_admin, false);

  update public.app_users set is_platform_admin = v_new_value, updated_at = current_timestamp
   where id = target_user_id;

  v_changed_at := current_timestamp;
  insert into public.platform_admin_audit (target_user_id, previous_value, new_value, changed_by, changed_at, reason)
  values (target_user_id, coalesce(prev_value, false), v_new_value, actor, v_changed_at, target_reason);

  user_id := target_user_id;
  is_platform_admin := v_new_value;
  changed_by := actor;
  changed_at := v_changed_at;
  reason := target_reason;
  return next;
end
$$;

revoke execute on function app_private.staff_set_platform_admin(uuid, boolean, text) from public;
grant execute on function app_private.staff_set_platform_admin(uuid, boolean, text) to bsa_app;

-- =====================================================================
-- 3. Read: the current registry. Representative read for this
--    migration's explain-plan artifact (packages/db/explain-plans/
--    admin-registry-list.explain.md) -- the same "one representative
--    capture stands for the whole migration's shared shape" posture
--    0152/0155 both already used, appropriate here since this migration
--    adds exactly one write function and one read function.
-- =====================================================================
create or replace function app_private.staff_list_platform_admins()
returns table (user_id uuid, display_name text, is_platform_admin boolean, is_platform_owner boolean, granted_by uuid, granted_at timestamptz, reason text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;

  return query
    select au.id, au.display_name, au.is_platform_admin, au.is_platform_owner,
           latest.changed_by, latest.changed_at, latest.reason
      from public.app_users au
      left join lateral (
        select paa.changed_by, paa.changed_at, paa.reason
          from public.platform_admin_audit paa
         where paa.target_user_id = au.id
         order by paa.changed_at desc, paa.id desc
         limit 1
      ) latest on true
     where au.is_platform_admin and au.closed_at is null
     order by au.id;
end
$$;

revoke execute on function app_private.staff_list_platform_admins() from public;
grant execute on function app_private.staff_list_platform_admins() to bsa_app;
