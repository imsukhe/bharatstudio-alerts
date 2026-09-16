-- PRF-02 slice 5, §6 catalogue module #9 (Stream Mission Card):
-- migration 0135's table and its four app_private functions.
--
-- Covers: the 1-120 objective bound (reused from 0109 line 67, never a new
-- number), owner/admin-only writes, the "at most one running mission per
-- channel" guarantee, ending/restarting, the creator read at every tier
-- (§12.6 -- never tier-gate a durable creator record), the overlay read's
-- token-fingerprint/revocation/expiry gate, cross-channel isolation,
-- §12.7's "at most the current mission, never a history", and two
-- structural assertions that make the owner's SESSION-BOUNDED decision a
-- property the suite checks rather than a promise in a document:
--   * no duration/timer/expiry/deadline/ends_at column may ever exist on
--     public.stream_missions;
--   * list_overlay_stream_mission's OUT columns must be exactly
--     mission_id, objective, started_at -- so a widened projection is a
--     failing test, not a silent change.
--
-- Uses base_world channel '...0011' (owner user '...0001', admin '...0003',
-- operator '...0004', moderator '...0005', viewer '...0006') and '...0012'
-- (owner user '...0002', the cross-channel probe). Own fixture ids
-- ...2300 upward -- the next free block after prf02_slice2_tug_of_war_vote
-- .sql's ...2200-...2221 (see fixtures/00_base_world.sql's ID ALLOCATION
-- REGISTRY).
\set ON_ERROR_STOP on

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', 1, 'studio', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- =========================================================================
-- STRUCTURAL: no clock-bound column exists, and none may ever be added.
-- Owner decision (FULL-PRODUCT-DEFINITION.md §6, module table row 9,
-- 2026-09-16): the mission is SESSION-bounded, not CLOCK-bounded.
-- =========================================================================
do $$
declare offending text;
begin
  select string_agg(column_name, ', ') into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'stream_missions'
     and (column_name like '%duration%'
       or column_name like '%timer%'
       or column_name like '%expire%'
       or column_name like '%expiry%'
       or column_name like '%deadline%'
       or column_name = 'ends_at');
  if offending is not null then
    raise exception 'public.stream_missions must carry NO duration/timer/expiry/deadline column -- the mission is session-bounded, not clock-bounded. Found: %', offending;
  end if;
end
$$;

-- =========================================================================
-- STRUCTURAL: the overlay projection is exactly three columns (§12.7, and
-- no end-shaped field). Asserted against information_schema.parameters so
-- that widening the projection fails here instead of shipping silently.
-- =========================================================================
do $$
declare actual text;
begin
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private'
     and r.routine_name = 'list_overlay_stream_mission'
     and p.parameter_mode = 'OUT';
  if actual is distinct from 'mission_id,objective,started_at' then
    raise exception 'list_overlay_stream_mission must project exactly mission_id,objective,started_at (§12.7, no identity, no end-shaped field). Found: %', coalesce(actual, '<none>');
  end if;
end
$$;

-- =========================================================================
-- STRUCTURAL: RLS on, no direct table privilege to bsa_app, and every
-- function revoked from public and granted to bsa_app -- the same posture
-- 0109/0131 establish for a channel-owned table.
-- =========================================================================
do $$
declare rls boolean; direct_grants integer; fn record;
begin
  select relrowsecurity into rls from pg_class where oid = 'public.stream_missions'::regclass;
  if not rls then raise exception 'public.stream_missions must have row level security enabled'; end if;

  select count(*) into direct_grants
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'stream_missions' and grantee = 'bsa_app';
  if direct_grants <> 0 then
    raise exception 'bsa_app must hold NO direct privilege on public.stream_missions (all access is through security-definer functions); found % grant(s)', direct_grants;
  end if;

  for fn in
    select unnest(array[
      'app_private.start_stream_mission(uuid, text)',
      'app_private.end_stream_mission(uuid, uuid)',
      'app_private.list_channel_stream_mission(uuid)',
      'app_private.list_overlay_stream_mission(uuid, text)'
    ]) as sig
  loop
    if has_function_privilege('public', fn.sig, 'execute') then
      raise exception 'execute on % must be revoked from public', fn.sig;
    end if;
    if not has_function_privilege('bsa_app', fn.sig, 'execute') then
      raise exception 'execute on % must be granted to bsa_app', fn.sig;
    end if;
  end loop;
