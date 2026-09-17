-- PRF-02 slice 6, §6 catalogue module #16 (Lobby Status) and the minimum
-- §16 Lobby schema behind it: app_private.events_pack_entitled,
-- open_lobby_session, update_lobby_session_counts, close_lobby_session,
-- list_channel_lobby_session and list_overlay_lobby_status (migration
-- 0140).
--
-- This file owns id block ...5800-...58ff (recorded in
-- fixtures/00_base_world.sql's ID ALLOCATION REGISTRY). It seeds its OWN
-- channels, memberships, entitlement versions and overlay sessions rather
-- than reusing base_world's ...0011/...0012, because the things under test
-- are COUNTS and TIERS, and an assertion another file can move is not an
-- assertion.
--
-- THE THREE CASES THAT MATTER MOST:
--
--   L16.18 -- THE RETURNED COLUMN SET. §6 #16 and §16 require the public
--   overlay to be "aggregate status only ... Never player identifiers,
--   never Discord names, never codes or passwords". That is enforced on
--   the DECLARED RESULT TYPE, exactly as 0136 (moderator status) and 0139
--   (reaction cloud) do, and asserted twice over: from the catalogue
--   (pg_get_function_result) and from a table materialised out of a real
--   call and read back through information_schema.columns. Adding ANY
--   column -- a room code, a password, a seat token, a player identifier,
--   an in-game name, a Discord name, a viewer id, an anonymous identity or
--   a session id -- turns this file red by name. That is the negative test
--   recorded in bharatstudio-requirements/reviews/
--   2026-09-16-prf-02-slice-6-lobby-status-decisions.md.
--
--   L16.15 -- NOTHING CAN GRANT THE EVENTS PACK. Owner decision 5 requires
--   the pack side to be a check with no grant path, so present behaviour
--   is exactly "included at Creator+". Asserted structurally: no
--   app_private function other than the check itself mentions the grant
--   key, and tier_entitlement_dimensions emits it for no tier -- so no
--   entitlement publisher and no admin override can write it.
--
--   L16.23 -- NO PER-VIEWER COLUMN EXISTS. Owner decision 4 forbids a
--   per-viewer row on the overlay path and anything that correlates one
--   visit to another. Asserted against the TABLE, not only the read: there
--   is no viewer column for a future read to start exposing.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Fixture.
--   Channel A (...5811) -- CREATOR tier, entitled. The channel under test.
--   Channel B (...5812) -- CREATOR tier, entitled. The cross-channel probe.
--   Channel C (...5813) -- PRO tier, NOT entitled. The §30.3 probe.
--   Channel D (...5814) -- FREE tier, NOT entitled.
-- Users ...0001 (owner of A, C, D), ...0002 (owner of B) and the
-- non-owner/admin probes ...0004/...0005/...0006 come from base_world.
-- ---------------------------------------------------------------------
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005811', '00000000-0000-4000-8000-000000000001', 'lobby_a', 'Lobby A', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005812', '00000000-0000-4000-8000-000000000002', 'lobby_b', 'Lobby B', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005813', '00000000-0000-4000-8000-000000000001', 'lobby_c', 'Lobby C', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005814', '00000000-0000-4000-8000-000000000001', 'lobby_d', 'Lobby D', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000005811', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005811', '00000000-0000-4000-8000-000000000003', 'admin', current_timestamp),
  ('00000000-0000-4000-8000-000000005811', '00000000-0000-4000-8000-000000000004', 'operator', current_timestamp),
  ('00000000-0000-4000-8000-000000005811', '00000000-0000-4000-8000-000000000005', 'moderator', current_timestamp),
  ('00000000-0000-4000-8000-000000005811', '00000000-0000-4000-8000-000000000006', 'viewer', current_timestamp),
  ('00000000-0000-4000-8000-000000005812', '00000000-0000-4000-8000-000000000002', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005813', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005814', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

-- The tier ladder this slice's entitlement reads. The `values` payloads are
-- deliberately EMPTY objects: the pack key must be absent everywhere, which
-- is exactly the state every real publisher produces.
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000005811', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005812', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005813', 1, 'pro', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005814', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- Five overlay sessions: a good one for A, a good one for B, an expired one
-- for A, a revoked one for A, and a perfectly good one for the UNENTITLED
-- channel C. The last one is L16.20 and is the whole point of having C.
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values
  ('00000000-0000-4000-8000-000000005841', '00000000-0000-4000-8000-000000005811', 'prf02s6-lobby-a-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005842', '00000000-0000-4000-8000-000000005812', 'prf02s6-lobby-b-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005843', '00000000-0000-4000-8000-000000005811', 'prf02s6-lobby-expired-fingerprint', current_timestamp - interval '1 minute', current_timestamp - interval '2 hours'),
  ('00000000-0000-4000-8000-000000005845', '00000000-0000-4000-8000-000000005813', 'prf02s6-lobby-c-fingerprint', current_timestamp + interval '1 hour', current_timestamp);

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at, revoked_at)
values
  ('00000000-0000-4000-8000-000000005844', '00000000-0000-4000-8000-000000005811', 'prf02s6-lobby-revoked-fingerprint', current_timestamp + interval '1 hour', current_timestamp, current_timestamp);

