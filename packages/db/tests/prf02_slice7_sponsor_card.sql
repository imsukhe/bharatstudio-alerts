-- PRF-02 slice 7, §6 catalogue module #11 (Sponsor Card): tests for
-- app_private.upsert_sponsor_card, list_channel_sponsor_card and
-- list_overlay_sponsor_card (migration 0145).
--
-- This file owns id block ...5b00-...5bff (recorded in
-- fixtures/00_base_world.sql's ID ALLOCATION REGISTRY, following slice 6's
-- ...5a00-...5aff giveaway/tournament block). It seeds its OWN channels,
-- memberships and overlay sessions rather than reusing base_world's,
-- because the things under test include a SCHEDULE WINDOW and an ENABLED
-- flag, and an assertion another file can move is not an assertion.
--
-- THE TWO CASES THAT MATTER MOST:
--
--   SP11.18 -- STRUCTURAL PROOF NO COUNTER EXISTS. Every function this
--   migration ships is scanned (pg_get_functiondef) for count, impression,
--   exposure, views, shown_at, displayed_at, duration; every column of
--   public.sponsor_cards is scanned (information_schema.columns) for the
--   same tokens plus last_shown/last_display. No existing test could catch
--   a counter being added later by only reading a comment -- this is the
--   one that can.
--
--   SP11.13 -- THE OVERLAY RETURNED COLUMN SET is exactly
--   {sponsor_name, logo_mime_type, logo_storage_key}, asserted twice over:
--   from the catalogue (pg_get_function_result) and from a table
--   materialised out of a real call and read back through
--   information_schema.columns.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Fixture.
--   Channel A (...5b11) -- enabled, no schedule. The always-on case.
--   Channel B (...5b12) -- enabled, WITH a schedule window (checked both
--                          inside and outside it).
--   Channel C (...5b13) -- disabled. The "enabled gate" probe.
--   Channel D (...5b14) -- has no sponsor card row at all.
-- Users ...0001 (owner of A, C, D), ...0002 (owner of B) and the
-- non-owner/admin probes ...0003/...0004/...0005/...0006 come from
-- base_world.
-- ---------------------------------------------------------------------
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005d11', '00000000-0000-4000-8000-000000000001', 'sponsor_a', 'Sponsor A', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005d12', '00000000-0000-4000-8000-000000000002', 'sponsor_b', 'Sponsor B', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005d13', '00000000-0000-4000-8000-000000000001', 'sponsor_c', 'Sponsor C', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005d14', '00000000-0000-4000-8000-000000000001', 'sponsor_d', 'Sponsor D', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000005d11', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005d11', '00000000-0000-4000-8000-000000000003', 'admin', current_timestamp),
  ('00000000-0000-4000-8000-000000005d11', '00000000-0000-4000-8000-000000000004', 'operator', current_timestamp),
  ('00000000-0000-4000-8000-000000005d11', '00000000-0000-4000-8000-000000000005', 'moderator', current_timestamp),
  ('00000000-0000-4000-8000-000000005d11', '00000000-0000-4000-8000-000000000006', 'viewer', current_timestamp),
  ('00000000-0000-4000-8000-000000005d12', '00000000-0000-4000-8000-000000000002', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005d13', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005d14', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

-- Overlay sessions: good ones for A/B/C, an expired one for A, a revoked
-- one for A, and none at all for D (which has no card either).
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values
  ('00000000-0000-4000-8000-000000005d41', '00000000-0000-4000-8000-000000005d11', 'prf02s7-sponsor-a-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005d42', '00000000-0000-4000-8000-000000005d12', 'prf02s7-sponsor-b-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005d43', '00000000-0000-4000-8000-000000005d13', 'prf02s7-sponsor-c-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005d44', '00000000-0000-4000-8000-000000005d11', 'prf02s7-sponsor-expired-fingerprint', current_timestamp - interval '1 minute', current_timestamp - interval '2 hours');

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at, revoked_at)
values
  ('00000000-0000-4000-8000-000000005d45', '00000000-0000-4000-8000-000000005d11', 'prf02s7-sponsor-revoked-fingerprint', current_timestamp + interval '1 hour', current_timestamp, current_timestamp);