end
$$;

-- =========================================================================
-- AUTHORISATION: only owner/admin may start. operator, moderator, viewer
-- and a non-member are each rejected (42501).
-- =========================================================================
do $$
declare probe record; got text;
begin
  for probe in
    select unnest(array[
      '00000000-0000-4000-8000-000000000004',  -- operator
      '00000000-0000-4000-8000-000000000005',  -- moderator
      '00000000-0000-4000-8000-000000000006',  -- viewer
      '00000000-0000-4000-8000-000000000002'   -- non-member (channel 0012's owner)
    ]) as user_id
  loop
    perform set_config('app.user_id', probe.user_id, false);
    begin
      perform app_private.start_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, 'Should never be created');
      raise exception 'start_stream_mission must reject user % -- only owner/admin may start a mission', probe.user_id;
    exception when insufficient_privilege then
      null;  -- expected
    end;
  end loop;
end
$$;

do $$
declare row_count integer;
begin
  select count(*) into row_count from public.stream_missions;
  if row_count <> 0 then raise exception 'no mission should exist after the rejected attempts, found %', row_count; end if;
end
$$;

-- =========================================================================
-- OBJECTIVE BOUND: exactly 1-120, reusing 0109 line 67's decision.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

do $$
begin
  begin
    perform app_private.start_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, '');
    raise exception 'an empty objective must be rejected';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform app_private.start_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, repeat('a', 121));
    raise exception 'a 121-character objective must be rejected -- the bound is 1-120 (migration 0109 line 67, reused)';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform app_private.start_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, null);
    raise exception 'a null objective must be rejected';
  exception when invalid_parameter_value then null;
  end;
end
$$;

-- The 120-character boundary value is accepted.
do $$
declare v_id uuid;
begin
  v_id := app_private.start_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, repeat('a', 120));
  if v_id is null then raise exception 'a 120-character objective must be accepted'; end if;
  -- Clean up so the later cases start from a channel with no running mission.
  perform app_private.end_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, v_id);
end
$$;

-- =========================================================================
-- AT MOST ONE RUNNING MISSION PER CHANNEL, and ending then restarting.
-- =========================================================================
do $$
declare v_first uuid; v_second uuid;
begin
  v_first := app_private.start_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, 'Reach Diamond rank tonight');

  begin
    perform app_private.start_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, 'A second, conflicting mission');
    raise exception 'starting a second mission while one is running must raise -- never a silent supersede';
  exception when unique_violation then null;  -- expected
  end;

  -- The running mission is untouched by the rejected attempt.
  if (select objective from public.stream_missions where id = v_first) <> 'Reach Diamond rank tonight' then
    raise exception 'the running mission must be untouched by a rejected second start';
  end if;
  if (select ended_at from public.stream_missions where id = v_first) is not null then
    raise exception 'the running mission must NOT have been ended by a rejected second start';
  end if;

  -- End, then start again: allowed. The index constrains RUNNING missions
  -- only; ended missions stay durable (§12.6).
  perform app_private.end_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, v_first);
  v_second := app_private.start_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, 'Beat the boss with no deaths');
  if v_second is null then raise exception 'starting a mission after ending the previous one must succeed'; end if;

  -- Both rows survive: the ended one is durable history, not deleted.
  if (select count(*) from public.stream_missions where channel_id = '00000000-0000-4000-8000-000000000011') < 2 then
    raise exception 'an ended mission must remain a durable row (§12.6), never be deleted';
  end if;
end
$$;

