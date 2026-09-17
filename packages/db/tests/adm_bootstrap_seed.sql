-- Migration 0159 (ADM-07): the one-time, audited admin bootstrap seed.
-- See the migration's own header for the full problem/fix narrative --
-- this file proves the behavioural claims made there.
--
-- Fixture: own app_users block '...7300'-'...7304' (pre-assigned range
-- ...7300-...73ff). No channel/channel_membership fixture is needed --
-- app_private.staff_bootstrap_platform_admin() is gated by nothing but
-- the registry's own emptiness and app_users.email/email_verified,
-- platform-wide, never per-channel. 00_base_world.sql is not touched by
-- this file or by migration 0159.
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, email, email_verified, created_at, updated_at, is_platform_admin, is_platform_owner)
values
  -- The intended first admin: has signed in once (email/email_verified
  -- populated exactly as create_user_session's Google-exchange upsert
  -- would populate them -- 0075), holds no admin flag yet.
  ('00000000-0000-4000-8000-000000007300', 'google-adm07boot-target', 'ADM07 Bootstrap Target', 'adm07-bootstrap-target@example.com', true, current_timestamp, current_timestamp, false, false),
  -- An ordinary signed-in user, no special email, used for negative
  -- (non-admin-rejected) checks and left untouched by the seed.
  ('00000000-0000-4000-8000-000000007301', 'google-adm07boot-bystander', 'ADM07 Bootstrap Bystander', 'adm07-bootstrap-bystander@example.com', true, current_timestamp, current_timestamp, false, false),
  -- Second target, used only for the "distinguishable from an ordinary
  -- grant" comparison (granted via the governed path once 7300 is
  -- admin, never via the seed).
  ('00000000-0000-4000-8000-000000007303', 'google-adm07boot-ordinary-target', 'ADM07 Bootstrap Ordinary Target', 'adm07-bootstrap-ordinary-target@example.com', true, current_timestamp, current_timestamp, false, false),
  -- A decoy sharing the same *kind* of claim as 7300 but UNVERIFIED --
  -- proves the seed honours the same "verified only" trust bar 0075's
  -- own upsert logic uses, not merely that some row with that email
  -- exists.
  ('00000000-0000-4000-8000-000000007304', 'google-adm07boot-unverified', 'ADM07 Bootstrap Unverified', 'adm07-bootstrap-unverified@example.com', false, current_timestamp, current_timestamp, false, false)
on conflict (id) do nothing;

do $$
begin
  if (select count(*) from app_users where is_platform_admin and closed_at is null) <> 0 then
    raise exception 'ADM-07 bootstrap test setup: fixture must start with zero platform admins system-wide';
  end if;
end
$$;