-- =====================================================================
-- SP11.1 -- an owner can write a sponsor card, and it is recorded.
-- =====================================================================
do $$
declare card_id uuid;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  select app_private.upsert_sponsor_card(
    '00000000-0000-4000-8000-000000005d11'::uuid, 'Acme Energy Drinks',
    null, null, null, true, null, null
  ) into card_id;
  if card_id is null then raise exception 'SP11.1: upsert_sponsor_card returned null'; end if;
end
$$;

-- =====================================================================
-- SP11.2 -- a non-owner/admin cannot write it (42501), nothing changed.
-- =====================================================================
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000006', true); -- viewer
  begin
    perform app_private.upsert_sponsor_card(
      '00000000-0000-4000-8000-000000005d11'::uuid, 'Hijacked Sponsor',
      null, null, null, true, null, null
    );
    raise exception 'SP11.2: a viewer was able to write a sponsor card';
  exception when others then
    if sqlstate <> '42501' then raise exception 'SP11.2: expected 42501, got %', sqlstate; end if;
  end;
end
$$;

do $$
declare current_name text;
begin
  select sponsor_name into current_name from public.sponsor_cards where channel_id = '00000000-0000-4000-8000-000000005d11';
  if current_name <> 'Acme Energy Drinks' then
    raise exception 'SP11.2: the unauthorized write must not have changed anything, got %', current_name;
  end if;
end
$$;

-- =====================================================================
-- SP11.3 -- a sponsor name outside 1-120 characters is refused (22023).
-- =====================================================================
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  begin
    perform app_private.upsert_sponsor_card('00000000-0000-4000-8000-000000005d11'::uuid, '', null, null, null, true, null, null);
    raise exception 'SP11.3: an empty sponsor name was accepted';
  exception when others then
    if sqlstate <> '22023' then raise exception 'SP11.3: expected 22023 for empty name, got %', sqlstate; end if;
  end;

  begin
    perform app_private.upsert_sponsor_card('00000000-0000-4000-8000-000000005d11'::uuid, repeat('x', 121), null, null, null, true, null, null);
    raise exception 'SP11.3: a 121-character sponsor name was accepted';
  exception when others then
    if sqlstate <> '22023' then raise exception 'SP11.3: expected 22023 for a 121-char name, got %', sqlstate; end if;
  end;
end
$$;

-- =====================================================================
-- SP11.4 -- calling the write function twice upserts the same row.
-- =====================================================================
do $$
declare first_id uuid; second_id uuid; row_count integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  select app_private.upsert_sponsor_card('00000000-0000-4000-8000-000000005d11'::uuid, 'Acme Energy Drinks', null, null, null, true, null, null) into first_id;
  select app_private.upsert_sponsor_card('00000000-0000-4000-8000-000000005d11'::uuid, 'Acme Energy Drinks V2', null, null, null, true, null, null) into second_id;
  if first_id <> second_id then raise exception 'SP11.4: two writes to the same channel produced two different ids'; end if;

  select count(*) into row_count from public.sponsor_cards where channel_id = '00000000-0000-4000-8000-000000005d11';
  if row_count <> 1 then raise exception 'SP11.4: expected exactly one row for the channel, found %', row_count; end if;
end
$$;

-- =====================================================================
-- SP11.5 -- a schedule with only one instant set is refused (22023).
-- =====================================================================
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  begin
    perform app_private.upsert_sponsor_card(
      '00000000-0000-4000-8000-000000005d11'::uuid, 'Acme Energy Drinks',
      null, null, null, true, current_timestamp, null
    );
    raise exception 'SP11.5: a schedule with only a start instant was accepted';
  exception when others then
    if sqlstate <> '22023' then raise exception 'SP11.5: expected 22023, got %', sqlstate; end if;
  end;
end
$$;