-- =====================================================================
-- L16.12 / L16.13 -- THE ENTITLEMENT IS `tier in ('creator','studio')`,
-- AND NOTHING CAN CURRENTLY MAKE THE PACK SIDE TRUE, SO TODAY'S BEHAVIOUR
-- IS EXACTLY "INCLUDED AT CREATOR+".
-- =====================================================================
do $$
declare entitled boolean;
begin
  select app_private.events_pack_entitled('00000000-0000-4000-8000-000000005811') into entitled;
  if entitled is not true then raise exception 'a creator-tier channel must be entitled, got %', entitled; end if;

  select app_private.events_pack_entitled('00000000-0000-4000-8000-000000005813') into entitled;
  if entitled is not false then raise exception 'a PRO channel must NOT be entitled today -- nothing can grant the pack; got %', entitled; end if;

  select app_private.events_pack_entitled('00000000-0000-4000-8000-000000005814') into entitled;
  if entitled is not false then raise exception 'a FREE channel must NOT be entitled, got %', entitled; end if;
end
$$;

-- Studio is entitled too. Asserted by moving channel D up the ladder with a
-- new entitlement VERSION -- the same way every real re-tier happens -- and
-- then putting it back, so no later assertion in this file is disturbed.
do $$
declare entitled boolean;
begin
  insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
  values ('00000000-0000-4000-8000-000000005814', 2, 'studio', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp);

  select app_private.events_pack_entitled('00000000-0000-4000-8000-000000005814') into entitled;
  if entitled is not true then raise exception 'a studio-tier channel must be entitled, got %', entitled; end if;

  insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
  values ('00000000-0000-4000-8000-000000005814', 3, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp);

  select app_private.events_pack_entitled('00000000-0000-4000-8000-000000005814') into entitled;
  if entitled is not false then raise exception 'channel D must be back to unentitled, got %', entitled; end if;
end
$$;

-- =====================================================================
-- L16.14 -- THE PACK BRANCH EXISTS IN THE SHIPPED DEFINITION. The
-- MECHANISM is built; only the value is absent. That is the
-- configured-but-unset discipline applied to an entitlement, and it is
-- asserted against pg_get_functiondef rather than against a comment.
-- =====================================================================
do $$
declare definition text;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'events_pack_entitled';

  if definition is null then raise exception 'app_private.events_pack_entitled does not exist'; end if;
  if position('eventsPack' in definition) = 0 then
    raise exception 'the Events Pack branch must be BUILT (owner decision 5) -- the mechanism exists even though nothing can grant it';
  end if;
  if position($q$in ('creator', 'studio')$q$ in definition) = 0 then
    raise exception 'the tier branch must be exactly §30.3''s creator+ set';
  end if;
end
$$;

