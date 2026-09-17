-- Migration 0156 (ADM-07): a durable admin registry, and ONE admin
-- identity. See the migration's own header for the full finding this
-- closes -- is_platform_admin (0073) already had every read path
-- (0149-0155 all call app_private.is_platform_admin() unconditionally)
-- but zero write path in the application layer; this migration adds the
-- governed, audited, self-conferral-safe write path
-- (app_private.staff_set_platform_admin) without touching is_platform_
-- admin() itself.
--
-- Fixture: own app_users block '...7000'-'...7005' (pre-assigned range
-- ...7000-...70ff). No channel/channel_membership fixture is needed --
-- every function this migration adds is gated by app_private.
-- is_platform_admin() alone, platform-wide, never per-channel.
-- 00_base_world.sql is not touched by this file or by migration 0156.
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at, is_platform_admin, is_platform_owner)
values
  -- Seeded directly, the same way every other fixture file in this repo
  -- seeds is_platform_admin -- there has never been, and this migration
  -- does not invent, any application-layer path that creates the FIRST
  -- admin. See the migration's own bootstrap note.
  ('00000000-0000-4000-8000-000000007000', 'google-adm07-admin-alpha', 'ADM07 Admin Alpha', current_timestamp, current_timestamp, true, false),
  ('00000000-0000-4000-8000-000000007001', 'google-adm07-admin-beta', 'ADM07 Admin Beta', current_timestamp, current_timestamp, true, false),
  ('00000000-0000-4000-8000-000000007002', 'google-adm07-non-admin-gamma', 'ADM07 Non Admin Gamma', current_timestamp, current_timestamp, false, false),
  ('00000000-0000-4000-8000-000000007003', 'google-adm07-non-admin-delta', 'ADM07 Non Admin Delta', current_timestamp, current_timestamp, false, false),
  -- A capability_key probe target -- 0149's registry fixture is not
  -- touched, this migration creates its own key.
  ('00000000-0000-4000-8000-000000007004', 'google-adm07-admin-epsilon', 'ADM07 Admin Epsilon', current_timestamp, current_timestamp, true, false)
on conflict (id) do nothing;

-- =========================================================================
-- GRANTS LOCKDOWN: platform_admin_audit revoked from public AND bsa_app;
-- staff_set_platform_admin / staff_list_platform_admins revoked from
-- public, granted to bsa_app.
-- =========================================================================
do $$
begin
  if has_table_privilege('public', 'public.platform_admin_audit', 'SELECT') then
    raise exception 'SELECT on platform_admin_audit must be revoked from public';
  end if;
  if has_table_privilege('bsa_app', 'public.platform_admin_audit', 'SELECT') then
    raise exception 'SELECT on platform_admin_audit must be revoked from bsa_app -- functions are the only reachable path';
  end if;
  if has_table_privilege('bsa_app', 'public.platform_admin_audit', 'INSERT') then
    raise exception 'INSERT on platform_admin_audit must be revoked from bsa_app';
  end if;
  if has_function_privilege('public', 'app_private.staff_set_platform_admin(uuid, boolean, text)', 'execute') then
    raise exception 'execute on staff_set_platform_admin must be revoked from public';
  end if;
  if not has_function_privilege('bsa_app', 'app_private.staff_set_platform_admin(uuid, boolean, text)', 'execute') then
    raise exception 'execute on staff_set_platform_admin must be granted to bsa_app';
  end if;
  if has_function_privilege('public', 'app_private.staff_list_platform_admins()', 'execute') then
    raise exception 'execute on staff_list_platform_admins must be revoked from public';
  end if;
  if not has_function_privilege('bsa_app', 'app_private.staff_list_platform_admins()', 'execute') then
    raise exception 'execute on staff_list_platform_admins must be granted to bsa_app';
  end if;
end
$$;