-- =====================================================================
-- SP11.6 -- a schedule whose end is not after its start is refused.
-- =====================================================================
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  begin
    perform app_private.upsert_sponsor_card(
      '00000000-0000-4000-8000-000000005d11'::uuid, 'Acme Energy Drinks',
      null, null, null, true, current_timestamp, current_timestamp - interval '1 minute'
    );
    raise exception 'SP11.6: a schedule ending before it starts was accepted';
  exception when others then
    if sqlstate <> '22023' then raise exception 'SP11.6: expected 22023, got %', sqlstate; end if;
  end;
end
$$;

-- =====================================================================
-- SP11.7 -- logo metadata must be all-null or all-non-null.
-- =====================================================================
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  begin
    perform app_private.upsert_sponsor_card(
      '00000000-0000-4000-8000-000000005d11'::uuid, 'Acme Energy Drinks',
      repeat('a', 64), null, null, true, null, null
    );
    raise exception 'SP11.7: a sha256 with no mime type or byte size was accepted';
  exception when others then
    if sqlstate <> '22023' then raise exception 'SP11.7: expected 22023, got %', sqlstate; end if;
  end;
end
$$;

-- =====================================================================
-- SP11.8 -- a malformed sha256 is refused.
-- =====================================================================
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  begin
    perform app_private.upsert_sponsor_card(
      '00000000-0000-4000-8000-000000005d11'::uuid, 'Acme Energy Drinks',
      'not-a-valid-sha256', 'image/png', 1024, true, null, null
    );
    raise exception 'SP11.8: a malformed sha256 was accepted';
  exception when others then
    if sqlstate <> '22023' then raise exception 'SP11.8: expected 22023, got %', sqlstate; end if;
  end;
end
$$;

-- =====================================================================
-- SP11.9 -- the logo storage key is GENERATED and equals
-- channel_id || '/' || logo_content_sha256.
-- =====================================================================
do $$
declare seen_key text; expected_key text; expected_hash text;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  expected_hash := repeat('ab', 32); -- 64 lowercase hex characters
  perform app_private.upsert_sponsor_card(
    '00000000-0000-4000-8000-000000005d11'::uuid, 'Acme Energy Drinks',
    expected_hash, 'image/png', 4096, true, null, null
  );
  select logo_storage_key into seen_key from public.sponsor_cards where channel_id = '00000000-0000-4000-8000-000000005d11';
  expected_key := '00000000-0000-4000-8000-000000005d11/' || expected_hash;
  if seen_key <> expected_key then
    raise exception 'SP11.9: expected generated key %, got %', expected_key, seen_key;
  end if;
end
$$;

do $$
begin
  begin
    execute 'update public.sponsor_cards set logo_storage_key = ''hijacked'' where channel_id = ''00000000-0000-4000-8000-000000005d11''';
    raise exception 'SP11.9: logo_storage_key must not be independently writable -- it is a generated column';
  exception when others then
    null; -- PostgreSQL raises for writing a generated column; any error here is the expected outcome.
  end;
end
$$;

-- =====================================================================
-- SP11.10 -- sponsor_card is already one of 0131's twenty catalogue
-- keys; this migration adds no key and alters no constraint.
-- =====================================================================
do $$
declare has_key boolean;
begin
  select position('sponsor_card' in pg_get_constraintdef(c.oid)) > 0
    into has_key
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
   where t.relname = 'master_canvas_modules'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%module_key%'
   limit 1;
  if has_key is not true then
    raise exception 'SP11.10: sponsor_card must already be one of migration 0131''s catalogue keys -- this slice adds no key and alters no constraint';
  end if;
end
$$;

