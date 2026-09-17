-- PRF-02 slice 6, §6 catalogue module #17 (Giveaway / Tournament Card) and
-- the minimum §17 schema behind it: app_private.open_giveaway,
-- update_giveaway_entry_count, close_giveaway, list_channel_giveaway,
-- start_tournament, set_tournament_progress, conclude_tournament,
-- list_channel_tournament and list_overlay_giveaway_tournament
-- (migration 0142).
--
-- This file owns id block ...5a00-...5aff (recorded in
-- fixtures/00_base_world.sql's ID ALLOCATION REGISTRY). It seeds its OWN
-- channels, memberships, entitlement versions, lobby sessions and overlay
-- sessions rather than reusing base_world's, because the things under test
-- are COUNTS, BRACKET ARITHMETIC and TIERS, and an assertion another file
-- can move is not an assertion.
--
-- THE FOUR CASES THAT MATTER MOST:
--
--   G17.18 -- NO RANDOMNESS OR CHANCE-SELECTION PRIMITIVE EXISTS. §17.1
--   decided on 2026-09-13, before and independently of GIV-07, that only
--   free-entry and skill-based formats ship and that supporter-weighted
--   odds are not built. Asserted structurally against every shipped
--   function definition, so a future edit that reaches for one turns this
--   file red by name. gen_random_uuid() is permitted explicitly and is the
--   only random-containing token the migration uses.
--
--   G17.23 -- THE RETURNED COLUMN SET. The overlay read is aggregate state
--   only, enforced on the DECLARED RESULT TYPE exactly as 0136, 0139 and
--   0140 do, and asserted twice over: from the catalogue
--   (pg_get_function_result) and from a table materialised out of a real
--   call and read back through information_schema.columns. Adding ANY
--   column -- a participant identifier, an in-game name, a Discord name, a
--   viewer id, an anonymous identity, a session id, a postal field or a
--   contact detail -- turns this file red by name.
--
--   G17.10 -- THE TOURNAMENT DOES NOT DUPLICATE THE LOBBY. §17.2 says
--   tournaments are built ON the Lobby Engine. public.tournaments carries
--   a not-null FK to public.lobby_sessions and NO seat, queue, field-size
--   or capacity column of its own -- asserted against
--   information_schema.columns, not against a comment.
--
--   G17.19 / G17.20 -- NO RESULT AND NO PRIZE CUSTODY SURFACE EXISTS.
--   §17.1: BharatStudio never holds, escrows, ships or guarantees a prize,
--   and a winner announcement needs consent that does not exist here.
--   Asserted against the columns of both tables this migration creates.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Fixture.
--   Channel A (...5a11) -- CREATOR tier, entitled. The channel under test.
--   Channel B (...5a12) -- CREATOR tier, entitled. The cross-channel probe.
--   Channel C (...5a13) -- PRO tier, NOT entitled. The §30.3 probe.
-- Users ...0001 (owner of A and C), ...0002 (owner of B) and the
-- non-owner/admin probes ...0003/...0004/...0005/...0006 come from
-- base_world.
-- ---------------------------------------------------------------------
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005a11', '00000000-0000-4000-8000-000000000001', 'giveaway_a', 'Giveaway A', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005a12', '00000000-0000-4000-8000-000000000002', 'giveaway_b', 'Giveaway B', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005a13', '00000000-0000-4000-8000-000000000001', 'giveaway_c', 'Giveaway C', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000005a11', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005a11', '00000000-0000-4000-8000-000000000003', 'admin', current_timestamp),
  ('00000000-0000-4000-8000-000000005a11', '00000000-0000-4000-8000-000000000004', 'operator', current_timestamp),
  ('00000000-0000-4000-8000-000000005a11', '00000000-0000-4000-8000-000000000005', 'moderator', current_timestamp),
  ('00000000-0000-4000-8000-000000005a11', '00000000-0000-4000-8000-000000000006', 'viewer', current_timestamp),
  ('00000000-0000-4000-8000-000000005a12', '00000000-0000-4000-8000-000000000002', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005a13', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

-- The `values` payloads are deliberately EMPTY objects, which is exactly
-- the state every real entitlement publisher produces.
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000005a11', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005a12', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005a13', 1, 'pro', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- Four overlay sessions: a good one for A, a good one for B, an expired
-- one for A, and a perfectly good one for the UNENTITLED channel C. The
-- last is G17.28 and is the whole point of having C.
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values
  ('00000000-0000-4000-8000-000000005a41', '00000000-0000-4000-8000-000000005a11', 'prf02s6-giveaway-a-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005a42', '00000000-0000-4000-8000-000000005a12', 'prf02s6-giveaway-b-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005a43', '00000000-0000-4000-8000-000000005a11', 'prf02s6-giveaway-expired-fingerprint', current_timestamp - interval '1 minute', current_timestamp - interval '2 hours'),
  ('00000000-0000-4000-8000-000000005a45', '00000000-0000-4000-8000-000000005a13', 'prf02s6-giveaway-c-fingerprint', current_timestamp + interval '1 hour', current_timestamp);

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at, revoked_at)
values
  ('00000000-0000-4000-8000-000000005a44', '00000000-0000-4000-8000-000000005a11', 'prf02s6-giveaway-revoked-fingerprint', current_timestamp + interval '1 hour', current_timestamp, current_timestamp);

-- =====================================================================
-- G17.18 -- NO RANDOMNESS OR CHANCE-SELECTION PRIMITIVE EXISTS IN ANY
-- FUNCTION THIS MIGRATION SHIPS.
--
-- This is the structural guard the whole no-chance property rests on.
-- §17.1's decision of 2026-09-13 restricts giveaways to free-entry and
-- skill-based formats only and states that supporter-weighted odds are not
-- built; GIV-07 separately gates chance-based formats on a legal review
-- that has not happened and stays Blocked.
--
-- gen_random_uuid() is PERMITTED and is not matched: the banned token is
-- 'random(' and the permitted call spells 'random_uuid(' -- the character
-- after "random" is an underscore, not an open parenthesis. 'random_bytes'
-- is banned separately so the cryptographic generator cannot be smuggled
-- in as an id generator.
-- =====================================================================
do $$
declare definition text; forbidden text; fn text;
begin
  foreach fn in array array['open_giveaway', 'update_giveaway_entry_count', 'close_giveaway',
                            'list_channel_giveaway', 'start_tournament', 'set_tournament_progress',
                            'conclude_tournament', 'list_channel_tournament',
                            'list_overlay_giveaway_tournament']
  loop
    select pg_catalog.pg_get_functiondef(p.oid)
      into definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname = fn;
    if definition is null then raise exception 'app_private.% does not exist', fn; end if;

    foreach forbidden in array array['random(', 'random_bytes', 'setseed', 'tablesample',
                                     'shuffle', 'lottery', 'raffle', 'sortition',
                                     'odds', 'weighted', 'weight']
    loop
      if position(forbidden in definition) > 0 then
        raise exception 'app_private.% contains a "%" token -- NO chance-based mechanic of any kind may ship (FULL-PRODUCT-DEFINITION.md §17.1, decided 2026-09-13; GIV-07 is Blocked)', fn, forbidden;
      end if;
    end loop;
  end loop;
end
$$;

-- gen_random_uuid() really is reachable and really is used: this asserts
-- that the exemption above is an exemption for something that exists,
-- rather than a loophole guarding nothing.
do $$
declare definition text;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'open_giveaway';
  if position('gen_random_uuid()' in definition) = 0 then
    raise exception 'open_giveaway is expected to mint its id with gen_random_uuid(), the same way 0140 does';
  end if;
end
$$;

-- =====================================================================
-- G17.19 / G17.20 -- NO RESULT SURFACE AND NO PRIZE CUSTODY SURFACE
-- EXISTS, ASSERTED AGAINST THE COLUMNS OF BOTH TABLES.
--
-- §17.1: BharatStudio never holds, escrows, ships or guarantees a prize --
-- the creator is the promoter and is responsible for eligibility, taxes
-- and delivery. And a winner announcement requires consent, which does not
-- exist as a mechanism in this schema, so the card cannot show one.
-- Neither may be approximated by a creator-records-the-result column
-- (owner decision 4).
-- =====================================================================
do $$
declare offending text;
begin
  select string_agg(table_name || '.' || column_name, ', ' order by table_name, column_name)
    into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('giveaways', 'tournaments')
     and (column_name like '%winner%' or column_name like '%seed%' or column_name like '%odds%'
          or column_name like '%weight%' or column_name like '%chance%' or column_name like '%random%'
          or column_name like '%override%' or column_name like '%result%' or column_name like '%champion%');
  if offending is not null then
    raise exception 'neither table may carry a result, seed, odds, weight, chance or override column -- no chance mechanic ships and the card shows no winner; found: %', offending;
  end if;
end
$$;

do $$
declare offending text;
begin
  select string_agg(table_name || '.' || column_name, ', ' order by table_name, column_name)
    into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('giveaways', 'tournaments')
     and (column_name like '%prize%' or column_name like '%escrow%' or column_name like '%custody%'
          or column_name like '%ship%' or column_name like '%deliver%' or column_name like '%fulfil%'
          or column_name like '%fulfill%' or column_name like '%address%' or column_name like '%claim%'
          or column_name like '%postal%' or column_name like '%courier%' or column_name like '%tracking%');
  if offending is not null then
    raise exception 'BharatStudio never holds, escrows, ships or guarantees a prize (§17.1) -- no custody, fulfilment, address or claim column may exist; found: %', offending;
  end if;
end
$$;

-- No per-viewer, participant or contact column either, so nothing can
-- correlate one visit to another and there is nothing for a future read to
-- start returning.
do $$
declare offending text;
begin
  select string_agg(table_name || '.' || column_name, ', ' order by table_name, column_name)
    into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('giveaways', 'tournaments')
     and (column_name like '%viewer%' or column_name like '%anonymous%' or column_name like '%participant%'
          or column_name like '%entrant%' or column_name like '%player%' or column_name like '%discord%'
          or column_name like '%supporter%' or column_name like '%initial%' or column_name like '%avatar%'
          or column_name like '%email%' or column_name like '%phone%' or column_name like '%ip_%');
  if offending is not null then
    raise exception 'neither table may carry a participant, viewer or contact column; found: %', offending;
  end if;
end
$$;

-- =====================================================================
-- G17.10 -- THE TOURNAMENT REFERENCES 0140's LOBBY AND DUPLICATES NONE OF
-- IT. §17.2: tournaments are "built on the Lobby Engine rather than beside
-- it". The FK is asserted from pg_constraint; the absence of a duplicated
-- capacity column is asserted from information_schema.columns.
-- =====================================================================
do $$
declare referenced text;
begin
  select confrelid::regclass::text into referenced
    from pg_constraint
   where conrelid = 'public.tournaments'::regclass
     and contype = 'f'
     and confrelid = 'public.lobby_sessions'::regclass;
  if referenced is null then
    raise exception 'public.tournaments must carry a foreign key to public.lobby_sessions (§17.2: built ON the Lobby Engine, not beside it)';
  end if;
end
$$;

do $$
declare is_nullable_flag text;
begin
  select is_nullable into is_nullable_flag
    from information_schema.columns
   where table_schema = 'public' and table_name = 'tournaments' and column_name = 'lobby_session_id';
  if is_nullable_flag is distinct from 'NO' then
    raise exception 'tournaments.lobby_session_id must be NOT NULL -- a tournament without a lobby is a tournament built beside the Lobby Engine';
  end if;
end
$$;

do $$
declare offending text;
begin
  select string_agg(column_name, ', ' order by column_name)
    into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'tournaments'
     and (column_name like '%seat%' or column_name like '%queue%' or column_name like '%field%'
          or column_name like '%capacity%' or column_name like '%bracket_size%' or column_name like '%size%'
          or column_name like '%ready%' or column_name like '%team%' or column_name like '%score%'
          or column_name like '%sponsor%' or column_name like '%check_in%' or column_name like '%checkin%');
  if offending is not null then
    raise exception 'tournaments must NOT duplicate what 0140 already stores, and must not add scores, teams, sponsors or check-in: the bracket field size IS the referenced lobby''s seat_count; found: %', offending;
  end if;
end
$$;

-- There is no duration, countdown or timer column on EITHER table.
-- giveaways carries the two ENTRY WINDOW instants, and only those, because
-- §17.1 names the entry window as something the creator defines and
-- publishes -- unlike a lobby duration, which 0140 refused because §16
-- named no such value.
do $$
declare offending text;
begin
  select string_agg(table_name || '.' || column_name, ', ' order by table_name, column_name)
    into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('giveaways', 'tournaments')
     and (column_name like '%duration%' or column_name like '%countdown%' or column_name like '%timer%'
          or column_name like '%deadline%' or column_name like '%scheduled%' or column_name like '%remaining%');
  if offending is not null then
    raise exception 'no duration, countdown, timer, deadline or scheduled column may exist; found: %', offending;
  end if;
end
$$;

-- =====================================================================
-- G17.21 -- NO PRICE, NO BILLING, NO PURCHASE PATH, so a paid-only entry
-- is impossible: there is no entry path at all for a payment to gate.
-- §33's Rs 129/mo stays in the authority.
-- =====================================================================
do $$
declare definition text; forbidden text; fn text;
begin
  foreach fn in array array['open_giveaway', 'update_giveaway_entry_count', 'close_giveaway',
                            'list_channel_giveaway', 'start_tournament', 'set_tournament_progress',
                            'conclude_tournament', 'list_channel_tournament',
                            'list_overlay_giveaway_tournament']
  loop
    select pg_catalog.pg_get_functiondef(p.oid)
      into definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname = fn;

    foreach forbidden in array array['paise', 'amount', 'currency', 'price', 'invoice',
                                     'subscription', 'razorpay', 'billing', 'payment']
    loop
      if position(forbidden in definition) > 0 then
        raise exception 'app_private.% contains a "%" token -- this slice implements no price, no billing and no purchase path, and never a paid entry (§17.1)', fn, forbidden;
      end if;
    end loop;
  end loop;
end
$$;

-- =====================================================================
-- G17.22 -- 0142 REUSES 0140's ENTITLEMENT AND DOES NOT REIMPLEMENT IT.
-- Exactly one function in this slice mentions events_pack_entitled (the
-- overlay read), and none of them mentions the pack GRANT key -- which is
-- what keeps 0140's own "nothing can grant the Events Pack" assertion true
-- after this migration lands.
-- =====================================================================
do $$
declare definition text; fn text; callers text[] := array[]::text[];
begin
  foreach fn in array array['open_giveaway', 'update_giveaway_entry_count', 'close_giveaway',
                            'list_channel_giveaway', 'start_tournament', 'set_tournament_progress',
                            'conclude_tournament', 'list_channel_tournament',
                            'list_overlay_giveaway_tournament']
  loop
    select pg_catalog.pg_get_functiondef(p.oid)
      into definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname = fn;

    if position('eventsPack' in definition) > 0 then
      raise exception 'app_private.% mentions the Events Pack GRANT KEY -- only 0140''s events_pack_entitled may, or nothing can be proven ungrantable any more', fn;
    end if;
    if position('events_pack_entitled' in definition) > 0 then
      callers := callers || fn;
    end if;
  end loop;

  if callers <> array['list_overlay_giveaway_tournament'] then
    raise exception 'exactly one function -- the OVERLAY read -- may call events_pack_entitled (§12.6: the tier gate is on the module, never on the creator''s record); callers were %', array_to_string(callers, ', ');
  end if;
end
$$;

-- =====================================================================
-- G17.1 / G17.2 / G17.3 / G17.4 -- OPENING A GIVEAWAY.
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
      perform app_private.open_giveaway('00000000-0000-4000-8000-000000005a11'::uuid, current_timestamp + interval '30 minutes');
      raise exception 'open_giveaway must reject user % -- only owner/admin may open one', probe.user_id;
    exception when insufficient_privilege then null;
    end;
  end loop;

  select count(*) into opened from public.giveaways where channel_id = '00000000-0000-4000-8000-000000005a11';
  if opened <> 0 then raise exception 'a refused open must insert nothing, found % row(s)', opened; end if;
end
$$;

do $$
declare giveaway_id uuid; entry_window record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

  -- A close instant at or before now is not a window.
  begin
    perform app_private.open_giveaway('00000000-0000-4000-8000-000000005a11'::uuid, current_timestamp - interval '1 minute');
    raise exception 'an entry window closing in the past must be refused';
  exception when invalid_parameter_value then null;
  end;

  giveaway_id := app_private.open_giveaway('00000000-0000-4000-8000-000000005a11'::uuid, current_timestamp + interval '30 minutes');
  if giveaway_id is null then raise exception 'open_giveaway must return the new id'; end if;

  select entry_count, entry_opens_at, entry_closes_at, closed_at into entry_window
    from public.giveaways where id = giveaway_id;
  if entry_window.entry_count <> 0 then raise exception 'a new giveaway starts at zero entries, got %', entry_window.entry_count; end if;
  if entry_window.closed_at is not null then raise exception 'a new giveaway is open'; end if;
  if entry_window.entry_closes_at <= entry_window.entry_opens_at then raise exception 'the window must be ordered'; end if;

  -- A second OPEN giveaway is a conflict, never a silent supersede.
  begin
    perform app_private.open_giveaway('00000000-0000-4000-8000-000000005a11'::uuid, current_timestamp + interval '1 hour');
    raise exception 'a second open giveaway must be refused';
  exception when unique_violation then null;
  end;
end
$$;

-- The partial unique index is the HARD guarantee, independent of the
-- function's courteous pre-check.
do $$
begin
  begin
    insert into public.giveaways (id, channel_id, created_by_user_id, entry_count, entry_opens_at, entry_closes_at, closed_at, created_at, updated_at)
    values (gen_random_uuid(), '00000000-0000-4000-8000-000000005a11', '00000000-0000-4000-8000-000000000001', 0,
            current_timestamp, current_timestamp + interval '10 minutes', null, current_timestamp, current_timestamp);
    raise exception 'the partial unique index must refuse a second OPEN giveaway even on a direct insert';
  exception when unique_violation then null;
  end;
end
$$;

-- =====================================================================
-- G17.5 / G17.6 -- REPORTING THE ENTRY COUNT.
-- =====================================================================
do $$
declare giveaway_id uuid; seen integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  select id into giveaway_id from public.giveaways where channel_id = '00000000-0000-4000-8000-000000005a11' and closed_at is null;

  perform app_private.update_giveaway_entry_count('00000000-0000-4000-8000-000000005a11'::uuid, giveaway_id, 142);
  select entry_count into seen from public.giveaways where id = giveaway_id;
  if seen <> 142 then raise exception 'the reported entry count must be stored, got %', seen; end if;

  -- An admin may report it too.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000003', false);
  perform app_private.update_giveaway_entry_count('00000000-0000-4000-8000-000000005a11'::uuid, giveaway_id, 143);
  select entry_count into seen from public.giveaways where id = giveaway_id;
  if seen <> 143 then raise exception 'an admin must be able to report the entry count, got %', seen; end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  begin
    perform app_private.update_giveaway_entry_count('00000000-0000-4000-8000-000000005a11'::uuid, giveaway_id, -1);
    raise exception 'a negative entry count must be refused';
  exception when invalid_parameter_value then null;
  end;

  -- A non-owner/admin gets P0002, indistinguishable from not-found.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
  begin
    perform app_private.update_giveaway_entry_count('00000000-0000-4000-8000-000000005a11'::uuid, giveaway_id, 9999);
    raise exception 'a moderator must not be able to report the entry count';
  exception when no_data_found then null;
  end;

  -- A foreign channel's id cannot be used to write this giveaway.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  begin
    perform app_private.update_giveaway_entry_count('00000000-0000-4000-8000-000000005a12'::uuid, giveaway_id, 7);
    raise exception 'channel B''s owner must not reach channel A''s giveaway';
  exception when no_data_found then null;
  end;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  select entry_count into seen from public.giveaways where id = giveaway_id;
  if seen <> 143 then raise exception 'no refused write may have changed the count, got %', seen; end if;
end
$$;

-- =====================================================================
-- G17.11 / G17.12 / G17.13 / G17.14 / G17.15 -- STARTING A TOURNAMENT ON
-- A LOBBY.
-- =====================================================================
do $$
declare lobby_id uuid; tournament_id uuid; foreign_lobby uuid;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

  -- A field size §30.3 does not allow is refused BEFORE any tournament row
  -- exists: single elimination without byes needs a power of two, and
  -- §30.3 caps the field at 8.
  lobby_id := app_private.open_lobby_session('00000000-0000-4000-8000-000000005a11'::uuid, 16);
  begin
    perform app_private.start_tournament('00000000-0000-4000-8000-000000005a11'::uuid, lobby_id);
    raise exception 'a 16-seat lobby must be refused -- §30.3 caps a single-elimination field at 8';
  exception when invalid_parameter_value then null;
  end;
  perform app_private.close_lobby_session('00000000-0000-4000-8000-000000005a11'::uuid, lobby_id);

  lobby_id := app_private.open_lobby_session('00000000-0000-4000-8000-000000005a11'::uuid, 6);
  begin
    perform app_private.start_tournament('00000000-0000-4000-8000-000000005a11'::uuid, lobby_id);
    raise exception 'a 6-seat lobby must be refused -- single elimination without byes needs a power of two';
  exception when invalid_parameter_value then null;
  end;
  perform app_private.close_lobby_session('00000000-0000-4000-8000-000000005a11'::uuid, lobby_id);

  -- A CLOSED lobby cannot host a new tournament.
  begin
    perform app_private.start_tournament('00000000-0000-4000-8000-000000005a11'::uuid, lobby_id);
    raise exception 'a closed lobby must not host a new tournament';
  exception when no_data_found then null;
  end;

  -- Another channel's lobby is not reachable.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  foreign_lobby := app_private.open_lobby_session('00000000-0000-4000-8000-000000005a12'::uuid, 8);
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  begin
    perform app_private.start_tournament('00000000-0000-4000-8000-000000005a11'::uuid, foreign_lobby);
    raise exception 'channel A must not be able to start a tournament on channel B''s lobby';
  exception when no_data_found then null;
  end;

  -- The real one: an OPEN 8-seat lobby on this channel.
  lobby_id := app_private.open_lobby_session('00000000-0000-4000-8000-000000005a11'::uuid, 8);

  -- Only owner/admin.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000004', false);
  begin
    perform app_private.start_tournament('00000000-0000-4000-8000-000000005a11'::uuid, lobby_id);
    raise exception 'an operator must not be able to start a tournament';
  exception when insufficient_privilege then null;
  end;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  tournament_id := app_private.start_tournament('00000000-0000-4000-8000-000000005a11'::uuid, lobby_id);
  if tournament_id is null then raise exception 'start_tournament must return the new id'; end if;

  begin
    perform app_private.start_tournament('00000000-0000-4000-8000-000000005a11'::uuid, lobby_id);
    raise exception 'a second running tournament must be refused';
  exception when unique_violation then null;
  end;
end
$$;

-- =====================================================================
-- G17.16 -- PROGRESS IS BOUNDED BY THE REFERENCED LOBBY'S SEAT COUNT, NOT
-- BY A NUMBER OF THIS TABLE'S OWN. Field 8 -> 3 rounds; round 1 holds 4
-- matches, round 2 holds 2, round 3 holds 1.
-- =====================================================================
do $$
declare tournament_id uuid; seen record;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  select id into tournament_id from public.tournaments where channel_id = '00000000-0000-4000-8000-000000005a11' and concluded_at is null;

  perform app_private.set_tournament_progress('00000000-0000-4000-8000-000000005a11'::uuid, tournament_id, 1, 4);
  perform app_private.set_tournament_progress('00000000-0000-4000-8000-000000005a11'::uuid, tournament_id, 2, 1);

  select current_round, completed_matches_in_round into seen from public.tournaments where id = tournament_id;
  if seen.current_round <> 2 or seen.completed_matches_in_round <> 1 then
    raise exception 'progress must be stored as reported, got round % with % matches', seen.current_round, seen.completed_matches_in_round;
  end if;

  -- Round 4 is past the end of a field of 8.
  begin
    perform app_private.set_tournament_progress('00000000-0000-4000-8000-000000005a11'::uuid, tournament_id, 4, 0);
    raise exception 'round 4 on a field of 8 must be refused';
  exception when invalid_parameter_value then null;
  end;

  -- Round 2 holds two matches, so three is impossible.
  begin
    perform app_private.set_tournament_progress('00000000-0000-4000-8000-000000005a11'::uuid, tournament_id, 2, 3);
    raise exception 'three completed matches in a two-match round must be refused';
  exception when invalid_parameter_value then null;
  end;

  -- The final holds exactly one.
  perform app_private.set_tournament_progress('00000000-0000-4000-8000-000000005a11'::uuid, tournament_id, 3, 1);
  begin
    perform app_private.set_tournament_progress('00000000-0000-4000-8000-000000005a11'::uuid, tournament_id, 3, 2);
    raise exception 'two completed matches in a one-match final must be refused';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform app_private.set_tournament_progress('00000000-0000-4000-8000-000000005a11'::uuid, tournament_id, 0, 0);
    raise exception 'round 0 must be refused';
  exception when invalid_parameter_value then null;
  end;

  -- A moderator gets P0002, indistinguishable from not-found.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
  begin
    perform app_private.set_tournament_progress('00000000-0000-4000-8000-000000005a11'::uuid, tournament_id, 1, 0);
    raise exception 'a moderator must not be able to report progress';
  exception when no_data_found then null;
  end;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  perform app_private.set_tournament_progress('00000000-0000-4000-8000-000000005a11'::uuid, tournament_id, 2, 1);
end
$$;

-- =====================================================================
-- G17.25 / G17.26 -- THE OVERLAY READ: ONE ROW, SIX AGGREGATE VALUES, FOR
-- AN ENTITLED CHANNEL, WITH THE TOURNAMENT'S BRACKET SHAPE DERIVED FROM
-- THE REFERENCED LOBBY.
-- =====================================================================
do $$
declare seen record; rows_seen bigint;
begin
  select count(*) into rows_seen from app_private.list_overlay_giveaway_tournament('00000000-0000-4000-8000-000000005a41'::uuid, 'prf02s6-giveaway-a-fingerprint');
  if rows_seen <> 1 then raise exception 'an entitled channel with both halves live must return exactly one row, got %', rows_seen; end if;

  select * into seen from app_private.list_overlay_giveaway_tournament('00000000-0000-4000-8000-000000005a41'::uuid, 'prf02s6-giveaway-a-fingerprint');
  if seen.entry_count <> 143 then raise exception 'entry count must be 143, got %', seen.entry_count; end if;
  if seen.entry_closes_at is null then raise exception 'the entry window close instant must be returned -- §17.1''s "time remaining"'; end if;
  if seen.tournament_current_round <> 2 then raise exception 'current round must be 2, got %', seen.tournament_current_round; end if;
  if seen.tournament_total_rounds <> 3 then raise exception 'a field of 8 has 3 rounds, got % -- this is DERIVED from the referenced lobby, not stored', seen.tournament_total_rounds; end if;
  if seen.tournament_completed_matches_in_round <> 1 then raise exception 'completed matches must be 1, got %', seen.tournament_completed_matches_in_round; end if;
  if seen.tournament_matches_in_round <> 2 then raise exception 'round 2 of a field of 8 holds 2 matches, got % -- DERIVED from the lobby''s seat_count', seen.tournament_matches_in_round; end if;
end
$$;

-- =====================================================================
-- G17.23 -- THE RETURNED COLUMN SET IS EXACTLY THE SIX AGGREGATE VALUES,
-- AND NOTHING ELSE, EVER.
--
-- Two independent checks, because one is a single point of failure:
--   (a) the catalogue's declared result type, which fails if the
--       `returns table (...)` signature ever grows a column; and
--   (b) the ACTUAL shape of a real call, materialised into a table and
--       read back through information_schema.columns, which fails if the
--       select list ever emits something the signature did not declare.
--
-- Adding any column at all -- a participant identifier, an in-game name, a
-- Discord name, a viewer id, an anonymous identity, a session id, a postal
-- field, a contact detail, a result, or even a harmless-looking giveaway
-- id -- turns this file red by name. THIS IS THE PRIVACY PROPERTY.
-- =====================================================================
do $$
declare declared_result text;
begin
  select pg_catalog.pg_get_function_result(p.oid)
    into declared_result
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_giveaway_tournament';

  if declared_result is null then raise exception 'app_private.list_overlay_giveaway_tournament does not exist'; end if;
  if declared_result <> 'TABLE(entry_count integer, entry_closes_at timestamp with time zone, tournament_current_round integer, tournament_total_rounds integer, tournament_completed_matches_in_round integer, tournament_matches_in_round integer)' then
    raise exception 'the overlay giveaway/tournament read must return aggregate state and nothing else (§17: entry count, time remaining, bracket state -- never a participant identifier, an in-game name, a Discord name, a viewer id, an anonymous identity, a session id, an address or a contact detail). Declared result is "%"', declared_result;
  end if;
end
$$;

create temporary table prf02s6_giveaway_returned_shape as
  select * from app_private.list_overlay_giveaway_tournament('00000000-0000-4000-8000-000000005a41'::uuid, 'prf02s6-giveaway-a-fingerprint');

do $$
declare actual_columns text;
begin
  select string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position)
    into actual_columns
    from information_schema.columns
   where table_name = 'prf02s6_giveaway_returned_shape';

  if actual_columns <> 'entry_count integer, entry_closes_at timestamp with time zone, tournament_current_round integer, tournament_total_rounds integer, tournament_completed_matches_in_round integer, tournament_matches_in_round integer' then
    raise exception 'the columns actually returned by a live call must be exactly the six aggregate values, got "%" -- any additional column is an identifier or a contact detail leaving the database on the overlay path', actual_columns;
  end if;