-- =========================================================================
-- APPEND-ONLY: platform_admin_audit rejects UPDATE and DELETE, for every
-- role, structurally -- same technique proven for platform_owner_audit
-- in 0155's own test, reused here over the new table.
-- =========================================================================
-- Uses 7003 as the target (not 7002) so this setup-and-teardown pair
-- does not pollute the audit-row-count assertions the "REAL GRANT"
-- section below makes specifically about 7002.
select set_config('app.user_id', '00000000-0000-4000-8000-000000007000', false);
select * from app_private.staff_set_platform_admin('00000000-0000-4000-8000-000000007003'::uuid, true, 'seed one audit row to attempt mutating');
do $$
declare v_id uuid;
begin
  select id into v_id from public.platform_admin_audit where target_user_id = '00000000-0000-4000-8000-000000007003' order by changed_at desc limit 1;
  begin
    update public.platform_admin_audit set reason = 'tampered' where id = v_id;
    raise exception 'platform_admin_audit must be append-only -- UPDATE must be rejected';
  exception when feature_not_supported then null;
  end;
  begin
    delete from public.platform_admin_audit where id = v_id;
    raise exception 'platform_admin_audit must be append-only -- DELETE must be rejected';
  exception when feature_not_supported then null;
  end;
end
$$;
-- Revoke it back off -- the grant above was test setup, not a fact this
-- file wants standing for the rest of the run (7003 is used below as
-- the non-admin caller in the NON-ADMIN REJECTED block, and must be
-- back to non-admin before that runs).
select * from app_private.staff_set_platform_admin('00000000-0000-4000-8000-000000007003'::uuid, false, 'undo audit-append-only test setup');

-- =========================================================================
-- NON-ADMIN REJECTED. 7003 has never been granted anything.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000007003', false);
do $$
begin
  begin
    perform app_private.staff_set_platform_admin('00000000-0000-4000-8000-000000007002'::uuid, true, 'attempted by non-admin');
    raise exception 'a non-admin must not be able to call staff_set_platform_admin';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app_private.staff_list_platform_admins();
    raise exception 'a non-admin must not be able to call staff_list_platform_admins';
  exception when insufficient_privilege then null;
  end;
end
$$;
select set_config('app.user_id', '00000000-0000-4000-8000-000000007000', false);

-- =========================================================================
-- SELF-CONFERRAL BLOCKED, BOTH DIRECTIONS. 7000 (an existing admin)
-- targeting itself, whether granting (a no-op grant, still self-
-- conferral) or revoking (would-be self-revocation) -- both rejected
-- identically. This is also the proof that zero-admin lockout is
-- structurally unreachable through this function: an admin can never
-- remove themselves, so the acting admin always remains a surviving,
-- distinct admin after any call that reaches the write.
-- =========================================================================
do $$
begin
  begin
    perform app_private.staff_set_platform_admin('00000000-0000-4000-8000-000000007000'::uuid, true, 'self reconfirmation attempt');
    raise exception 'ADM-07: platform admin status must never be self-conferred (grant direction)';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app_private.staff_set_platform_admin('00000000-0000-4000-8000-000000007000'::uuid, false, 'self revocation attempt');
    raise exception 'ADM-07: platform admin status must never be self-conferred (revoke direction)';
  exception when insufficient_privilege then null;
  end;
end
$$;

-- =========================================================================
-- REASON MANDATORY.
-- =========================================================================
do $$
begin
  begin
    perform app_private.staff_set_platform_admin('00000000-0000-4000-8000-000000007002'::uuid, true, '');
    raise exception 'ADM-07: an empty reason must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
  begin
    perform app_private.staff_set_platform_admin('00000000-0000-4000-8000-000000007002'::uuid, true, null);
    raise exception 'ADM-07: a null reason must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
end
$$;

-- =========================================================================
-- TARGET MUST EXIST.
-- =========================================================================
do $$
begin
  begin
    perform app_private.staff_set_platform_admin('00000000-0000-4000-8000-0000000070fe'::uuid, true, 'nonexistent target');
    raise exception 'ADM-07: a nonexistent target user must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
end
$$;

-- =========================================================================
-- REAL GRANT, AUDITED, AND ONE IDENTITY: granting 7002 through the new
-- function is exactly what makes 7002 authorise via app_private.
-- is_platform_admin() -- the SAME boolean every 0149-0155 function
-- already reads, completely unmodified by this migration.
-- =========================================================================
select * from app_private.staff_set_platform_admin('00000000-0000-4000-8000-000000007002'::uuid, true, 'granted for representative-function proof');