-- =====================================================================
-- SP11.11 -- no function this migration ships reads a tier or calls an
-- entitlement function. §12.6: storing, viewing and changing a durable
-- creator record is never tier-gated.
-- =====================================================================
do $$
declare definition text; forbidden text; fn text;
begin
  foreach fn in array array['upsert_sponsor_card', 'list_channel_sponsor_card', 'list_overlay_sponsor_card']
  loop
    select pg_catalog.pg_get_functiondef(p.oid)
      into definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname = fn;
    if definition is null then raise exception 'SP11.11: app_private.% does not exist', fn; end if;

    foreach forbidden in array array['tier_entitlement', 'events_pack_entitled', '.tier', 'tier_rank', 'tier_master_canvas']
    loop
      if position(forbidden in definition) > 0 then
        raise exception 'SP11.11: app_private.% contains a "%" token -- storing, viewing and changing a durable creator record is never tier-gated (§12.6); no second tier gate exists for the Sponsor Card', fn, forbidden;
      end if;
    end loop;
  end loop;
end
$$;

-- =====================================================================
-- SP11.18 -- STRUCTURAL PROOF NO COUNTER EXISTS. Every function this
-- migration ships is scanned for count/impression/exposure/views/
-- shown_at/displayed_at/duration; every column of public.sponsor_cards
-- is scanned for the same plus last_shown/last_display.
--
-- 'account' and 'accounting' are not banned tokens (they never appear
-- here); the exact forbidden substrings are the ones the task itself
-- names. 'discount'/'recount' style false positives are avoided by
-- matching 'count' only where this migration would actually introduce a
-- COUNTER concept -- and it introduces none, so the plain substring is
-- safe to use unqualified against a file with no other use of it.
-- =====================================================================
do $$
declare definition text; forbidden text; fn text;
begin
  foreach fn in array array['upsert_sponsor_card', 'list_channel_sponsor_card', 'list_overlay_sponsor_card']
  loop
    select pg_catalog.pg_get_functiondef(p.oid)
      into definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname = fn;
    if definition is null then raise exception 'SP11.18: app_private.% does not exist', fn; end if;

    foreach forbidden in array array['count', 'impression', 'exposure', 'views', 'shown_at', 'displayed_at', 'duration']
    loop
      if position(forbidden in definition) > 0 then
        raise exception 'SP11.18: app_private.% contains a "%" token -- the Sponsor Card renders and counts NOTHING (2026-09-17 decision); no column, function, event or log line may count, time or accumulate anything about the card being displayed', fn, forbidden;
      end if;
    end loop;
  end loop;
end
$$;

do $$
declare offending text;
begin
  select string_agg(column_name, ', ' order by column_name)
    into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'sponsor_cards'
     and (column_name like '%count%' or column_name like '%impression%' or column_name like '%exposure%'
          or column_name like '%view%' or column_name like '%shown%' or column_name like '%display%'
          or column_name like '%duration%');
  if offending is not null then
    raise exception 'SP11.18: public.sponsor_cards must not carry a count, impression, exposure, view, shown, display or duration column of any kind; found: %', offending;
  end if;
end
$$;

-- =====================================================================
-- SP11.19 -- no column on public.sponsor_cards is a bytea. The logo is
-- metadata only, per §19.1.
-- =====================================================================
do $$
declare offending text;
begin
  select string_agg(column_name, ', ' order by column_name)
    into offending
    from information_schema.columns
   where table_schema = 'public' and table_name = 'sponsor_cards' and udt_name = 'bytea';
  if offending is not null then
    raise exception 'SP11.19: public.sponsor_cards must not store any column as bytea -- the logo is metadata only (§19.1: GCS/CDN for bytes); found: %', offending;
  end if;
end
$$;

-- Also: no url/href/src-shaped column -- §9.1.1, no field capable of
-- carrying a third-party URL onto the Master Canvas.
do $$
declare offending text;
begin
  select string_agg(column_name, ', ' order by column_name)
    into offending
    from information_schema.columns
   where table_schema = 'public' and table_name = 'sponsor_cards'
     and (column_name like '%url%' or column_name like '%href%' or column_name = 'src' or column_name like '%_src');
  if offending is not null then
    raise exception 'SP11.19: public.sponsor_cards must not carry a URL-shaped column (§9.1.1) -- the logo is an asset reference, not a fetchable third-party URL; found: %', offending;
  end if;
end
$$;