-- =========================================================================
-- ENDING: idempotence is NOT silent success, and cross-channel/role
-- failures are the same indistinguishable not-found answer.
-- =========================================================================
do $$
declare v_running uuid;
begin
  select id into v_running from public.stream_missions
   where channel_id = '00000000-0000-4000-8000-000000000011' and ended_at is null;

  -- A viewer cannot end it, and gets the same not-found answer a stranger
  -- would -- never a distinguishable 'forbidden'.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);
  begin
    perform app_private.end_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, v_running);
    raise exception 'a viewer must not be able to end a mission';
  exception when no_data_found then null;
  end;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  if (select ended_at from public.stream_missions where id = v_running) is not null then
    raise exception 'the rejected viewer attempt must not have ended the mission';
  end if;

  -- Ending it properly works; ending it twice does not.
  perform app_private.end_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, v_running);
  begin
    perform app_private.end_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, v_running);
    raise exception 'ending an already-ended mission must raise not-found';
  exception when no_data_found then null;
  end;

  -- Ending a mission that belongs to another channel is not-found too.
  begin
    perform app_private.end_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, gen_random_uuid());
    raise exception 'ending an unknown mission id must raise not-found';
  exception when no_data_found then null;
  end;
end
$$;

-- =========================================================================
-- CREATOR READ: available at EVERY tier (§12.6 -- never tier-gate storing,
-- viewing or exporting a durable creator record). Channel 0011 is `free`.
-- Visible to every channel member; zero rows to a non-member.
-- =========================================================================
do $$
declare v_id uuid; probe record; row_count integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  v_id := app_private.start_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, 'Free-tier channel mission');

  for probe in
    select unnest(array[
      '00000000-0000-4000-8000-000000000001',  -- owner
      '00000000-0000-4000-8000-000000000003',  -- admin
      '00000000-0000-4000-8000-000000000004',  -- operator
      '00000000-0000-4000-8000-000000000005',  -- moderator
      '00000000-0000-4000-8000-000000000006'   -- viewer
    ]) as user_id
  loop
    perform set_config('app.user_id', probe.user_id, false);
    select count(*) into row_count from app_private.list_channel_stream_mission('00000000-0000-4000-8000-000000000011'::uuid);
    if row_count <> 1 then
      raise exception 'member % must see the channel''s current mission on a FREE tier channel (§12.6), got % row(s)', probe.user_id, row_count;
    end if;
  end loop;

  -- A non-member sees nothing.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  select count(*) into row_count from app_private.list_channel_stream_mission('00000000-0000-4000-8000-000000000011'::uuid);
  if row_count <> 0 then raise exception 'a non-member must see zero rows, got %', row_count; end if;
end
$$;

-- =========================================================================
-- OVERLAY READ: token-fingerprint gate, revocation, expiry, cross-channel
-- isolation, and §12.7's "at most the current mission, never a history".
-- =========================================================================
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values
  ('00000000-0000-4000-8000-000000002320', '00000000-0000-4000-8000-000000000011', 'prf02s5-overlay-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000002321', '00000000-0000-4000-8000-000000000012', 'prf02s5-other-channel-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000002322', '00000000-0000-4000-8000-000000000011', 'prf02s5-expired-fingerprint', current_timestamp - interval '1 minute', current_timestamp),
  ('00000000-0000-4000-8000-000000002323', '00000000-0000-4000-8000-000000000011', 'prf02s5-revoked-fingerprint', current_timestamp + interval '1 hour', current_timestamp);

update overlay_sessions set revoked_at = current_timestamp where id = '00000000-0000-4000-8000-000000002323';

