-- L16 security boundary proof: every check in this file runs AS THE REAL
-- APPLICATION ROLE (bsa_app), not as the postgres superuser every other file
-- in this suite verifies under. Superuser bypasses RLS and ignores grants
-- entirely, so a superuser-only test proves nothing about the boundary a real
-- API connection actually gets.
--
-- Own fixture ids: 00000000-...-000000001601 upward (see the allocation
-- registry in fixtures/00_base_world.sql). Reuses base_world's users
-- '...0001'/'...0002' and channels '...0011' (owner user 1) / '...0012'
-- (owner user 2), which are already two distinct creators/channels.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Fixture (run as postgres): two viewer accounts + a supporter relation on
-- each of the two base-world channels, so there is real cross-tenant data
-- for the role-scoped checks below to try (and fail) to cross.
-- ---------------------------------------------------------------------
select viewer_account_id, viewer_identity_id
  from app_private.create_viewer_account('00000000-0000-4000-8000-000000001601', 'l16-viewer-a@example.com', repeat('x', 32), 'L16 Viewer A')
\gset l16_viewer_a_

select viewer_account_id, viewer_identity_id
  from app_private.create_viewer_account('00000000-0000-4000-8000-000000001602', 'l16-viewer-b@example.com', repeat('y', 32), 'L16 Viewer B')
\gset l16_viewer_b_

insert into creator_supporter_relations (channel_id, viewer_identity_id, first_supported_at, last_supported_at, lifetime_amount_paise, tip_count, challenge_count, member_state)
values
  ('00000000-0000-4000-8000-000000000011', :'l16_viewer_a_viewer_identity_id', current_timestamp - interval '3 days', current_timestamp, 42000, 2, 0, 'active'),
  ('00000000-0000-4000-8000-000000000012', :'l16_viewer_b_viewer_identity_id', current_timestamp - interval '1 days', current_timestamp, 999999, 9, 0, 'none');

-- =======================================================================
-- CHECK 1: app role cannot read another channel's rows directly via RLS.
-- =======================================================================
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
do $$
begin
  if (select count(*) from channels where id = '00000000-0000-4000-8000-000000000011') <> 1 then
    raise exception 'CHECK1: bsa_app could not read its own channel — fixture or grant is broken, not a security pass';
  end if;
  if (select count(*) from channels where id = '00000000-0000-4000-8000-000000000012') <> 0 then
    raise exception 'CHECK1 DOES NOT HOLD: bsa_app read another channel''s row directly through RLS';
  end if;
end
$$;
commit;

-- =======================================================================
-- CHECK 2: app role cannot read viewer PII across viewers (0084/0085).
-- Two proofs: (a) no direct table grant exists at all — every access path
-- must be a security-definer function; (b) the security-definer dashboard
-- function itself refuses to return viewer B's row when called under
-- viewer A's session GUC, same shape as l14_viewer_identity.sql but now
-- under the actual role rather than superuser.
-- =======================================================================
begin;
set local role bsa_app;
do $$
begin
  begin
    perform 1 from viewer_accounts limit 1;
    raise exception 'CHECK2 DOES NOT HOLD: bsa_app has a direct table grant on viewer_accounts';
  exception
    when insufficient_privilege then null; -- expected: no grant at all
  end;
  begin
    perform 1 from viewer_identities limit 1;
    raise exception 'CHECK2 DOES NOT HOLD: bsa_app has a direct table grant on viewer_identities';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
select set_config('app.viewer_id', '00000000-0000-4000-8000-000000001601', true);
do $$
declare row_count int;
begin
  select count(*) into row_count from app_private.get_viewer_dashboard('00000000-0000-4000-8000-000000001601');
  if row_count <> 1 then raise exception 'CHECK2 setup broken: viewer A could not see her own dashboard row, saw %', row_count; end if;
  select count(*) into row_count from app_private.get_viewer_dashboard('00000000-0000-4000-8000-000000001602');
  if row_count <> 0 then
    raise exception 'CHECK2 DOES NOT HOLD: bsa_app read viewer B''s PII/dashboard by passing her account id under viewer A''s session';
  end if;
end
$$;
commit;

-- =======================================================================
-- CHECK 3: a creator cannot read another creator's supporter history,
-- proven AS bsa_app (mirrors l14_viewer_identity.sql:109's assertion, which
-- runs as postgres and therefore proves nothing about RLS/grants).
-- =======================================================================
begin;
set local role bsa_app;
do $$
begin
  begin
    perform 1 from creator_supporter_relations limit 1;
    raise exception 'CHECK3 DOES NOT HOLD: bsa_app has a direct table grant on creator_supporter_relations';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