end
$$;

-- =====================================================================
-- G17.24 -- NO IDENTIFYING OR CHANCE TOKEN EXISTS ON THE OVERLAY PATH,
-- PROVEN AGAINST THE SHIPPED FUNCTION DEFINITION RATHER THAN A COMMENT.
--
-- `session` is deliberately NOT on this list: the read's own auth
-- predicate is public.overlay_sessions, and banning that token outright
-- would ban the token-fingerprint gate every other list_overlay_* function
-- uses. What matters is that no session identifier LEAVES the database,
-- and that is G17.23's job.
-- =====================================================================
do $$
declare definition text; forbidden text;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_giveaway_tournament';

  foreach forbidden in array array['participant', 'entrant', 'player', 'in_game', 'ingame',
                                   'discord', 'viewer', 'anonymous', 'ip_address', 'remote_addr',
                                   'initials', 'avatar', 'supporter', 'donor', 'winner',
                                   'address', 'email', 'phone', 'claim', 'prize']
  loop
    if position(forbidden in definition) > 0 then
      raise exception 'the overlay giveaway/tournament read must contain no "%" token at all -- §17 allows aggregate entry state and bracket state only', forbidden;
    end if;
  end loop;
end
$$;

-- =====================================================================
-- G17.27 -- A BAD, FOREIGN, EXPIRED OR REVOKED TOKEN RETURNS ZERO ROWS.
-- =====================================================================
do $$
declare probe record; rows_seen bigint;
begin
  for probe in select * from (values
      ('00000000-0000-4000-8000-000000005a41'::uuid, 'wrong-fingerprint', 'a wrong fingerprint'),
      ('00000000-0000-4000-8000-000000005a42'::uuid, 'prf02s6-giveaway-b-fingerprint', 'another channel''s session'),
      ('00000000-0000-4000-8000-000000005a43'::uuid, 'prf02s6-giveaway-expired-fingerprint', 'an expired session'),
      ('00000000-0000-4000-8000-000000005a44'::uuid, 'prf02s6-giveaway-revoked-fingerprint', 'a revoked session'),
      ('00000000-0000-4000-8000-0000000059ff'::uuid, 'prf02s6-giveaway-a-fingerprint', 'an unknown session id'),
      ('00000000-0000-4000-8000-000000005a41'::uuid, 'prf02s6-giveaway-b-fingerprint', 'a mismatched id/fingerprint pair')
    ) as t(overlay_id, fingerprint, label)
  loop
    select count(*) into rows_seen from app_private.list_overlay_giveaway_tournament(probe.overlay_id, probe.fingerprint);
    if rows_seen <> 0 then raise exception '% must return zero rows, got %', probe.label, rows_seen; end if;
  end loop;
