-- PRF-02 slice 6, §6 catalogue module #5 (Reaction Cloud) and PRF-06's
-- reactions half: app_private.record_channel_reaction and
-- app_private.list_overlay_reaction_cloud (migration 0139).
--
-- This file owns id block ...5700-...57ff (recorded in
-- fixtures/00_base_world.sql's ID ALLOCATION REGISTRY). It seeds its OWN
-- channels, catalogue entries and packs rather than reusing base_world's
-- ...0011/...0012, because the things under test are COUNTS and a count
-- assertion another file can move is not an assertion. Every row counted
-- here is a row this file inserted.
--
-- THE TWO CASES THAT MATTER MOST:
--
--   S6.16 -- THE RETURNED COLUMN SET. §6 #5's "non-identifying" is
--   required to be a property of the QUERY, not of the renderer, so it is
--   asserted twice over: from the catalogue (pg_get_function_result) and
--   from a table materialised out of a real call and read back through
--   information_schema.columns. Adding ANY column -- a viewer id, an
--   anonymous identity token, a session id, an IP, or even a
--   harmless-looking created_at -- turns this file red by name. That is
--   the negative test recorded in
--   bharatstudio-requirements/reviews/2026-09-16-prf-02-slice-6-reaction-cloud-decisions.md.
--
--   S6.20 -- SAMPLING IS SERVER-SIDE. §19.5 requires the cloud to show "a
--   representative sample, never every event", "sampled and rate-limited
--   server-side BEFORE they reach the canvas". The ceiling is asserted
--   against what the FUNCTION returns, not against what a renderer draws:
--   with a ceiling of k the function returns at most k rows even though
--   more distinct entries have reactions, and the rows it returns are the
--   top k by count.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Fixture.
--   Channel A (...5711) -- creator tier, the channel under test.
--   Channel B (...5712) -- creator tier, the cross-channel probe.
--   Channel C (...5713) -- FREE tier, so a pro-tier catalogue entry is
--                          ineligible and creator_pack_tier_limit is 0.
-- ---------------------------------------------------------------------
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005711', '00000000-0000-4000-8000-000000000001', 'reaction_a', 'Reaction A', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005712', '00000000-0000-4000-8000-000000000002', 'reaction_b', 'Reaction B', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005713', '00000000-0000-4000-8000-000000000001', 'reaction_c', 'Reaction C', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000005711', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005712', '00000000-0000-4000-8000-000000000002', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005713', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

-- Version 1 of each config carries NO queue.rateLimitPerMinute. That is
-- deliberate: the unconfigured case (S6.11) is the FIRST thing asserted,
-- so the later rate-limit cases cannot pass by accident of ordering.
insert into channel_configs (channel_id, version, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000005711', 1, '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005712', 1, '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005713', 1, '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000005711', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005712', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005713', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- Platform catalogue entries (0110). Synthetic two-byte Lottie stand-ins:
-- nothing here reads the bytes, and this slice adds no asset of its own.
insert into sticker_catalogue_entries (id, external_key, display_name, category, min_tier, asset_bytes, mime_type, content_sha256, imported_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005721', 'rc_clap', 'Aaa Clap', 'reactions', 'free', decode('7b7d', 'hex'), 'application/json', '1111111111111111111111111111111111111111111111111111111111111111', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005722', 'rc_fire', 'Bbb Fire', 'reactions', 'free', decode('7b7d', 'hex'), 'application/json', '2222222222222222222222222222222222222222222222222222222222222222', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005723', 'rc_confetti', 'Ccc Confetti', 'reactions', 'pro', decode('7b7d', 'hex'), 'application/json', '3333333333333333333333333333333333333333333333333333333333333333', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005724', 'rc_heart', 'Ddd Heart', 'reactions', 'free', decode('7b7d', 'hex'), 'application/json', '4444444444444444444444444444444444444444444444444444444444444444', current_timestamp, current_timestamp)
on conflict (id) do nothing;

-- Channel A turned Ddd Heart off. Presence of the row means disabled
-- (0110's own presence-based control, reused unchanged).
insert into channel_sticker_disables (channel_id, sticker_id, disabled_at)
values ('00000000-0000-4000-8000-000000005711', '00000000-0000-4000-8000-000000005724', current_timestamp)
on conflict (channel_id, sticker_id) do nothing;

-- Creator packs (0119). One reviewed and active on A, one still awaiting
-- staff review on A, one belonging to B.
insert into creator_sticker_packs (id, channel_id, display_name, category, asset_bytes, mime_type, content_sha256, creator_attested, status, enabled, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005731', '00000000-0000-4000-8000-000000005711', 'Eee Pack Star', 'reactions', decode('7b7d', 'hex'), 'application/json', '5555555555555555555555555555555555555555555555555555555555555555', true, 'active', true, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005732', '00000000-0000-4000-8000-000000005711', 'Fff Pack Pending', 'reactions', decode('7b7d', 'hex'), 'application/json', '6666666666666666666666666666666666666666666666666666666666666666', true, 'pending_review', true, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005733', '00000000-0000-4000-8000-000000005712', 'Ggg Pack Other', 'reactions', decode('7b7d', 'hex'), 'application/json', '7777777777777777777777777777777777777777777777777777777777777777', true, 'active', true, current_timestamp, current_timestamp)
on conflict (id) do nothing;

-- Four overlay sessions: a good one for A, a good one for B, an expired
-- one for A and a revoked one for A. The last three are S6.17.
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values
  ('00000000-0000-4000-8000-000000005741', '00000000-0000-4000-8000-000000005711', 'prf02s6-a-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005742', '00000000-0000-4000-8000-000000005712', 'prf02s6-b-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005743', '00000000-0000-4000-8000-000000005711', 'prf02s6-expired-fingerprint', current_timestamp - interval '1 minute', current_timestamp - interval '2 hours');

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at, revoked_at)
values
  ('00000000-0000-4000-8000-000000005744', '00000000-0000-4000-8000-000000005711', 'prf02s6-revoked-fingerprint', current_timestamp + interval '1 hour', current_timestamp, current_timestamp);

-- =====================================================================
-- S6.8 -- EXACTLY ONE OF sticker_id / pack_sticker_id, ENFORCED BY THE
-- DATABASE. A reaction is ONE entry; the check constraint, not the
-- application, is where that stays true.
-- =====================================================================
do $$
begin
  begin
    insert into public.channel_reaction_sends (id, channel_id, sticker_id, pack_sticker_id)
    values (gen_random_uuid(), '00000000-0000-4000-8000-000000005711', '00000000-0000-4000-8000-000000005721', '00000000-0000-4000-8000-000000005731');
    raise exception 'a reaction naming BOTH a catalogue entry and a pack entry must violate channel_reaction_sends_exactly_one_entry';
  exception when check_violation then null;
  end;
  begin
    insert into public.channel_reaction_sends (id, channel_id, sticker_id, pack_sticker_id)
    values (gen_random_uuid(), '00000000-0000-4000-8000-000000005711', null, null);
    raise exception 'a reaction naming NEITHER entry must violate channel_reaction_sends_exactly_one_entry';
  exception when check_violation then null;
  end;
end
$$;

-- =====================================================================
-- S6.7 -- AN UNRECOGNISED ENTRY SOURCE RAISES RATHER THAN SILENTLY
-- CHOOSING ONE.
-- =====================================================================
do $$
begin
  begin
    perform app_private.record_channel_reaction('00000000-0000-4000-8000-000000005711', 'emoji', '00000000-0000-4000-8000-000000005721');
    raise exception 'an unrecognised entry source must raise';
  exception when invalid_parameter_value then null;
  end;
end
$$;

-- =====================================================================
-- S6.3 / S6.4 / S6.5 / S6.6 -- EVERY REJECTION IS EXPLICIT, AND NOTHING
-- IS INSERTED. A viewer can only ever land an id the channel's OWN live
-- enabled + tier-eligible set contains at the moment of the send.
-- =====================================================================
do $$
declare outcome text; sends bigint;
begin
  -- S6.3: an id in neither catalogue.
  outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005711', 'catalogue', '00000000-0000-4000-8000-0000000057ff');
  if outcome <> 'unknown_entry' then raise exception 'an unknown catalogue id must be unknown_entry, got %', outcome; end if;

  -- S6.4: an entry the creator turned OFF for this channel.
  outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005711', 'catalogue', '00000000-0000-4000-8000-000000005724');
  if outcome <> 'not_available' then raise exception 'a creator-disabled entry must be not_available, got %', outcome; end if;

  -- S6.5: a pro-tier entry on a free channel.
  outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005713', 'catalogue', '00000000-0000-4000-8000-000000005723');
  if outcome <> 'not_available' then raise exception 'a tier-ineligible entry must be not_available, got %', outcome; end if;

  -- S6.6: another channel's pack sticker, addressed from channel A.
  outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005711', 'creator_pack', '00000000-0000-4000-8000-000000005733');
  if outcome <> 'unknown_entry' then raise exception 'another channel''s pack entry must be unknown_entry, got %', outcome; end if;

  -- A pack sticker still awaiting staff review is not sendable either.
  outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005711', 'creator_pack', '00000000-0000-4000-8000-000000005732');
  if outcome <> 'not_available' then raise exception 'a pending_review pack entry must be not_available, got %', outcome; end if;

  -- creator_pack_tier_limit('free') is 0, so a free channel has no pack
  -- slots at all -- 0119's own rule, reused unchanged.
  outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005713', 'creator_pack', '00000000-0000-4000-8000-000000005731');
  if outcome <> 'unknown_entry' then raise exception 'a pack entry belonging to another channel must be unknown_entry, got %', outcome; end if;

  select count(*) into sends from public.channel_reaction_sends;
  if sends <> 0 then raise exception 'a rejected reaction must insert nothing; found % row(s)', sends; end if;
end
$$;

-- =====================================================================
-- S6.1 / S6.2 / S6.11 -- A GOOD SEND IS RECORDED, FROM EITHER HALF OF
-- THE CURATED CATALOGUE, AND WITH NO rateLimitPerMinute CONFIGURED THERE
-- IS NO LIMIT (0032/0063's own fallback, reused rather than replaced by a
-- guessed default).
-- =====================================================================
do $$
declare outcome text; sends bigint; i integer;
begin
  outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005711', 'catalogue', '00000000-0000-4000-8000-000000005721');
  if outcome <> 'recorded' then raise exception 'a valid catalogue reaction must be recorded, got %', outcome; end if;

  outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005711', 'creator_pack', '00000000-0000-4000-8000-000000005731');
  if outcome <> 'recorded' then raise exception 'a valid creator-pack reaction must be recorded, got %', outcome; end if;

  -- Twenty more on an unconfigured channel. If an invented default limit
  -- had crept in anywhere, this loop is where it would surface.
  for i in 1..20 loop
    outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005711', 'catalogue', '00000000-0000-4000-8000-000000005722');
    if outcome <> 'recorded' then raise exception 'with no rateLimitPerMinute configured there must be NO limit; send % returned %', i, outcome; end if;
  end loop;

  select count(*) into sends from public.channel_reaction_sends;
  if sends <> 22 then raise exception 'expected 22 recorded reactions, got %', sends; end if;
end
$$;

-- =====================================================================
-- S6.15 -- THE OVERLAY READ AGGREGATES, AND ORDERS DETERMINISTICALLY.
-- Bbb Fire has 20, Aaa Clap 1, Eee Pack Star 1 -- so the ordering exercises
-- the count key AND the display_name tiebreak at once.
-- =====================================================================
do $$
declare shape text;
begin
  select string_agg(entry_source || ':' || display_name || '=' || reaction_count, ' | ')
    into shape
    from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005741'::uuid, 'prf02s6-a-fingerprint', null);
  if shape <> 'catalogue:Bbb Fire=20 | catalogue:Aaa Clap=1 | creator_pack:Eee Pack Star=1' then
    raise exception 'unexpected cloud shape: %', shape;
  end if;
end
$$;

-- =====================================================================
-- S6.19 -- A CROSS-CHANNEL REACTION IS NEVER COUNTED. Channel B's own
-- session sees only channel B, and channel A's cloud is unchanged by it.
-- =====================================================================
do $$
declare outcome text; rows_b bigint; total_a bigint;
begin
  outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005712', 'creator_pack', '00000000-0000-4000-8000-000000005733');
  if outcome <> 'recorded' then raise exception 'channel B''s own pack reaction must be recorded, got %', outcome; end if;

  select count(*) into rows_b from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005742'::uuid, 'prf02s6-b-fingerprint', null);
  if rows_b <> 1 then raise exception 'channel B must see exactly its own one entry, got % row(s)', rows_b; end if;

  select coalesce(sum(reaction_count), 0) into total_a
    from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005741'::uuid, 'prf02s6-a-fingerprint', null);
  if total_a <> 22 then raise exception 'channel A''s total must stay 22 after channel B reacted, got %', total_a; end if;
end
$$;

-- =====================================================================
-- S6.17 -- A BAD, FOREIGN, EXPIRED OR REVOKED TOKEN RETURNS ZERO ROWS.
-- Never an error, and never another channel's cloud.
-- =====================================================================
do $$
declare rows_seen bigint;
begin
  select count(*) into rows_seen from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005741'::uuid, 'wrong-fingerprint', null);
  if rows_seen <> 0 then raise exception 'a wrong fingerprint must return zero rows, got %', rows_seen; end if;

  select count(*) into rows_seen from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005742'::uuid, 'prf02s6-a-fingerprint', null);
  if rows_seen <> 0 then raise exception 'channel A''s token against channel B''s session must return zero rows, got %', rows_seen; end if;

  select count(*) into rows_seen from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005743'::uuid, 'prf02s6-expired-fingerprint', null);
  if rows_seen <> 0 then raise exception 'an expired session must return zero rows, got %', rows_seen; end if;

  select count(*) into rows_seen from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005744'::uuid, 'prf02s6-revoked-fingerprint', null);
  if rows_seen <> 0 then raise exception 'a revoked session must return zero rows, got %', rows_seen; end if;

  select count(*) into rows_seen from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-0000000057fe'::uuid, 'prf02s6-a-fingerprint', null);
  if rows_seen <> 0 then raise exception 'an unknown overlay id must return zero rows, got %', rows_seen; end if;
end
$$;

-- =====================================================================
-- S6.20 / S6.21 / S6.22 -- SAMPLING IS SERVER-SIDE.
--
-- Asserted against what the FUNCTION returns, because §19.5's rule is that
-- the client is never sent the full stream and then told to drop some. A
-- renderer that happened to draw fewer glyphs would prove nothing here.
-- =====================================================================
do $$
declare rows_seen bigint; top_name text;
begin
  -- Three distinct entries have reactions on channel A.
  select count(*) into rows_seen from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005741'::uuid, 'prf02s6-a-fingerprint', null);
  if rows_seen <> 3 then raise exception 'an UNSET ceiling must impose no limit; expected 3 rows, got %', rows_seen; end if;

  -- A ceiling of 1 returns one row, and it is the top one by count.
  select count(*) into rows_seen from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005741'::uuid, 'prf02s6-a-fingerprint', 1);
  if rows_seen <> 1 then raise exception 'a ceiling of 1 must return exactly one row, got %', rows_seen; end if;
  select display_name into top_name from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005741'::uuid, 'prf02s6-a-fingerprint', 1);
  if top_name <> 'Bbb Fire' then raise exception 'the sampled row must be the top entry by count, got %', top_name; end if;

  -- A ceiling of 2 returns the top two, still fewer than the three that exist.
  select count(*) into rows_seen from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005741'::uuid, 'prf02s6-a-fingerprint', 2);
  if rows_seen <> 2 then raise exception 'a ceiling of 2 must return exactly two rows, got %', rows_seen; end if;

  -- A ceiling larger than the set is not an error, it is simply not binding.
  select count(*) into rows_seen from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005741'::uuid, 'prf02s6-a-fingerprint', 99);
  if rows_seen <> 3 then raise exception 'a non-binding ceiling must return every row, got %', rows_seen; end if;

  -- S6.22: below 1 fails CLOSED. Never open.
  select count(*) into rows_seen from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005741'::uuid, 'prf02s6-a-fingerprint', 0);
  if rows_seen <> 0 then raise exception 'a ceiling below 1 must fail closed with zero rows, got %', rows_seen; end if;
  select count(*) into rows_seen from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005741'::uuid, 'prf02s6-a-fingerprint', -5);
  if rows_seen <> 0 then raise exception 'a negative ceiling must fail closed with zero rows, got %', rows_seen; end if;
end
$$;

-- =====================================================================
-- S6.18 -- THE READ IS WINDOWED, NOT A HISTORY (§12.7). The window is the
-- SAME `interval '1 minute'` 0032/0063 already decided -- no second
-- interval was invented for this read.
-- =====================================================================
update public.channel_reaction_sends
   set created_at = current_timestamp - interval '2 minutes'
 where channel_id = '00000000-0000-4000-8000-000000005711'
   and sticker_id = '00000000-0000-4000-8000-000000005722';

do $$
declare rows_seen bigint; total bigint;
begin
  select count(*), coalesce(sum(reaction_count), 0) into rows_seen, total
    from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005741'::uuid, 'prf02s6-a-fingerprint', null);
  if rows_seen <> 2 then raise exception 'reactions older than the one-minute window must drop out; expected 2 entries, got %', rows_seen; end if;
  if total <> 2 then raise exception 'expected 2 in-window reactions after ageing out the 20, got %', total; end if;
  -- The rows themselves are still there: the READ is windowed, the record is not deleted.
  select count(*) into total from public.channel_reaction_sends where channel_id = '00000000-0000-4000-8000-000000005711';
  if total <> 22 then raise exception 'the durable record must not be deleted by the window; expected 22 rows, got %', total; end if;
end
$$;

-- =====================================================================
-- S6.16 -- THE RETURNED COLUMN SET IS EXACTLY
-- {entry_source, entry_id, display_name, reaction_count}, AND NOTHING
-- ELSE, EVER.
--
-- This is §6 #5's "non-identifying" expressed as an executable assertion
-- about the QUERY rather than a rule a reviewer has to enforce on the
-- renderer. Two independent checks, because one is a single point of
-- failure:
--
--   (a) the catalogue's declared result type, which fails if the
--       `returns table (...)` signature ever grows a column; and
--   (b) the ACTUAL shape of a real call, materialised into a table and
--       read back through information_schema.columns, which fails if the
--       select list ever emits something the signature did not declare.
--
-- Adding any column at all -- a viewer id, an anonymous identity token, a
-- session id, an IP, or even a harmless-looking created_at -- turns this
-- file red by name.
-- =====================================================================
do $$
declare declared_result text;
begin
  select pg_catalog.pg_get_function_result(p.oid)
    into declared_result
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_reaction_cloud';

  if declared_result is null then raise exception 'app_private.list_overlay_reaction_cloud does not exist'; end if;
  if declared_result <> 'TABLE(entry_source text, entry_id uuid, display_name text, reaction_count bigint)' then
    raise exception 'the overlay reaction-cloud read must return catalogue entry ids and counts and nothing else (§6 #5: non-identifying, enforced as a property of the query). Declared result is "%", expected exactly "TABLE(entry_source text, entry_id uuid, display_name text, reaction_count bigint)"', declared_result;
  end if;
end
$$;

create temporary table prf02s6_returned_shape as
  select * from app_private.list_overlay_reaction_cloud('00000000-0000-4000-8000-000000005741'::uuid, 'prf02s6-a-fingerprint', null);

do $$
declare actual_columns text;
begin
  select string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position)
    into actual_columns
    from information_schema.columns
   where table_name = 'prf02s6_returned_shape';

  if actual_columns <> 'entry_source text, entry_id uuid, display_name text, reaction_count bigint' then
    raise exception 'the columns actually returned by a live call must be exactly "entry_source text, entry_id uuid, display_name text, reaction_count bigint", got "%" -- any additional column is identifying or unbounded data leaving the database on the overlay path', actual_columns;
  end if;
end
$$;

-- =====================================================================
-- S6.23 -- NO VIEWER-IDENTIFYING SURFACE EXISTS ON THIS PATH, PROVEN
-- AGAINST THE SHIPPED FUNCTION DEFINITION RATHER THAN A COMMENT. Also
-- proven against the TABLE: there is no viewer column for a future read
-- to start returning.
-- =====================================================================
do $$
declare definition text; forbidden text;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_reaction_cloud';

  -- `created_at` is deliberately NOT on this list: the read's one-minute
  -- window predicate must reference it, and banning the token outright
  -- would ban the window itself. What matters is that it never LEAVES the
  -- database, and that is S6.16's job -- the returned column set is
  -- asserted exactly, twice, so no timestamp precise enough to correlate
  -- one viewer's sends can appear in the projection.
  foreach forbidden in array array['viewer', 'anonymous', 'ip_address', 'remote_addr', 'donor', 'supporter', 'payment']
  loop
    if position(forbidden in definition) > 0 then
      raise exception 'the overlay reaction-cloud read must contain no "%" token at all -- §6 #5 requires non-identifying to be a property of the query', forbidden;
    end if;
  end loop;
end
$$;

do $$
declare identifying_columns text;
begin
  select string_agg(column_name, ', ' order by column_name)
    into identifying_columns
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'channel_reaction_sends'
     and (column_name like '%viewer%' or column_name like '%anonymous%' or column_name like '%ip%'
          or column_name like '%session%' or column_name like '%donor%' or column_name like '%supporter%');
  if identifying_columns is not null then
    raise exception 'channel_reaction_sends must carry no viewer-identifying column; found: %', identifying_columns;
  end if;
end
$$;

-- =====================================================================
-- S6.9 / S6.10 / S6.13 -- THE RATE LIMIT IS THE CREATOR'S OWN
-- rateLimitPerMinute, ENFORCED AGAINST A ONE-MINUTE WINDOW.
--
-- Channel C is used from here on so channel A's cloud assertions above
-- stay exactly as they were. Config version 2 carries the limit; the
-- function reads the LATEST version, the same way every other config
-- consumer does.
-- =====================================================================
insert into channel_configs (channel_id, version, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000005713', 2, '{"queue":{"rateLimitPerMinute":3}}'::jsonb, current_timestamp, current_timestamp);

do $$
declare outcome text; i integer; recorded integer := 0;
begin
  for i in 1..5 loop
    outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005713', 'catalogue', '00000000-0000-4000-8000-000000005721');
    if outcome = 'recorded' then recorded := recorded + 1;
    elsif outcome <> 'rate_limited' then raise exception 'unexpected outcome % on send %', outcome, i;
    end if;
  end loop;
  if recorded <> 3 then raise exception 'rateLimitPerMinute 3 must allow exactly 3 sends in one window, got %', recorded; end if;
end
$$;

do $$
declare sends bigint;
begin
  select count(*) into sends from public.channel_reaction_sends where channel_id = '00000000-0000-4000-8000-000000005713';
  if sends <> 3 then raise exception 'a rate-limited send must insert nothing; expected 3 rows, got %', sends; end if;
end
$$;

-- S6.10: the window is one minute. Back-date the window start past it and
-- the next send is allowed again, with the counter reset to 1 -- 0032's
-- exact reset branch.
update public.channel_reaction_rate_limits
   set rate_limit_window_started_at = current_timestamp - interval '61 seconds'
 where channel_id = '00000000-0000-4000-8000-000000005713';

do $$
declare outcome text; counter integer;
begin
  outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005713', 'catalogue', '00000000-0000-4000-8000-000000005721');
  if outcome <> 'recorded' then raise exception 'once the one-minute window has elapsed the next send must be allowed, got %', outcome; end if;
  select rate_limit_send_count into counter from public.channel_reaction_rate_limits where channel_id = '00000000-0000-4000-8000-000000005713';
  if counter <> 1 then raise exception 'an elapsed window must reset the counter to 1, got %', counter; end if;
end
$$;

-- S6.13: the legacy `rateLimitPerMin` alias is accepted, exactly as 0063
-- line 56 accepts it for queue dispatch.
insert into channel_configs (channel_id, version, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000005713', 3, '{"queue":{"rateLimitPerMin":1}}'::jsonb, current_timestamp, current_timestamp);

update public.channel_reaction_rate_limits
   set rate_limit_window_started_at = null, rate_limit_send_count = 0
 where channel_id = '00000000-0000-4000-8000-000000005713';

do $$
declare outcome text;
begin
  outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005713', 'catalogue', '00000000-0000-4000-8000-000000005721');
  if outcome <> 'recorded' then raise exception 'the first send under rateLimitPerMin 1 must be recorded, got %', outcome; end if;
  outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005713', 'catalogue', '00000000-0000-4000-8000-000000005721');
  if outcome <> 'rate_limited' then raise exception 'the legacy rateLimitPerMin alias must be honoured, got %', outcome; end if;
end
$$;

-- =====================================================================
-- S6.12 -- A VALUE OUTSIDE 1-1000 IS IGNORED, THE SAME WAY 0032/0063
-- IGNORE IT. This is not a new policy; it is the existing one, reused.
-- =====================================================================
insert into channel_configs (channel_id, version, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000005713', 4, '{"queue":{"rateLimitPerMinute":9999}}'::jsonb, current_timestamp, current_timestamp);

do $$
declare outcome text; i integer;
begin
  for i in 1..4 loop
    outcome := app_private.record_channel_reaction('00000000-0000-4000-8000-000000005713', 'catalogue', '00000000-0000-4000-8000-000000005721');
    if outcome <> 'recorded' then raise exception 'an out-of-bounds rateLimitPerMinute must apply NO limit (0032/0063''s own fallback); send % returned %', i, outcome; end if;
  end loop;
end
$$;

-- =====================================================================
-- S6.14 -- THE REUSED MECHANISM IS VISIBLE IN THE SHIPPED DEFINITION, NOT
-- ONLY IN A COMMENT: the one-minute window, the 1-1000 bound and the
-- legacy alias all appear in the function the database actually holds.
-- =====================================================================
do $$
declare definition text;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'record_channel_reaction';

  if position($q$interval '1 minute'$q$ in definition) = 0 then
    raise exception 'the reaction rate limit must use the SAME one-minute window migrations 0032/0063 already enforce';
  end if;
  if position('between 1 and 1000' in definition) = 0 then
    raise exception 'the reaction rate limit must use the SAME 1-1000 bound the channel config schema already decides';
  end if;
  if position('rateLimitPerMinute' in definition) = 0 or position('rateLimitPerMin''' in definition) = 0 then
    raise exception 'the reaction rate limit must read the creator''s own rateLimitPerMinute, with 0063''s legacy rateLimitPerMin alias';
  end if;
end
$$;

-- =====================================================================
-- Migration 0139 is additive: it must not have touched 0131's module
-- catalogue check constraint, which already named reaction_cloud.
-- =====================================================================
do $$
declare has_key boolean;
begin
  select position('reaction_cloud' in pg_get_constraintdef(c.oid)) > 0
    into has_key
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
   where t.relname = 'master_canvas_modules'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%module_key%'
   limit 1;
  if has_key is not true then
    raise exception 'reaction_cloud must already be one of migration 0131''s catalogue keys -- this slice adds no key and alters no constraint';
  end if;
end
$$;

select 'prf02_slice6_reaction_cloud: all cases passed' as result;