-- =========================================================================
-- REACHABILITY: the seed is granted to NEITHER public NOR bsa_app --
-- unlike every other staff_* function in 0149-0158, it must be
-- unreachable through the API layer entirely, by any caller, under any
-- circumstance (see the migration's own REACHABILITY note).
-- =========================================================================
do $$
begin
  if has_function_privilege('public', 'app_private.staff_bootstrap_platform_admin()', 'execute') then
    raise exception 'ADM-07 BOOTSTRAP: execute on staff_bootstrap_platform_admin must be revoked from public';
  end if;
  if has_function_privilege('bsa_app', 'app_private.staff_bootstrap_platform_admin()', 'execute') then
    raise exception 'ADM-07 BOOTSTRAP: execute on staff_bootstrap_platform_admin must NOT be granted to bsa_app -- it must stay unreachable through the API layer';
  end if;
end
$$;

-- =========================================================================
-- UNSET CONFIG SEEDS NOTHING, AND THE SYSTEM SAYS SO. app.bootstrap_
-- admin_email has never been set in this session -- current_setting(...,
-- true) returns NULL, not a guessed default.
-- =========================================================================
do $$
declare v_result record;
begin
  select * into v_result from app_private.staff_bootstrap_platform_admin();
  if v_result.seeded is not false then
    raise exception 'ADM-07 BOOTSTRAP: unset config must not seed anything, got seeded=%', v_result.seeded;
  end if;
  if v_result.reason_code <> 'bootstrap_identity_unset' then
    raise exception 'ADM-07 BOOTSTRAP: unset config must report reason_code=bootstrap_identity_unset, got %', v_result.reason_code;
  end if;
  if v_result.user_id is not null then
    raise exception 'ADM-07 BOOTSTRAP: unset config must not name a user_id, got %', v_result.user_id;
  end if;
end
$$;
do $$
begin
  if (select count(*) from app_users where is_platform_admin and closed_at is null) <> 0 then
    raise exception 'ADM-07 BOOTSTRAP: unset-config call must leave the registry empty';
  end if;
  if exists (select 1 from platform_admin_audit) then
    raise exception 'ADM-07 BOOTSTRAP: unset-config call must not write any audit row';
  end if;
end
$$;

-- =========================================================================
-- CONFIGURED BUT NO MATCHING SIGNED-IN USER: seeds nothing, says so.
-- =========================================================================
select set_config('app.bootstrap_admin_email', 'nobody-has-ever-signed-in-with-this@example.com', false);
do $$
declare v_result record;
begin
  select * into v_result from app_private.staff_bootstrap_platform_admin();
  if v_result.seeded is not false or v_result.reason_code <> 'bootstrap_identity_not_found' then
    raise exception 'ADM-07 BOOTSTRAP: an unmatched configured email must report reason_code=bootstrap_identity_not_found, got seeded=%, reason_code=%', v_result.seeded, v_result.reason_code;
  end if;
end
$$;

-- =========================================================================
-- CONFIGURED, MATCHES A ROW, BUT UNVERIFIED: seeds nothing. Same trust
-- bar as 0075's own upsert logic -- an unverified claim never counts.
-- =========================================================================
select set_config('app.bootstrap_admin_email', 'adm07-bootstrap-unverified@example.com', false);
do $$
declare v_result record;
begin
  select * into v_result from app_private.staff_bootstrap_platform_admin();
  if v_result.seeded is not false or v_result.reason_code <> 'bootstrap_identity_not_found' then
    raise exception 'ADM-07 BOOTSTRAP: an unverified email match must not seed -- got seeded=%, reason_code=%', v_result.seeded, v_result.reason_code;
  end if;
end
$$;
do $$
begin
  if (select is_platform_admin from app_users where id = '00000000-0000-4000-8000-000000007304') is not false then
    raise exception 'ADM-07 BOOTSTRAP: the unverified decoy must never be granted admin';
  end if;
end
$$;

-- =========================================================================
-- THE REAL SEED: configured, verified, matches 7300, zero admins exist.
-- Deliberately mixed-case with surrounding whitespace, to prove the
-- match is normalised (trim + lower) exactly like google.ts's own
-- normalisation, not a byte-exact comparison against whatever an
-- operator happens to type.
-- =========================================================================
select set_config('app.bootstrap_admin_email', '  ADM07-Bootstrap-Target@Example.COM  ', false);
do $$
declare v_result record;
begin
  select * into v_result from app_private.staff_bootstrap_platform_admin();
  if v_result.seeded is not true then
    raise exception 'ADM-07 BOOTSTRAP: a configured, verified, matching, first-time seed must succeed, got seeded=%', v_result.seeded;
  end if;
  if v_result.user_id <> '00000000-0000-4000-8000-000000007300'::uuid then
    raise exception 'ADM-07 BOOTSTRAP: the seed must target 7300, got %', v_result.user_id;
  end if;
  if v_result.reason_code <> 'seeded' then
    raise exception 'ADM-07 BOOTSTRAP: reason_code must be seeded, got %', v_result.reason_code;
  end if;
end
$$;
do $$
begin
  if (select is_platform_admin from app_users where id = '00000000-0000-4000-8000-000000007300') is not true then
    raise exception 'ADM-07 BOOTSTRAP: 7300 must now be a platform admin';
  end if;
end
$$;

-- AUDIT ROW WRITTEN, LIKE ANY OTHER GRANT, AND DISTINGUISHABLE FROM ONE.
do $$
declare v_row record; v_count integer;
begin
  select count(*) into v_count from platform_admin_audit where target_user_id = '00000000-0000-4000-8000-000000007300';
  if v_count <> 1 then
    raise exception 'ADM-07 BOOTSTRAP: exactly one audit row expected for the bootstrap grant, got %', v_count;
  end if;

  select * into v_row from platform_admin_audit where target_user_id = '00000000-0000-4000-8000-000000007300';
  if v_row.previous_value is not false or v_row.new_value is not true then
    raise exception 'ADM-07 BOOTSTRAP: audit row must record previous=false, new=true';
  end if;
  -- STRUCTURAL bootstrap signature: changed_by = target_user_id. The
  -- governed path (staff_set_platform_admin) can never produce this --
  -- it rejects actor = target unconditionally -- so this alone tells a
  -- reader "this was the bootstrap", without relying on the reason text.
  if v_row.changed_by <> v_row.target_user_id then
    raise exception 'ADM-07 BOOTSTRAP: the bootstrap audit row must have changed_by = target_user_id (its unforgeable signature), got changed_by=%, target=%', v_row.changed_by, v_row.target_user_id;
  end if;
  if v_row.reason not like 'ADM-07 BOOTSTRAP SEED (migration 0159):%' then
    raise exception 'ADM-07 BOOTSTRAP: the audit reason must carry the fixed bootstrap marker for a human reading the table directly, got %', v_row.reason;
  end if;
end
$$;

-- APPEND-ONLY: the bootstrap row is rejected by the SAME trigger 0155/
-- 0156 installed -- not exempt.
do $$
declare v_id uuid;
begin
  select id into v_id from platform_admin_audit where target_user_id = '00000000-0000-4000-8000-000000007300';
  begin
    update platform_admin_audit set reason = 'tampered' where id = v_id;
    raise exception 'ADM-07 BOOTSTRAP: platform_admin_audit must remain append-only for a bootstrap row -- UPDATE must be rejected';
  exception when feature_not_supported then null;
  end;
  begin
    delete from platform_admin_audit where id = v_id;
    raise exception 'ADM-07 BOOTSTRAP: platform_admin_audit must remain append-only for a bootstrap row -- DELETE must be rejected';
  exception when feature_not_supported then null;
  end;
end
$$;

-- is_platform_admin() (0073, byte-for-byte unmodified) authorises the
-- freshly-seeded identity exactly as it would any other admin row.
select set_config('app.user_id', '00000000-0000-4000-8000-000000007300', false);
do $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'ADM-07 BOOTSTRAP: is_platform_admin() must return true for the freshly-seeded identity';
  end if;
end
$$;

-- =========================================================================
-- IDEMPOTENT + INERT ONCE AN ADMIN EXISTS: calling the seed again, with
-- the SAME configured identity still set, changes nothing and says so.
-- =========================================================================
do $$
declare v_result record; v_count_before integer; v_count_after integer;
begin
  select count(*) into v_count_before from platform_admin_audit;
  select * into v_result from app_private.staff_bootstrap_platform_admin();
  select count(*) into v_count_after from platform_admin_audit;

  if v_result.seeded is not false then
    raise exception 'ADM-07 BOOTSTRAP: re-running the seed with an admin present must not seed again, got seeded=%', v_result.seeded;
  end if;
  if v_result.reason_code <> 'admin_already_present' then
    raise exception 'ADM-07 BOOTSTRAP: re-running the seed with an admin present must report reason_code=admin_already_present, got %', v_result.reason_code;
  end if;
  if v_result.user_id is not null then
    raise exception 'ADM-07 BOOTSTRAP: re-running the seed with an admin present must not name a user_id, got %', v_result.user_id;
  end if;
  if v_count_after <> v_count_before then
    raise exception 'ADM-07 BOOTSTRAP: re-running the seed must not write a second audit row (before=%, after=%)', v_count_before, v_count_after;
  end if;
end
$$;
do $$
begin
  if (select is_platform_admin from app_users where id = '00000000-0000-4000-8000-000000007300') is not true then
    raise exception 'ADM-07 BOOTSTRAP: 7300 must remain a platform admin after the inert re-run';
  end if;
end
$$;

-- =========================================================================
-- NOT A STANDING AUTHORISATION PATH: even with app.bootstrap_admin_email
-- still pointed at 7300 (an existing admin) and a DIFFERENT, never-
-- signed-in-as-that-identity caller trying to lean on it, the seed
-- cannot be used to grant anyone ELSE admin either -- it is inert
-- outright the moment any admin exists, full stop, regardless of who
-- calls it or what is configured.
-- =========================================================================
select set_config('app.bootstrap_admin_email', 'adm07-bootstrap-ordinary-target@example.com', false);
do $$
declare v_result record;
begin
  select * into v_result from app_private.staff_bootstrap_platform_admin();
  if v_result.seeded is not false or v_result.reason_code <> 'admin_already_present' then
    raise exception 'ADM-07 BOOTSTRAP: with an admin already present, the seed must stay inert regardless of what app.bootstrap_admin_email now points at, got seeded=%, reason_code=%', v_result.seeded, v_result.reason_code;
  end if;
end
$$;
do $$
begin
  if (select is_platform_admin from app_users where id = '00000000-0000-4000-8000-000000007303') is not false then
    raise exception 'ADM-07 BOOTSTRAP: 7303 must not have been granted admin by the inert seed';
  end if;
end
$$;

-- =========================================================================
-- DISTINGUISHABLE FROM AN ORDINARY GRANT: 7300 (now admin) grants 7303
-- through the GOVERNED path (staff_set_platform_admin, 0156), unchanged
-- by this migration. Compare the two audit rows.
-- =========================================================================
select * from app_private.staff_set_platform_admin('00000000-0000-4000-8000-000000007303'::uuid, true, 'ordinary grant for bootstrap-vs-grant comparison');

do $$
declare v_bootstrap record; v_ordinary record;
begin
  select * into v_bootstrap from platform_admin_audit where target_user_id = '00000000-0000-4000-8000-000000007300';
  select * into v_ordinary from platform_admin_audit where target_user_id = '00000000-0000-4000-8000-000000007303';

  if v_bootstrap.changed_by <> v_bootstrap.target_user_id then
    raise exception 'ADM-07 BOOTSTRAP: bootstrap row must have changed_by = target_user_id';
  end if;
  if v_ordinary.changed_by = v_ordinary.target_user_id then
    raise exception 'ADM-07 BOOTSTRAP: an ordinary grant must never have changed_by = target_user_id -- that would collide with the bootstrap signature, and the governed path structurally forbids self-conferral';
  end if;
  if v_ordinary.changed_by <> '00000000-0000-4000-8000-000000007300'::uuid then
    raise exception 'ADM-07 BOOTSTRAP: the ordinary grant must be attributed to the acting admin (7300), got %', v_ordinary.changed_by;
  end if;
  if v_bootstrap.reason not like 'ADM-07 BOOTSTRAP SEED%' then
    raise exception 'ADM-07 BOOTSTRAP: the bootstrap row reason must carry the fixed marker';
  end if;
  if v_ordinary.reason like 'ADM-07 BOOTSTRAP SEED%' then
    raise exception 'ADM-07 BOOTSTRAP: an ordinary grant must never carry the bootstrap marker';
  end if;
end
$$;
select set_config('app.user_id', '00000000-0000-4000-8000-000000007300', false);

-- =========================================================================
-- 0149-0158 STILL AUTHORISE: the bootstrapped identity (7300) reaches a
-- representative platform-admin-gated function from several migrations
-- across the range, exactly as an ordinarily-granted admin would --
-- proving this migration changed nothing about how any of them
-- authorise. A never-admin bystander (7301) is rejected the same way it
-- always would be.
-- =========================================================================
-- 0149: a read.
select * from app_private.staff_list_capability_registry_audit(null);
-- 0151: a global (channel_id null) write gated on is_platform_admin().
select app_private.create_safety_corpus_term(null, 'adm07boot-representative-probe-term', true, 'block', 'block', 'hold');
-- 0153: a read.
select * from app_private.staff_list_capability_registry_entries();
-- 0155 Job 2: a read.
select * from app_private.staff_list_kill_events(null, 5);
-- 0156: a read, over the registry this migration's own function feeds.
select * from app_private.staff_list_platform_admins();

do $$
declare v_row record;
begin
  select * into v_row from app_private.staff_list_platform_admins() where user_id = '00000000-0000-4000-8000-000000007300';
  if not found then
    raise exception 'ADM-07 BOOTSTRAP: staff_list_platform_admins must include the bootstrapped admin';
  end if;
  if v_row.reason not like 'ADM-07 BOOTSTRAP SEED%' then
    raise exception 'ADM-07 BOOTSTRAP: staff_list_platform_admins must surface the bootstrap audit reason for 7300, got %', v_row.reason;
  end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000007301', false);
do $$
begin
  begin
    perform app_private.staff_list_capability_registry_audit(null);
    raise exception 'ADM-07 BOOTSTRAP/0149: a never-admin bystander must not authorise staff_list_capability_registry_audit';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app_private.staff_list_platform_admins();
    raise exception 'ADM-07 BOOTSTRAP/0156: a never-admin bystander must not authorise staff_list_platform_admins';
  exception when insufficient_privilege then null;
  end;
end
$$;

-- staff_bootstrap_platform_admin gates reachability at the GRANT level
-- (proven earlier via has_function_privilege), not via an in-function
-- caller check -- it deliberately has none, since it must work before
-- any admin exists. This whole suite runs as the postgres superuser,
-- which bypasses GRANTs entirely, so calling it here (as any app.user_id)
-- exercises its business logic, not its reachability; reachability from
-- the actual API layer (bsa_app) was already proven false above. Called
-- here once more, as the bystander, it is simply inert (an admin exists),
-- which is the same INERT behaviour already proven -- not re-asserted.
select set_config('app.user_id', '00000000-0000-4000-8000-000000007300', false);

select 'adm_bootstrap_seed.sql: OK' as result;