end
$$;

-- =====================================================================
-- G17.28 -- THE TIER GATE IS ON THE MODULE. Channel C is PRO: it can open
-- a giveaway, report entries and read its own record back at any time --
-- what it does not get is the Canvas module painting it.
-- =====================================================================
do $$
declare giveaway_id uuid; rows_seen bigint; seen integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  giveaway_id := app_private.open_giveaway('00000000-0000-4000-8000-000000005a13'::uuid, current_timestamp + interval '20 minutes');
  perform app_private.update_giveaway_entry_count('00000000-0000-4000-8000-000000005a13'::uuid, giveaway_id, 55);

  -- The creator's own read is NOT tier-gated (§12.6).
  select entry_count into seen from app_private.list_channel_giveaway('00000000-0000-4000-8000-000000005a13'::uuid);
  if seen <> 55 then raise exception 'a PRO creator must read their own giveaway record, got %', seen; end if;

  -- The OVERLAY read is, and a perfectly valid token gets nothing.
  select count(*) into rows_seen from app_private.list_overlay_giveaway_tournament('00000000-0000-4000-8000-000000005a45'::uuid, 'prf02s6-giveaway-c-fingerprint');
  if rows_seen <> 0 then raise exception 'a PRO channel must render nothing on the Canvas (§30.3), got % row(s)', rows_seen; end if;