-- =====================================================================
-- L16.15 -- NOTHING CAN MAKE THE PACK BRANCH TRUE, AND THIS IS THE ONE
-- ASSERTION THAT PROVES IT.
--
-- channel_entitlement_versions.values is never caller-supplied: every
-- writer builds it server-side from tier_entitlement_dimensions (plus, for
-- 0074's admin override, exactly queueCount and adminOverrideReason). So
-- if (a) no app_private function OTHER than the check itself so much as
-- mentions the grant key, and (b) tier_entitlement_dimensions emits it for
-- no tier, then no publisher, no admin and no API caller can produce one.
-- =====================================================================
-- The scan is written as an explicit loop rather than a single query with
-- pg_get_functiondef in the WHERE clause, and that is not a style choice:
-- the planner is free to evaluate a WHERE-clause function call before the
-- namespace qual, and pg_get_functiondef RAISES on an aggregate
-- ("array_agg" is an aggregate function). Filtering first, then calling it
-- in the loop body, makes the evaluation order deterministic. prokind 'f'
-- keeps aggregates and window functions out regardless.
do $$
declare candidate record; offenders text[] := array[]::text[];
begin
  for candidate in
    select p.oid as fn_oid, p.proname as fn_name
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private'
       and p.prokind = 'f'
       and p.proname <> 'events_pack_entitled'
     order by p.proname
  loop
    if position('eventsPack' in pg_catalog.pg_get_functiondef(candidate.fn_oid)) > 0 then
      offenders := offenders || candidate.fn_name;
    end if;
  end loop;

  if array_length(offenders, 1) is not null then
    raise exception 'nothing may be able to GRANT the Events Pack yet (owner decision 5): these app_private functions mention the grant key: %', array_to_string(offenders, ', ');
  end if;
end
$$;

do $$
declare tier_name text; dimensions jsonb;
begin
  foreach tier_name in array array['free', 'pro', 'creator', 'studio']
  loop
    select app_private.tier_entitlement_dimensions(tier_name) into dimensions;
    if dimensions ? 'eventsPack' then
      raise exception 'tier_entitlement_dimensions(%) emits an eventsPack key -- the entitlement publishers would then be a grant path', tier_name;
    end if;
  end loop;
end
$$;

-- =====================================================================
-- L16.16 -- NO PRICE, NO BILLING, NO PURCHASE PATH. §33's Rs 129/mo stays
-- in the authority; this work charges nothing. Asserted against the
-- migration's own shipped functions.
-- =====================================================================
do $$
declare definition text; forbidden text; fn text;
begin
  foreach fn in array array['events_pack_entitled', 'open_lobby_session', 'update_lobby_session_counts',
                            'close_lobby_session', 'list_channel_lobby_session', 'list_overlay_lobby_status']
  loop
    select pg_catalog.pg_get_functiondef(p.oid)
      into definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname = fn;
    if definition is null then raise exception 'app_private.% does not exist', fn; end if;

    foreach forbidden in array array['paise', 'amount', 'currency', 'price', 'invoice', 'subscription', 'razorpay', 'billing', 'payment']
    loop
      if position(forbidden in definition) > 0 then
        raise exception 'app_private.% contains a "%" token -- this slice implements no price, no billing and no purchase path', fn, forbidden;
      end if;
    end loop;
  end loop;
end
$$;

-- =====================================================================
-- L16.2 -- ONLY AN OWNER OR ADMIN MAY OPEN A LOBBY. Operator, moderator
-- and viewer are all members of channel A and all must be refused.
-- =====================================================================
do $$
declare probe record; opened bigint;
begin
  for probe in select unnest(array[
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000006',
      '00000000-0000-4000-8000-000000000002'
    ]) as user_id
  loop
    perform set_config('app.user_id', probe.user_id, false);
    begin
      perform app_private.open_lobby_session('00000000-0000-4000-8000-000000005811'::uuid, 16);
      raise exception 'open_lobby_session must reject user % -- only owner/admin may open a lobby', probe.user_id;
    exception when insufficient_privilege then null;
    end;
  end loop;

  select count(*) into opened from public.lobby_sessions;
  if opened <> 0 then raise exception 'a refused open must insert nothing; found % row(s)', opened; end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

-- =====================================================================
-- L16.4 -- A SEAT COUNT BELOW 1 IS REFUSED. Arithmetic, not policy: a
-- lobby with no seats cannot render a seat status. There is deliberately
-- no UPPER bound anywhere -- §16 names no maximum seat count.
-- =====================================================================
do $$
declare opened bigint;
begin
  begin
    perform app_private.open_lobby_session('00000000-0000-4000-8000-000000005811'::uuid, 0);
    raise exception 'a zero seat count must be refused';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform app_private.open_lobby_session('00000000-0000-4000-8000-000000005811'::uuid, -5);
    raise exception 'a negative seat count must be refused';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform app_private.open_lobby_session('00000000-0000-4000-8000-000000005811'::uuid, null);
    raise exception 'a null seat count must be refused';
  exception when invalid_parameter_value then null;
  end;

  select count(*) into opened from public.lobby_sessions;
  if opened <> 0 then raise exception 'a refused open must insert nothing; found % row(s)', opened; end if;
end
$$;

-- =====================================================================
-- L16.1 / L16.3 -- AN OWNER OPENS A LOBBY; A SECOND ONE IS A CONFLICT,
-- NEVER A SILENT SUPERSEDE OF THE ONE ALREADY RUNNING.
-- =====================================================================
do $$
declare first_id uuid; row_shape text; opened bigint;
begin
  first_id := app_private.open_lobby_session('00000000-0000-4000-8000-000000005811'::uuid, 16);
  if first_id is null then raise exception 'open_lobby_session must return the new lobby id'; end if;

  select seat_count || '/' || confirmed_seat_count || '/' || queue_count
    into row_shape from public.lobby_sessions where id = first_id;
  if row_shape <> '16/0/0' then
    raise exception 'a newly opened lobby must start at 16 seats with nothing confirmed and an empty queue, got %', row_shape;
  end if;

  begin
    perform app_private.open_lobby_session('00000000-0000-4000-8000-000000005811'::uuid, 8);
    raise exception 'a second open lobby on one channel must be refused';
  exception when unique_violation then null;
  end;

  select count(*) into opened from public.lobby_sessions where channel_id = '00000000-0000-4000-8000-000000005811';
  if opened <> 1 then raise exception 'the refused second open must not have superseded the first; found % row(s)', opened; end if;
end
$$;

-- The partial unique index is the HARD guarantee, not the explicit raise
-- above. Proven by going around the function entirely.
do $$
begin
  begin
    insert into public.lobby_sessions (id, channel_id, created_by_user_id, seat_count)
    values (gen_random_uuid(), '00000000-0000-4000-8000-000000005811', '00000000-0000-4000-8000-000000000001', 4);
    raise exception 'a second OPEN lobby must violate lobby_sessions_channel_open_idx even on a direct insert';
  exception when unique_violation then null;
  end;
end
$$;

-- =====================================================================
-- L16.6 / L16.7 -- THE COUNT BOUNDS. A lobby cannot confirm more seats
-- than it has (the arithmetic of "8/16"), and a count cannot be negative.
-- =====================================================================
do $$
declare lobby uuid; shape text;
begin
  select id into lobby from public.lobby_sessions where channel_id = '00000000-0000-4000-8000-000000005811' and closed_at is null;

  begin
    perform app_private.update_lobby_session_counts('00000000-0000-4000-8000-000000005811'::uuid, lobby, 17, 0);
    raise exception 'confirming more seats than the lobby has must be refused';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform app_private.update_lobby_session_counts('00000000-0000-4000-8000-000000005811'::uuid, lobby, -1, 0);
    raise exception 'a negative confirmed-seat count must be refused';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform app_private.update_lobby_session_counts('00000000-0000-4000-8000-000000005811'::uuid, lobby, 0, -1);
    raise exception 'a negative queue count must be refused';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform app_private.update_lobby_session_counts('00000000-0000-4000-8000-000000005811'::uuid, lobby, null, null);
    raise exception 'null counts must be refused';
  exception when invalid_parameter_value then null;
  end;

  select confirmed_seat_count || '/' || queue_count into shape from public.lobby_sessions where id = lobby;
  if shape <> '0/0' then raise exception 'a refused update must change nothing; counts are now %', shape; end if;
end
$$;

-- The check constraint is the HARD guarantee for the seat bound too.
do $$
declare lobby uuid;
begin
  select id into lobby from public.lobby_sessions where channel_id = '00000000-0000-4000-8000-000000005811' and closed_at is null;
  begin
    update public.lobby_sessions set confirmed_seat_count = 99 where id = lobby;
    raise exception 'confirming more seats than exist must violate lobby_sessions_confirmed_within_seats even on a direct update';
  exception when check_violation then null;
  end;
end
$$;

-- =====================================================================
-- L16.5 -- THE CREATOR REPORTS THE NUMBERS, AND BOTH ARE WRITTEN
-- TOGETHER -- they are read together on one card, so a partial write would
-- paint a seat figure from one moment beside a queue figure from another.
-- =====================================================================
do $$
declare lobby uuid; shape text;
begin
  select id into lobby from public.lobby_sessions where channel_id = '00000000-0000-4000-8000-000000005811' and closed_at is null;
  perform app_private.update_lobby_session_counts('00000000-0000-4000-8000-000000005811'::uuid, lobby, 8, 12);

  select seat_count || '/' || confirmed_seat_count || '/' || queue_count into shape from public.lobby_sessions where id = lobby;
  if shape <> '16/8/12' then raise exception 'expected 16/8/12 after the creator reported the counts, got %', shape; end if;
end
$$;

-- =====================================================================
-- L16.8 -- A NON-OWNER/ADMIN CANNOT UPDATE THE COUNTS, AND IS TOLD
-- "NOT FOUND" RATHER THAN "NOT ALLOWED" -- the same non-leaking mapping
-- 0135 uses.
-- =====================================================================
do $$
declare lobby uuid; shape text;
begin
  select id into lobby from public.lobby_sessions where channel_id = '00000000-0000-4000-8000-000000005811' and closed_at is null;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
  begin
    perform app_private.update_lobby_session_counts('00000000-0000-4000-8000-000000005811'::uuid, lobby, 1, 1);
    raise exception 'a moderator must not be able to write the lobby counts';
  exception when no_data_found then null;
  end;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

  select confirmed_seat_count || '/' || queue_count into shape from public.lobby_sessions where id = lobby;
  if shape <> '8/12' then raise exception 'the refused write must have changed nothing; counts are now %', shape; end if;
end
$$;

-- =====================================================================
-- L16.17 -- THE OVERLAY READ: ONE ROW, THREE INTEGERS, FOR AN ENTITLED
-- CHANNEL WITH A VALID TOKEN AND AN OPEN LOBBY.
-- =====================================================================
do $$
declare shape text; rows_seen bigint;
begin
  select count(*) into rows_seen
    from app_private.list_overlay_lobby_status('00000000-0000-4000-8000-000000005841'::uuid, 'prf02s6-lobby-a-fingerprint');
  if rows_seen <> 1 then raise exception 'an entitled channel with an open lobby must return exactly one row, got %', rows_seen; end if;

  select seat_count || '/' || confirmed_seat_count || '/' || queue_count into shape
    from app_private.list_overlay_lobby_status('00000000-0000-4000-8000-000000005841'::uuid, 'prf02s6-lobby-a-fingerprint');
  if shape <> '16/8/12' then raise exception 'the overlay must see 16/8/12, got %', shape; end if;
end
$$;

-- =====================================================================
-- L16.19 -- A BAD, FOREIGN, EXPIRED OR REVOKED TOKEN RETURNS ZERO ROWS.
-- Never an error, and never another channel's lobby.
-- =====================================================================
do $$
declare rows_seen bigint;
begin
  select count(*) into rows_seen from app_private.list_overlay_lobby_status('00000000-0000-4000-8000-000000005841'::uuid, 'wrong-fingerprint');
  if rows_seen <> 0 then raise exception 'a wrong fingerprint must return zero rows, got %', rows_seen; end if;

  select count(*) into rows_seen from app_private.list_overlay_lobby_status('00000000-0000-4000-8000-000000005842'::uuid, 'prf02s6-lobby-a-fingerprint');
  if rows_seen <> 0 then raise exception 'channel A''s token against channel B''s session must return zero rows, got %', rows_seen; end if;

  select count(*) into rows_seen from app_private.list_overlay_lobby_status('00000000-0000-4000-8000-000000005843'::uuid, 'prf02s6-lobby-expired-fingerprint');
  if rows_seen <> 0 then raise exception 'an expired session must return zero rows, got %', rows_seen; end if;

  select count(*) into rows_seen from app_private.list_overlay_lobby_status('00000000-0000-4000-8000-000000005844'::uuid, 'prf02s6-lobby-revoked-fingerprint');
  if rows_seen <> 0 then raise exception 'a revoked session must return zero rows, got %', rows_seen; end if;

  select count(*) into rows_seen from app_private.list_overlay_lobby_status('00000000-0000-4000-8000-0000000058fe'::uuid, 'prf02s6-lobby-a-fingerprint');
  if rows_seen <> 0 then raise exception 'an unknown overlay id must return zero rows, got %', rows_seen; end if;

  -- Channel B is entitled and has a perfectly valid session, but no lobby.
  select count(*) into rows_seen from app_private.list_overlay_lobby_status('00000000-0000-4000-8000-000000005842'::uuid, 'prf02s6-lobby-b-fingerprint');
  if rows_seen <> 0 then raise exception 'an entitled channel with no open lobby must return zero rows, got %', rows_seen; end if;
end
$$;

-- =====================================================================
-- L16.20 -- THE TIER GATE IS ON THE MODULE. Channel C is PRO: it can open
-- a lobby, write its counts and read them back (that is its own durable
-- record, never tier-gated, §12.6) -- but its OVERLAY read returns
-- nothing, because §30.3 places the Lobby Engine at Creator+ and nothing
-- can grant the Events Pack.
-- =====================================================================
do $$
declare lobby uuid; rows_seen bigint; creator_rows bigint;
begin
  lobby := app_private.open_lobby_session('00000000-0000-4000-8000-000000005813'::uuid, 10);
  perform app_private.update_lobby_session_counts('00000000-0000-4000-8000-000000005813'::uuid, lobby, 5, 7);

  -- The creator's own read is NOT tier-gated and must answer.
  select count(*) into creator_rows from app_private.list_channel_lobby_session('00000000-0000-4000-8000-000000005813'::uuid);
  if creator_rows <> 1 then
    raise exception 'a PRO creator must read their OWN lobby record -- §12.6 forbids tier-gating that; got % row(s)', creator_rows;
  end if;

  -- The overlay read IS gated, and must not.
  select count(*) into rows_seen from app_private.list_overlay_lobby_status('00000000-0000-4000-8000-000000005845'::uuid, 'prf02s6-lobby-c-fingerprint');
  if rows_seen <> 0 then
    raise exception 'an unentitled channel must render nothing even with a valid overlay token, got % row(s)', rows_seen;
  end if;
end
$$;

-- =====================================================================
-- L16.9 / L16.10 / L16.11 / L16.21 -- CLOSING.
-- =====================================================================
do $$
declare lobby uuid; rows_seen bigint; total bigint; reopened uuid;
begin
  select id into lobby from public.lobby_sessions where channel_id = '00000000-0000-4000-8000-000000005811' and closed_at is null;

  -- A moderator cannot close it, and gets the same "not found" answer.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
  begin
    perform app_private.close_lobby_session('00000000-0000-4000-8000-000000005811'::uuid, lobby);
    raise exception 'a moderator must not be able to close the lobby';
  exception when no_data_found then null;
  end;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

  -- Another channel's lobby id is the same one indistinguishable answer.
  begin
    perform app_private.close_lobby_session('00000000-0000-4000-8000-000000005812'::uuid, lobby);
    raise exception 'closing a lobby through the wrong channel must be not-found';
  exception when no_data_found then null;
  end;

  perform app_private.close_lobby_session('00000000-0000-4000-8000-000000005811'::uuid, lobby);

  -- L16.21: a closed lobby is not current state, so the overlay sees nothing.
  select count(*) into rows_seen from app_private.list_overlay_lobby_status('00000000-0000-4000-8000-000000005841'::uuid, 'prf02s6-lobby-a-fingerprint');
  if rows_seen <> 0 then raise exception 'a closed lobby must return zero rows on the overlay, got %', rows_seen; end if;

  -- L16.11: closing DELETES NOTHING. The durable record survives (§12.6).
  select count(*) into total from public.lobby_sessions where channel_id = '00000000-0000-4000-8000-000000005811';
  if total <> 1 then raise exception 'closing must not delete the durable record; found % row(s)', total; end if;
  select count(*) into total from public.lobby_sessions where id = lobby and closed_at is not null and confirmed_seat_count = 8 and queue_count = 12;
  if total <> 1 then raise exception 'the closed row must keep its counts and gain a closed_at'; end if;

  -- Closing again is the same indistinguishable not-found.
  begin
    perform app_private.close_lobby_session('00000000-0000-4000-8000-000000005811'::uuid, lobby);
    raise exception 'closing an already-closed lobby must be not-found';
  exception when no_data_found then null;
  end;

  -- L16.10: the partial unique index constrains only OPEN lobbies, so a
  -- new one may now be opened.
  reopened := app_private.open_lobby_session('00000000-0000-4000-8000-000000005811'::uuid, 5);
  if reopened is null then raise exception 'a new lobby must be openable once the previous one is closed'; end if;

  select count(*) into total from public.lobby_sessions where channel_id = '00000000-0000-4000-8000-000000005811';
  if total <> 2 then raise exception 'the closed lobby and the new one must both exist; found % row(s)', total; end if;
end
$$;

-- =====================================================================
-- L16.18 -- THE RETURNED COLUMN SET IS EXACTLY
-- {seat_count, confirmed_seat_count, queue_count}, AND NOTHING ELSE,
-- EVER.
--
-- This is §16's "aggregate status only ... Never player identifiers,
-- never Discord names, never codes or passwords" expressed as an
-- executable assertion about the QUERY rather than a rule a reviewer has
-- to enforce on the renderer. Two independent checks, because one is a
-- single point of failure:
--
--   (a) the catalogue's declared result type, which fails if the
--       `returns table (...)` signature ever grows a column; and
--   (b) the ACTUAL shape of a real call, materialised into a table and
--       read back through information_schema.columns, which fails if the
--       select list ever emits something the signature did not declare.
--
-- Adding any column at all -- a room code, a password, a seat token, a
-- player identifier, an in-game name, a Discord name, a viewer id, an
-- anonymous identity, a session id, or even a harmless-looking lobby id --
-- turns this file red by name.
-- =====================================================================
do $$
declare declared_result text;
begin
  select pg_catalog.pg_get_function_result(p.oid)
    into declared_result
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_lobby_status';

  if declared_result is null then raise exception 'app_private.list_overlay_lobby_status does not exist'; end if;
  if declared_result <> 'TABLE(seat_count integer, confirmed_seat_count integer, queue_count integer)' then
    raise exception 'the overlay lobby read must return aggregate counts and nothing else (§16: aggregate status only -- never player identifiers, never Discord names, never codes or passwords). Declared result is "%", expected exactly "TABLE(seat_count integer, confirmed_seat_count integer, queue_count integer)"', declared_result;
  end if;
end
$$;

create temporary table prf02s6_lobby_returned_shape as
  select * from app_private.list_overlay_lobby_status('00000000-0000-4000-8000-000000005841'::uuid, 'prf02s6-lobby-a-fingerprint');

do $$
declare actual_columns text;
begin
  select string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position)
    into actual_columns
    from information_schema.columns
   where table_name = 'prf02s6_lobby_returned_shape';

  if actual_columns <> 'seat_count integer, confirmed_seat_count integer, queue_count integer' then
    raise exception 'the columns actually returned by a live call must be exactly "seat_count integer, confirmed_seat_count integer, queue_count integer", got "%" -- any additional column is an identifier, a code or a password leaving the database on the overlay path', actual_columns;
  end if;