do $$
declare v_admin boolean; v_audit_count integer;
begin
  select is_platform_admin into v_admin from app_users where id = '00000000-0000-4000-8000-000000007002';
  if v_admin is not true then raise exception 'ADM-07: 7002 must now be a platform admin, got %', v_admin; end if;

  select count(*) into v_audit_count from public.platform_admin_audit
   where target_user_id = '00000000-0000-4000-8000-000000007002' and new_value is true;
  if v_audit_count <> 1 then raise exception 'ADM-07: exactly one audited promotion row expected for 7002, got %', v_audit_count; end if;

  perform 1 from public.platform_admin_audit
   where target_user_id = '00000000-0000-4000-8000-000000007002' and previous_value is false and new_value is true
     and changed_by = '00000000-0000-4000-8000-000000007000' and reason = 'granted for representative-function proof';
  if not found then raise exception 'ADM-07: the promotion audit row must record previous=false, new=true, changed_by=the acting admin, and the exact reason given'; end if;
end
$$;

-- staff_list_platform_admins reflects the current registry, including
-- the freshly-granted row, with its most recent audit metadata attached.
do $$
declare v_row record;
begin
  select * into v_row from app_private.staff_list_platform_admins() where user_id = '00000000-0000-4000-8000-000000007002';
  if not found then raise exception 'ADM-07: staff_list_platform_admins must include 7002 once granted'; end if;
  if v_row.reason <> 'granted for representative-function proof' then
    raise exception 'ADM-07: staff_list_platform_admins must surface the most recent audit reason, got %', v_row.reason;
  end if;
end
$$;

-- =========================================================================
-- "0149-0155 STILL AUTHORISE": 7002, holding no is_platform_admin=true
-- row until the grant just above, now successfully calls one
-- representative platform-admin-gated function from each migration that
-- has one (0149, 0151, 0152, 0153, and each of 0155's three jobs; 0150
-- and 0154 have no is_platform_admin-gated function to test -- both are
-- entirely channel-scoped). None of these functions, or is_platform_
-- admin() itself, were modified by migration 0156.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000007002', false);

-- 0149: a read.
select * from app_private.staff_list_capability_registry_audit(null);

-- 0151: a global (channel_id null) safety-corpus-term write, gated on
-- is_platform_admin() specifically (a channel-scoped call on the same
-- function instead uses has_channel_role, untouched either way).
select app_private.create_safety_corpus_term(null, 'adm07-representative-probe-term', true, 'block', 'block', 'hold');

-- 0152: a read.
select * from app_private.staff_list_capability_changes(null, 10);

-- 0153: a read.
select * from app_private.staff_list_capability_registry_entries();

-- 0155 Job 3: staff_set_capability_registry_entry, the NEW-capability
-- path (single-admin create remains legitimate; only an EXISTING key is
-- gated behind the two-person workflow, unrelated to this migration).
select * from app_private.staff_set_capability_registry_entry(
  'adm07_representative_probe', 'active_widget', 'ADM-07 representative-function probe capability', false, 100, 'free',
  'widget', '{}'::jsonb, false, false, null, null
);

-- 0155 Job 1: staff_set_platform_owner is itself is_platform_admin()-
-- gated (owner status is orthogonal to, but requires, admin). A no-op
-- demotion of a user who is not owner exercises the gate without
-- disturbing any singleton state.
select * from app_private.staff_set_platform_owner('00000000-0000-4000-8000-000000007004'::uuid, false, 'ADM-07 representative-function probe, no-op demotion');

-- 0155 Job 2: a read.
select * from app_private.staff_list_kill_events(null, 5);

select set_config('app.user_id', '00000000-0000-4000-8000-000000007000', false);

-- =========================================================================
-- REVOKE, THEN REPROVE EVERY ONE OF THOSE SAME CALLS NOW FAILS 42501.
-- =========================================================================
select * from app_private.staff_set_platform_admin('00000000-0000-4000-8000-000000007002'::uuid, false, 'revoking after representative-function proof');

do $$
declare v_admin boolean;
begin
  select is_platform_admin into v_admin from app_users where id = '00000000-0000-4000-8000-000000007002';
  if v_admin is not false then raise exception 'ADM-07: 7002 must no longer be a platform admin, got %', v_admin; end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000007002', false);