end
$$;

-- =====================================================================
-- G17.26 -- ONE HALF ALONE STILL RENDERS. Channel C has a giveaway and no
-- tournament; re-tiered to CREATOR it must return one row whose four
-- tournament columns are null. Then put it back so nothing later is
-- disturbed.
-- =====================================================================
do $$
declare seen record; rows_seen bigint;
begin
  insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
  values ('00000000-0000-4000-8000-000000005a13', 2, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp);

  select count(*) into rows_seen from app_private.list_overlay_giveaway_tournament('00000000-0000-4000-8000-000000005a45'::uuid, 'prf02s6-giveaway-c-fingerprint');
  if rows_seen <> 1 then raise exception 'a giveaway with no tournament must still render, got % row(s)', rows_seen; end if;

  select * into seen from app_private.list_overlay_giveaway_tournament('00000000-0000-4000-8000-000000005a45'::uuid, 'prf02s6-giveaway-c-fingerprint');
  if seen.entry_count <> 55 then raise exception 'the giveaway half must be present, got %', seen.entry_count; end if;
  if seen.tournament_current_round is not null or seen.tournament_total_rounds is not null
     or seen.tournament_completed_matches_in_round is not null or seen.tournament_matches_in_round is not null then
    raise exception 'the absent tournament half must be null, not fabricated';
  end if;

  insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
  values ('00000000-0000-4000-8000-000000005a13', 3, 'pro', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp);