end
$$;

-- =====================================================================
-- L16.22 -- NO CODE, PASSWORD, SEAT TOKEN OR PLAYER-IDENTIFYING SURFACE
-- EXISTS ON THIS PATH, PROVEN AGAINST THE SHIPPED FUNCTION DEFINITION
-- RATHER THAN A COMMENT.
--
-- `session` is deliberately NOT on this list: the read's own auth
-- predicate is `public.overlay_sessions`, and banning that token outright
-- would ban the token-fingerprint gate every other list_overlay_* function
-- uses. What matters is that no session identifier LEAVES the database,
-- and that is L16.18's job -- the returned column set is asserted exactly,
-- twice.
-- =====================================================================
do $$
declare definition text; forbidden text;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_lobby_status';

  foreach forbidden in array array['room_code', 'roomcode', 'password', 'passcode', 'seat_token', 'player',
                                   'in_game', 'ingame', 'discord', 'viewer', 'anonymous', 'ip_address',
                                   'remote_addr', 'initials', 'avatar', 'supporter', 'donor']
  loop
    if position(forbidden in definition) > 0 then
      raise exception 'the overlay lobby read must contain no "%" token at all -- §16 requires aggregate status only', forbidden;
    end if;
  end loop;
end
$$;

-- =====================================================================
-- L16.23 -- THERE IS NO PER-VIEWER COLUMN FOR A FUTURE READ TO EXPOSE,
-- AND NOTHING TWO VISITS COULD BE CORRELATED ON. Owner decision 4,
-- asserted against the TABLE rather than only the read.
--
-- Asserted against the WHOLE migration's surface: 0140 creates exactly one
-- table, so if that table carries no such column, no such column exists.
-- =====================================================================
do $$
declare identifying_columns text;
begin
  select string_agg(column_name, ', ' order by column_name)
    into identifying_columns
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'lobby_sessions'
     and (column_name like '%viewer%' or column_name like '%anonymous%' or column_name like '%ip%'
          or column_name like '%player%' or column_name like '%code%' or column_name like '%password%'
          or column_name like '%token%' or column_name like '%discord%' or column_name like '%supporter%'
          or column_name like '%initial%' or column_name like '%avatar%');
  if identifying_columns is not null then
    raise exception 'lobby_sessions must carry no per-viewer, code, password or seat-token column; found: %', identifying_columns;
  end if;