do $$
begin
  begin
    perform app_private.staff_list_capability_registry_audit(null);
    raise exception 'ADM-07/0149: revoked user must no longer authorise staff_list_capability_registry_audit';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app_private.create_safety_corpus_term(null, 'should-not-be-reachable', true, 'block', 'block', 'hold');
    raise exception 'ADM-07/0151: revoked user must no longer authorise create_safety_corpus_term';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app_private.staff_list_capability_changes(null, 10);
    raise exception 'ADM-07/0152: revoked user must no longer authorise staff_list_capability_changes';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app_private.staff_list_capability_registry_entries();
    raise exception 'ADM-07/0153: revoked user must no longer authorise staff_list_capability_registry_entries';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app_private.staff_set_capability_registry_entry(
      'adm07_should_not_be_created', 'active_widget', 'must not be reachable', false, 100, 'free', 'widget', '{}'::jsonb, false, false, null, null
    );
    raise exception 'ADM-07/0155-job3: revoked user must no longer authorise staff_set_capability_registry_entry';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app_private.staff_set_platform_owner('00000000-0000-4000-8000-000000007004'::uuid, false, 'must not be reachable');
    raise exception 'ADM-07/0155-job1: revoked user must no longer authorise staff_set_platform_owner';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app_private.staff_list_kill_events(null, 5);
    raise exception 'ADM-07/0155-job2: revoked user must no longer authorise staff_list_kill_events';
  exception when insufficient_privilege then null;
  end;
end
$$;
select set_config('app.user_id', '00000000-0000-4000-8000-000000007000', false);

-- =========================================================================
-- OWNER UNCHANGED: 0155's singleton index and owner+admin conjoint rule
-- are untouched by this migration -- a smoke check, not a re-proof (the
-- full proof lives in ctl_emergency_kill_and_owner.sql). Promote 7004 to
-- owner (it is already a platform admin), confirm the singleton index
-- still admits only one true row.
-- =========================================================================
select * from app_private.staff_set_platform_owner('00000000-0000-4000-8000-000000007004'::uuid, true, 'ADM-07 owner-unchanged smoke check');
do $$
begin
  begin
    update app_users set is_platform_owner = true where id = '00000000-0000-4000-8000-000000007000';
    raise exception 'ADM-07: app_users_platform_owner_singleton_idx must still reject a second is_platform_owner=true row after this migration';
  exception when unique_violation then null;
  end;
end
$$;
select * from app_private.staff_set_platform_owner('00000000-0000-4000-8000-000000007004'::uuid, false, 'ADM-07 owner-unchanged smoke check cleanup');

-- =========================================================================
-- BOOTSTRAP: with the registry at zero admins system-wide, NO caller --
-- including one targeting themselves -- can reach the write, because the
-- FIRST check in staff_set_platform_admin is the caller's OWN
-- is_platform_admin() status, which is false for everyone once the
-- registry is empty. There is no special-cased "empty registry" branch
-- anywhere in this function; this is the same 42501 every non-admin
-- caller already gets. (Direct SQL, run with the same production DB
-- credentials required to run this migration file itself, remains the
-- only way to seed the very first admin -- see the migration's own
-- bootstrap note.)
-- =========================================================================
update app_users set is_platform_admin = false
 where id in (
   '00000000-0000-4000-8000-000000007000',
   '00000000-0000-4000-8000-000000007001',
   '00000000-0000-4000-8000-000000007004'
 );
do $$
declare v_remaining integer;
begin
  select count(*) into v_remaining from app_users where is_platform_admin and closed_at is null;
  if v_remaining <> 0 then raise exception 'ADM-07 bootstrap test setup: expected zero admins system-wide, got %', v_remaining; end if;
end
$$;
select set_config('app.user_id', '00000000-0000-4000-8000-000000007003', false);
do $$
begin
  begin
    perform app_private.staff_set_platform_admin('00000000-0000-4000-8000-000000007003'::uuid, true, 'attempted self-bootstrap with an empty registry');
    raise exception 'ADM-07 BOOTSTRAP: an empty registry must not create any special-cased path to self-grant the first admin';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app_private.staff_set_platform_admin('00000000-0000-4000-8000-000000007002'::uuid, true, 'attempted bootstrap grant of someone else with an empty registry');
    raise exception 'ADM-07 BOOTSTRAP: an empty registry must not authorise a non-admin to grant ANYONE, including a third party';
  exception when insufficient_privilege then null;
  end;
end
$$;
-- Restore, via the same direct-SQL bootstrap path this section just
-- proved is the only one available at zero admins -- legitimate test
-- teardown, not a claim that application traffic can do this.
update app_users set is_platform_admin = true where id = '00000000-0000-4000-8000-000000007000';

select 'adm_admin_registry.sql: OK' as result;