end
$$;

-- The mirror case: a tournament with no giveaway. Channel B has neither
-- yet, so it gets a lobby, a tournament and no giveaway at all.
do $$
declare lobby_id uuid; tournament_id uuid; seen record; rows_seen bigint;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  select id into lobby_id from public.lobby_sessions where channel_id = '00000000-0000-4000-8000-000000005a12' and closed_at is null;
  tournament_id := app_private.start_tournament('00000000-0000-4000-8000-000000005a12'::uuid, lobby_id);
  perform app_private.set_tournament_progress('00000000-0000-4000-8000-000000005a12'::uuid, tournament_id, 1, 3);

  select count(*) into rows_seen from app_private.list_overlay_giveaway_tournament('00000000-0000-4000-8000-000000005a42'::uuid, 'prf02s6-giveaway-b-fingerprint');
  if rows_seen <> 1 then raise exception 'a tournament with no giveaway must still render, got % row(s)', rows_seen; end if;

  select * into seen from app_private.list_overlay_giveaway_tournament('00000000-0000-4000-8000-000000005a42'::uuid, 'prf02s6-giveaway-b-fingerprint');
  if seen.entry_count is not null or seen.entry_closes_at is not null then
    raise exception 'the absent giveaway half must be null, not fabricated';
  end if;
  if seen.tournament_total_rounds <> 3 or seen.tournament_matches_in_round <> 4 then
    raise exception 'round 1 of a field of 8 holds 4 matches across 3 rounds, got %/%', seen.tournament_matches_in_round, seen.tournament_total_rounds;
  end if;

  -- CLOSING THE LOBBY MUST NOT BLANK A RUNNING TOURNAMENT: the read joins
  -- the lobby BY ID, never by its lifecycle, and the row stays durable.
  perform app_private.close_lobby_session('00000000-0000-4000-8000-000000005a12'::uuid, lobby_id);
  select count(*) into rows_seen from app_private.list_overlay_giveaway_tournament('00000000-0000-4000-8000-000000005a42'::uuid, 'prf02s6-giveaway-b-fingerprint');
  if rows_seen <> 1 then raise exception 'closing the lobby must not blank a running tournament, got % row(s)', rows_seen; end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