do $$
declare row_count int; leaked_amount bigint;
begin
  select count(*) into row_count from app_private.get_channel_supporter_history('00000000-0000-4000-8000-000000000011');
  if row_count <> 1 then raise exception 'CHECK3 setup broken: creator one could not see their own channel''s supporter row, saw %', row_count; end if;

  select count(*) into row_count from app_private.get_channel_supporter_history('00000000-0000-4000-8000-000000000012');
  if row_count <> 0 then
    raise exception 'CHECK3 DOES NOT HOLD: creator one (bsa_app) read channel two''s supporter history';
  end if;

  select lifetime_amount_paise into leaked_amount from app_private.get_channel_supporter_history('00000000-0000-4000-8000-000000000011') limit 1;
  if leaked_amount <> 42000 or leaked_amount = 999999 then
    raise exception 'CHECK3 DOES NOT HOLD: cross-creator amount leaked into channel one''s supporter history under bsa_app';
  end if;
end
$$;
commit;

-- =======================================================================
-- CHECK 4: the 0082 device-pairing functions cannot be used by the app
-- role to mint a session (via approval) for a channel the caller does not
-- have a role on. Run entirely as bsa_app, including start/approve.
-- =======================================================================
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', true); -- owner of channel ...0012 ONLY
do $$
declare
  approved boolean;
  fp text := encode(sha256('l16-device-pairing-cross-channel'::bytea), 'hex');
  caught boolean := false;
begin
  perform app_private.start_companion_device_pairing(
    '00000000-0000-4000-8000-000000001611', 'SECBND24', fp, 'desktop', 'desktop-instance-l16-security', 'L16 Security Desktop',
    current_timestamp + interval '10 minutes'
  );

  begin
    select app_private.approve_companion_pairing(
      'SECBND24',
      '00000000-0000-4000-8000-000000000011', -- channel user 2 does NOT have a role on
      '00000000-0000-4000-8000-000000000002'
    ) into approved;
    -- no exception raised at all is itself a finding worth surfacing distinctly
    raise exception 'CHECK4 DOES NOT HOLD: approve_companion_pairing returned % with no exception for a channel the caller does not control', approved;
  exception
    when sqlstate '42501' then
      caught := true;
  end;

  if not caught then
    raise exception 'CHECK4 DOES NOT HOLD: expected access-denied (42501) was not raised';
  end if;

  -- Sanity: the pairing must still be unbound/pending, never silently
  -- approved onto the disallowed channel.
  if exists (
    select 1 from app_private.get_companion_pairing_request('SECBND24') where state <> 'pending'
  ) then
    raise exception 'CHECK4 DOES NOT HOLD: pairing state changed despite the denied approval';
  end if;
end
$$;
commit;

-- =======================================================================
-- CHECK 5: bsa_app has no BYPASSRLS and no unexpected table-level grants.
-- Run as postgres (role attributes and grants are catalog reads, not data).
-- =======================================================================
do $$
declare
  bypass boolean;
  is_super boolean;
  unexpected text;
begin
  select rolbypassrls, rolsuper into bypass, is_super from pg_roles where rolname = 'bsa_app';
  if bypass is distinct from false then
    raise exception 'CHECK5 DOES NOT HOLD: bsa_app has BYPASSRLS';
  end if;
  if is_super is distinct from false then
    raise exception 'CHECK5 DOES NOT HOLD: bsa_app is a superuser';
  end if;

  -- Tables that must have ZERO direct grants to bsa_app: every access path
  -- is a security-definer function (see 0084/0085/0082 file headers).
  if has_table_privilege('bsa_app', 'public.viewer_accounts', 'select')
     or has_table_privilege('bsa_app', 'public.anonymous_browser_identities', 'select')
     or has_table_privilege('bsa_app', 'public.viewer_platform_identities', 'select')
     or has_table_privilege('bsa_app', 'public.viewer_identities', 'select')
     or has_table_privilege('bsa_app', 'public.creator_supporter_relations', 'select')
     or has_table_privilege('bsa_app', 'public.companion_device_pairings', 'select') then
    raise exception 'CHECK5 DOES NOT HOLD: bsa_app has an unexpected direct grant on a security-definer-only table';
  end if;

  -- bsa_app must never hold DELETE anywhere it has been granted at all
  -- (this suite's app-role grants are select/insert/update only — see
  -- 0002/0003/0006 grant statements); a stray delete grant would let the
  -- app role destroy audit/financial rows outside its documented surface.
  select string_agg(table_name, ', ') into unexpected
    from information_schema.role_table_grants
   where grantee = 'bsa_app' and privilege_type = 'DELETE';
  if unexpected is not null then
    raise exception 'CHECK5 DOES NOT HOLD: bsa_app has an unexpected DELETE grant on: %', unexpected;
  end if;
end
$$;

select 'L16_SECURITY_BOUNDARY=PASS' as result;