end
$$;

-- There is also no DURATION, TIMER, EXPIRY, DEADLINE or SCHEDULED-END
-- column. closed_at is a RECORD of when the creator closed the lobby, never
-- a schedule -- the same distinction 0135 drew for ended_at.
do $$
declare temporal_columns text;
begin
  select string_agg(column_name, ', ' order by column_name)
    into temporal_columns
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'lobby_sessions'
     and (column_name like '%duration%' or column_name like '%expire%' or column_name like '%expiry%'
          or column_name like '%deadline%' or column_name like '%ends%' or column_name like '%timer%'
          or column_name like '%countdown%' or column_name like '%scheduled%');
  if temporal_columns is not null then
    raise exception 'lobby_sessions must carry no duration, timer, expiry, deadline or scheduled-end column; found: %', temporal_columns;
  end if;
end
$$;

-- =====================================================================
-- L16.24 -- MIGRATION 0140 IS ADDITIVE: it must not have touched 0131's
-- module catalogue check constraint, which already named lobby_status.
-- =====================================================================
do $$
declare has_key boolean;
begin
  select position('lobby_status' in pg_get_constraintdef(c.oid)) > 0
    into has_key
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
   where t.relname = 'master_canvas_modules'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%module_key%'
   limit 1;
  if has_key is not true then
    raise exception 'lobby_status must already be one of migration 0131''s catalogue keys -- this slice adds no key and alters no constraint';
  end if;