end
$$;

-- =====================================================================
-- G17.7 / G17.8 / G17.17 / G17.29 -- CLOSING AND CONCLUDING. Neither
-- deletes anything, and neither produces a terminal or winner state: the
-- overlay simply stops having something to paint.
-- =====================================================================
do $$
declare giveaway_id uuid; tournament_id uuid; rows_seen bigint; survives bigint;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  select id into giveaway_id from public.giveaways where channel_id = '00000000-0000-4000-8000-000000005a11' and closed_at is null;
  select id into tournament_id from public.tournaments where channel_id = '00000000-0000-4000-8000-000000005a11' and concluded_at is null;

  -- A moderator cannot close or conclude.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
  begin
    perform app_private.close_giveaway('00000000-0000-4000-8000-000000005a11'::uuid, giveaway_id);
    raise exception 'a moderator must not be able to close a giveaway';
  exception when no_data_found then null;
  end;
  begin
    perform app_private.conclude_tournament('00000000-0000-4000-8000-000000005a11'::uuid, tournament_id);
    raise exception 'a moderator must not be able to conclude a tournament';
  exception when no_data_found then null;
  end;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  perform app_private.close_giveaway('00000000-0000-4000-8000-000000005a11'::uuid, giveaway_id);
  perform app_private.conclude_tournament('00000000-0000-4000-8000-000000005a11'::uuid, tournament_id);

  -- Closing twice is the same indistinguishable answer as not-found.
  begin
    perform app_private.close_giveaway('00000000-0000-4000-8000-000000005a11'::uuid, giveaway_id);
    raise exception 'closing an already-closed giveaway must raise P0002';
  exception when no_data_found then null;
  end;
  begin
    perform app_private.conclude_tournament('00000000-0000-4000-8000-000000005a11'::uuid, tournament_id);
    raise exception 'concluding an already-concluded tournament must raise P0002';
  exception when no_data_found then null;
  end;

  -- THE DURABLE RECORDS SURVIVE (§12.6).
  select count(*) into survives from public.giveaways where id = giveaway_id;
  if survives <> 1 then raise exception 'closing must not delete the giveaway record'; end if;
  select count(*) into survives from public.tournaments where id = tournament_id;
  if survives <> 1 then raise exception 'concluding must not delete the tournament record'; end if;

  -- AND THE OVERLAY HAS NOTHING TO PAINT -- no terminal state, no result.
  select count(*) into rows_seen from app_private.list_overlay_giveaway_tournament('00000000-0000-4000-8000-000000005a41'::uuid, 'prf02s6-giveaway-a-fingerprint');
  if rows_seen <> 0 then raise exception 'a closed giveaway and a concluded tournament must return zero rows -- current state, never a history, and never a terminal announcement; got %', rows_seen; end if;

  -- A new giveaway and a new tournament may now be opened: the partial
  -- unique indexes constrain only the LIVE ones.
  perform app_private.open_giveaway('00000000-0000-4000-8000-000000005a11'::uuid, current_timestamp + interval '15 minutes');