-- =====================================================================
-- Set up the overlay-read fixtures now that the write path is proven.
-- Channel A: enabled, no schedule.
-- Channel B: enabled, WITH a schedule (currently inside it).
-- Channel C: disabled.
-- =====================================================================
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  perform app_private.upsert_sponsor_card(
    '00000000-0000-4000-8000-000000005d11'::uuid, 'Acme Energy Drinks',
    repeat('ab', 32), 'image/png', 4096, true, null, null
  );

  perform app_private.upsert_sponsor_card(
    '00000000-0000-4000-8000-000000005d13'::uuid, 'Disabled Sponsor',
    null, null, null, false, null, null
  );
end
$$;

do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', true);
  perform app_private.upsert_sponsor_card(
    '00000000-0000-4000-8000-000000005d12'::uuid, 'Scheduled Sponsor',
    null, null, null, true, current_timestamp - interval '1 hour', current_timestamp + interval '1 hour'
  );
end
$$;

-- =====================================================================
-- SP11.12 -- a valid overlay session on an enabled, no-schedule channel
-- returns exactly one row of the three declared fields.
-- =====================================================================
do $$
declare seen record;
begin
  select * into seen from app_private.list_overlay_sponsor_card(
    '00000000-0000-4000-8000-000000005d41'::uuid, 'prf02s7-sponsor-a-fingerprint'
  );
  if seen.sponsor_name is distinct from 'Acme Energy Drinks' then
    raise exception 'SP11.12: expected sponsor_name Acme Energy Drinks, got %', seen.sponsor_name;
  end if;
  if seen.logo_mime_type is distinct from 'image/png' then
    raise exception 'SP11.12: expected logo_mime_type image/png, got %', seen.logo_mime_type;
  end if;
  if seen.logo_storage_key is distinct from ('00000000-0000-4000-8000-000000005d11/' || repeat('ab', 32)) then
    raise exception 'SP11.12: unexpected logo_storage_key %', seen.logo_storage_key;
  end if;
end
$$;

-- =====================================================================
-- SP11.13 -- THE RETURNED COLUMN SET IS EXACTLY THREE FIELDS, EVER.
-- =====================================================================
do $$
declare declared_result text;
begin
  select pg_catalog.pg_get_function_result(p.oid)
    into declared_result
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_sponsor_card';

  if declared_result is null then raise exception 'SP11.13: app_private.list_overlay_sponsor_card does not exist'; end if;
  if declared_result <> 'TABLE(sponsor_name text, logo_mime_type text, logo_storage_key text)' then
    raise exception 'SP11.13: the overlay sponsor-card read must return exactly sponsor_name, logo_mime_type, logo_storage_key. Declared result is "%"', declared_result;
  end if;
end
$$;

create temporary table prf02s7_sponsor_returned_shape as
  select * from app_private.list_overlay_sponsor_card('00000000-0000-4000-8000-000000005d41'::uuid, 'prf02s7-sponsor-a-fingerprint');

do $$
declare actual_columns text;
begin
  select string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position)
    into actual_columns
    from information_schema.columns
   where table_name = 'prf02s7_sponsor_returned_shape';

  if actual_columns <> 'sponsor_name text, logo_mime_type text, logo_storage_key text' then
    raise exception 'SP11.13: the columns actually returned by a live call must be exactly the three declared fields, got "%"', actual_columns;
  end if;
end
$$;

-- =====================================================================
-- SP11.14 -- enabled = false returns zero rows.
-- =====================================================================
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.list_overlay_sponsor_card(
    '00000000-0000-4000-8000-000000005d43'::uuid, 'prf02s7-sponsor-c-fingerprint'
  );
  if row_count <> 0 then raise exception 'SP11.14: a disabled sponsor card must return zero rows, got %', row_count; end if;
end
$$;