end
$$;

-- =====================================================================
-- THE CREATOR-FACING READ IS NEVER TIER-GATED AND NEVER LEAKS TO A
-- NON-MEMBER. Every member role sees it; a stranger sees zero rows.
-- =====================================================================
do $$
declare probe record; rows_seen bigint;
begin
  for probe in select unnest(array[
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000006'
    ]) as user_id
  loop
    perform set_config('app.user_id', probe.user_id, false);
    select count(*) into rows_seen from app_private.list_channel_lobby_session('00000000-0000-4000-8000-000000005811'::uuid);
    if rows_seen <> 1 then raise exception 'member % must read the channel''s current lobby, got % row(s)', probe.user_id, rows_seen; end if;
  end loop;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  select count(*) into rows_seen from app_private.list_channel_lobby_session('00000000-0000-4000-8000-000000005811'::uuid);
  if rows_seen <> 0 then raise exception 'a non-member must read zero rows, got %', rows_seen; end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
end
$$;

-- The creator-facing read carries no tier call at all.
do $$
declare definition text;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'list_channel_lobby_session';

  if position('events_pack_entitled' in definition) > 0 or position('current_channel_tier' in definition) > 0 then
    raise exception 'the creator''s own read must never be tier-gated (§12.6) -- the tier gate belongs on the overlay module only';
  end if;
end
$$;

do $$
declare definition text; fn text;
begin
  foreach fn in array array['open_lobby_session', 'update_lobby_session_counts', 'close_lobby_session']
  loop
    select pg_catalog.pg_get_functiondef(p.oid)
      into definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname = fn;
    if position('events_pack_entitled' in definition) > 0 or position('current_channel_tier' in definition) > 0 then
      raise exception 'app_private.% must never be tier-gated -- storing a durable creator record is available at every tier (§12.6)', fn;
    end if;
  end loop;
end
$$;

select 'prf02_slice6_lobby_status: all cases passed' as result;