end
$$;

-- =====================================================================
-- G17.30 -- THE CREATOR-FACING READS ARE NEVER TIER-GATED AND NEVER LEAK
-- TO A NON-MEMBER. Every member role sees them; a stranger sees zero rows.
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
    select count(*) into rows_seen from app_private.list_channel_giveaway('00000000-0000-4000-8000-000000005a11'::uuid);
    if rows_seen <> 1 then raise exception 'member % must read the channel''s current giveaway, got % row(s)', probe.user_id, rows_seen; end if;
  end loop;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
  select count(*) into rows_seen from app_private.list_channel_giveaway('00000000-0000-4000-8000-000000005a11'::uuid);
  if rows_seen <> 0 then raise exception 'a non-member must read zero rows, got %', rows_seen; end if;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
  select count(*) into rows_seen from app_private.list_channel_tournament('00000000-0000-4000-8000-000000005a12'::uuid);
  if rows_seen <> 0 then raise exception 'a non-member must read zero tournament rows, got %', rows_seen; end if;
end
$$;

-- No write path and no creator read carries a tier call at all (§12.6).
do $$
declare definition text; fn text;
begin
  foreach fn in array array['open_giveaway', 'update_giveaway_entry_count', 'close_giveaway',
                            'list_channel_giveaway', 'start_tournament', 'set_tournament_progress',
                            'conclude_tournament', 'list_channel_tournament']
  loop
    select pg_catalog.pg_get_functiondef(p.oid)
      into definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname = fn;
    if position('events_pack_entitled' in definition) > 0 or position('current_channel_tier' in definition) > 0 then
      raise exception 'app_private.% must never be tier-gated -- storing, viewing and exporting a durable creator record is available at every tier (§12.6)', fn;
    end if;
  end loop;