-- =====================================================================
-- SP11.15 -- outside the schedule window returns zero rows; inside it
-- returns one row.
-- =====================================================================
do $$
declare row_count integer;
begin
  -- Channel B's window is [-1h, +1h] around now, so "now" is inside it.
  select count(*) into row_count from app_private.list_overlay_sponsor_card(
    '00000000-0000-4000-8000-000000005d42'::uuid, 'prf02s7-sponsor-b-fingerprint'
  );
  if row_count <> 1 then raise exception 'SP11.15: inside the schedule window must return one row, got %', row_count; end if;
end
$$;

do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', true);
  -- Move the window to entirely the past.
  perform app_private.upsert_sponsor_card(
    '00000000-0000-4000-8000-000000005d12'::uuid, 'Scheduled Sponsor',
    null, null, null, true, current_timestamp - interval '3 hours', current_timestamp - interval '2 hours'
  );
end
$$;

do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.list_overlay_sponsor_card(
    '00000000-0000-4000-8000-000000005d42'::uuid, 'prf02s7-sponsor-b-fingerprint'
  );
  if row_count <> 0 then raise exception 'SP11.15: outside the schedule window must return zero rows, got %', row_count; end if;
end
$$;

-- =====================================================================
-- SP11.16 -- no schedule at all means always visible while enabled.
-- Channel A already has no schedule and is enabled; re-assert here as its
-- own case rather than piggybacking on SP11.12.
-- =====================================================================
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.list_overlay_sponsor_card(
    '00000000-0000-4000-8000-000000005d41'::uuid, 'prf02s7-sponsor-a-fingerprint'
  );
  if row_count <> 1 then raise exception 'SP11.16: a card with no schedule must be visible while enabled, got % rows', row_count; end if;
end
$$;

-- =====================================================================
-- SP11.17 -- a bad, foreign, expired or revoked overlay token returns
-- zero rows.
-- =====================================================================
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.list_overlay_sponsor_card(
    '00000000-0000-4000-8000-000000005d41'::uuid, 'wrong-fingerprint-entirely'
  );
  if row_count <> 0 then raise exception 'SP11.17: a wrong fingerprint must return zero rows, got %', row_count; end if;

  select count(*) into row_count from app_private.list_overlay_sponsor_card(
    '00000000-0000-4000-8000-000000005d44'::uuid, 'prf02s7-sponsor-expired-fingerprint'
  );
  if row_count <> 0 then raise exception 'SP11.17: an expired session must return zero rows, got %', row_count; end if;

  select count(*) into row_count from app_private.list_overlay_sponsor_card(
    '00000000-0000-4000-8000-000000005d45'::uuid, 'prf02s7-sponsor-revoked-fingerprint'
  );
  if row_count <> 0 then raise exception 'SP11.17: a revoked session must return zero rows, got %', row_count; end if;

  -- A perfectly valid token for a channel with NO sponsor card row at all.
  insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
  values ('00000000-0000-4000-8000-000000005d46', '00000000-0000-4000-8000-000000005d14', 'prf02s7-sponsor-d-fingerprint', current_timestamp + interval '1 hour', current_timestamp);
  select count(*) into row_count from app_private.list_overlay_sponsor_card(
    '00000000-0000-4000-8000-000000005d46'::uuid, 'prf02s7-sponsor-d-fingerprint'
  );
  if row_count <> 0 then raise exception 'SP11.17: a channel with no sponsor card must return zero rows, got %', row_count; end if;
end
$$;

-- =====================================================================
-- MIGRATION 0145 IS ADDITIVE: it must not have touched 0131's module
-- catalogue check constraint beyond already naming sponsor_card.
-- =====================================================================
do $$
declare module_columns text;
begin
  select string_agg(column_name, ', ' order by ordinal_position)
    into module_columns
    from information_schema.columns
   where table_schema = 'public' and table_name = 'master_canvas_modules';
  if module_columns <> 'id, channel_id, module_key, enabled, created_at, updated_at' then
    raise exception '0145 must REFERENCE 0131''s master_canvas_modules, never alter it; its columns are now "%"', module_columns;
  end if;
end
$$;

select 'prf02_slice7_sponsor_card: all cases passed' as result;