do $$
declare v_objective text; row_count integer;
begin
  -- The happy path: the running mission, and exactly one row.
  select count(*) into row_count from app_private.list_overlay_stream_mission('00000000-0000-4000-8000-000000002320'::uuid, 'prf02s5-overlay-fingerprint');
  if row_count <> 1 then raise exception 'the overlay read must return exactly the one running mission, got % row(s)', row_count; end if;

  select objective into v_objective from app_private.list_overlay_stream_mission('00000000-0000-4000-8000-000000002320'::uuid, 'prf02s5-overlay-fingerprint');
  if v_objective <> 'Free-tier channel mission' then
    raise exception 'the overlay read must return the RUNNING mission, got %', v_objective;
  end if;

  -- §12.7: three ended missions exist on this channel by now; none of them
  -- is ever returned. "At most the current mission, never a history."
  if (select count(*) from public.stream_missions where channel_id = '00000000-0000-4000-8000-000000000011' and ended_at is not null) < 3 then
    raise exception 'this test expects at least three ended missions to exist by now, so that the "never a history" assertion above is meaningful';
  end if;

  -- A wrong fingerprint, an expired session and a revoked session each
  -- return zero rows.
  select count(*) into row_count from app_private.list_overlay_stream_mission('00000000-0000-4000-8000-000000002320'::uuid, 'wrong-fingerprint');
  if row_count <> 0 then raise exception 'a wrong token fingerprint must return zero rows, got %', row_count; end if;

  select count(*) into row_count from app_private.list_overlay_stream_mission('00000000-0000-4000-8000-000000002322'::uuid, 'prf02s5-expired-fingerprint');
  if row_count <> 0 then raise exception 'an expired overlay session must return zero rows, got %', row_count; end if;

  select count(*) into row_count from app_private.list_overlay_stream_mission('00000000-0000-4000-8000-000000002323'::uuid, 'prf02s5-revoked-fingerprint');
  if row_count <> 0 then raise exception 'a revoked overlay session must return zero rows, got %', row_count; end if;

  -- Cross-channel isolation: channel 0012's overlay never sees 0011's
  -- mission (0012 has none of its own).
  select count(*) into row_count from app_private.list_overlay_stream_mission('00000000-0000-4000-8000-000000002321'::uuid, 'prf02s5-other-channel-fingerprint');
  if row_count <> 0 then raise exception 'another channel''s overlay session must never see this channel''s mission, got % row(s)', row_count; end if;
end
$$;

-- Ending the running mission makes the overlay read return zero rows on
-- the very next call -- no timer fires, nothing expires on a number, the
-- card simply has nothing to show.
do $$
declare v_running uuid; row_count integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  select id into v_running from public.stream_missions
   where channel_id = '00000000-0000-4000-8000-000000000011' and ended_at is null;
  perform app_private.end_stream_mission('00000000-0000-4000-8000-000000000011'::uuid, v_running);

  select count(*) into row_count from app_private.list_overlay_stream_mission('00000000-0000-4000-8000-000000002320'::uuid, 'prf02s5-overlay-fingerprint');
  if row_count <> 0 then raise exception 'after the creator ends the mission, the overlay read must return zero rows, got %', row_count; end if;

  -- And the creator read agrees -- no current mission.
  select count(*) into row_count from app_private.list_channel_stream_mission('00000000-0000-4000-8000-000000000011'::uuid);
  if row_count <> 0 then raise exception 'after ending, the creator read must report no current mission, got % row(s)', row_count; end if;
end
$$;

-- A studio-tier channel behaves identically to the free-tier one: the tier
-- is never read by any of these functions (decision 4 -- one gate only,
-- and it is §30.3's render cap in 0131, not anything here).
do $$
declare v_id uuid; row_count integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  v_id := app_private.start_stream_mission('00000000-0000-4000-8000-000000000012'::uuid, 'Studio-tier channel mission');
  select count(*) into row_count from app_private.list_channel_stream_mission('00000000-0000-4000-8000-000000000012'::uuid);
  if row_count <> 1 then raise exception 'a studio-tier channel must read its current mission exactly as a free-tier one does, got % row(s)', row_count; end if;

  select count(*) into row_count from app_private.list_overlay_stream_mission('00000000-0000-4000-8000-000000002321'::uuid, 'prf02s5-other-channel-fingerprint');
  if row_count <> 1 then raise exception 'channel 0012''s own overlay session must now see channel 0012''s own mission, got % row(s)', row_count; end if;
end
$$;