end
$$;

-- =====================================================================
-- G17.31 -- MIGRATION 0142 IS ADDITIVE: it must not have touched 0131's
-- module catalogue check constraint, which already named
-- giveaway_tournament_card, and it must not have altered 0140's
-- lobby_sessions.
-- =====================================================================
do $$
declare has_key boolean;
begin
  select position('giveaway_tournament_card' in pg_get_constraintdef(c.oid)) > 0
    into has_key
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
   where t.relname = 'master_canvas_modules'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%module_key%'
   limit 1;
  if has_key is not true then
    raise exception 'giveaway_tournament_card must already be one of migration 0131''s catalogue keys -- this slice adds no key and alters no constraint';
  end if;
end
$$;

do $$
declare lobby_columns text;
begin
  select string_agg(column_name, ', ' order by ordinal_position)
    into lobby_columns
    from information_schema.columns
   where table_schema = 'public' and table_name = 'lobby_sessions';
  if lobby_columns <> 'id, channel_id, created_by_user_id, seat_count, confirmed_seat_count, queue_count, opened_at, closed_at, created_at, updated_at' then
    raise exception '0142 must REFERENCE 0140''s lobby_sessions, never alter it; its columns are now "%"', lobby_columns;
  end if;
end
$$;

select 'prf02_slice6_giveaway_tournament: all cases passed' as result;
