-- PRF-02 slice 7, §6 catalogue module #6 (Safe Soundboard Alert): the
-- catalogue, uploads, trigger and overlay-read functions shipped by
-- migration 0143.
--
-- This file owns id block ...5c00-...5cff (recorded in
-- fixtures/00_base_world.sql's ID ALLOCATION REGISTRY). It seeds its OWN
-- channels, memberships, entitlement versions and overlay sessions.
--
-- THE CASES THAT MATTER MOST:
--
--   SB.01 -- NO bytea COLUMN EXISTS ANYWHERE IN THIS MIGRATION (§19.1:
--   GCS/CDN, metadata only). Asserted against information_schema.columns
--   for all four tables this migration creates.
--
--   SB.02 -- THE UPLOAD PATH IS INERT WHEN CAPS ARE UNSET. Passing null
--   for either cap parameter is refused regardless of how small the
--   clip is -- unset must never mean unlimited.
--
--   SB.03 -- NO REVIEW STATE EXISTS. A creator's own upload is usable
--   the instant its row exists; asserted by triggering playback of a
--   just-created upload with no intervening step.
--
--   SB.04 -- THE OVERLAY READ'S RETURNED COLUMN SET, asserted twice
--   over exactly as 0136/0139/0140/0142 assert theirs.
--
--   SB.05 -- THE MODULE GATE (§30.3 Pro+) NEVER BLOCKS THE CREATOR'S OWN
--   RECORD (§12.6): a Free-tier channel can still list its catalogue,
--   upload (subject to its own tier's zero count limit) and trigger a
--   play; only the OVERLAY read is gated.
--
--   SB.06 -- NO FORBIDDEN WORD (safe/approved/checked/reviewed/vetted/
--   curated used as a truth-claim, or rating/report/scan/takedown/
--   moderat as a surface) exists in any shipped function body.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Fixture.
--   Channel A (...5c11) -- PRO tier, entitled to the module.
--   Channel B (...5c12) -- PRO tier, entitled. Cross-channel probe.
--   Channel C (...5c13) -- FREE tier, NOT entitled to the module (but
--     still fully able to manage its own catalogue/upload/trigger
--     records -- SB.05).
-- Users ...0001 (owner of A and C), ...0002 (owner of B), and the
-- non-owner/admin probes ...0003/.../0006 come from base_world.
-- ---------------------------------------------------------------------
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005c11', '00000000-0000-4000-8000-000000000001', 'soundboard_a', 'Soundboard A', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005c12', '00000000-0000-4000-8000-000000000002', 'soundboard_b', 'Soundboard B', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005c13', '00000000-0000-4000-8000-000000000001', 'soundboard_c', 'Soundboard C', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000005c11', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005c11', '00000000-0000-4000-8000-000000000003', 'admin', current_timestamp),
  ('00000000-0000-4000-8000-000000005c11', '00000000-0000-4000-8000-000000000006', 'viewer', current_timestamp),
  ('00000000-0000-4000-8000-000000005c12', '00000000-0000-4000-8000-000000000002', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005c13', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000005c11', 1, 'pro', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005c12', 1, 'pro', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005c13', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values
  ('00000000-0000-4000-8000-000000005c41', '00000000-0000-4000-8000-000000005c11', 'prf02s7-soundboard-a-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005c42', '00000000-0000-4000-8000-000000005c12', 'prf02s7-soundboard-b-fingerprint', current_timestamp + interval '1 hour', current_timestamp),
  ('00000000-0000-4000-8000-000000005c43', '00000000-0000-4000-8000-000000005c11', 'prf02s7-soundboard-expired-fingerprint', current_timestamp - interval '1 minute', current_timestamp - interval '2 hours'),
  ('00000000-0000-4000-8000-000000005c45', '00000000-0000-4000-8000-000000005c13', 'prf02s7-soundboard-c-fingerprint', current_timestamp + interval '1 hour', current_timestamp);

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at, revoked_at)
values
  ('00000000-0000-4000-8000-000000005c44', '00000000-0000-4000-8000-000000005c11', 'prf02s7-soundboard-revoked-fingerprint', current_timestamp + interval '1 hour', current_timestamp, current_timestamp);

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

-- =====================================================================
-- SB.01 -- NO bytea COLUMN EXISTS ANYWHERE IN THIS MIGRATION.
-- =====================================================================
do $$
declare offending text;
begin
  select string_agg(table_name || '.' || column_name, ', ')
    into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('soundboard_catalogue_entries', 'channel_soundboard_disables',
                         'channel_soundboard_uploads', 'channel_soundboard_plays')
     and data_type = 'bytea';
  if offending is not null then
    raise exception 'no table in this migration may store bytes in Postgres (§19.1: GCS/CDN, metadata only). Found: %', offending;
  end if;
end
$$;

-- =====================================================================
-- Catalogue import: created / skipped / updated, and rejection of
-- malformed input.
-- =====================================================================
do $$
declare outcome text; entry_id uuid;
begin
  select o, i into outcome, entry_id from app_private.import_soundboard_catalogue_entry(
    'sb-air-horn', 'Air Horn', 'hype', 'pro',
    'soundboard/catalogue/sb-air-horn', repeat('a', 64), 'audio/mpeg', 240000, 3
  ) as t(o, i);
  if outcome <> 'created' then raise exception 'expected created, got %', outcome; end if;

  select o, i into outcome, entry_id from app_private.import_soundboard_catalogue_entry(
    'sb-air-horn', 'Air Horn', 'hype', 'pro',
    'soundboard/catalogue/sb-air-horn', repeat('a', 64), 'audio/mpeg', 240000, 3
  ) as t(o, i);
  if outcome <> 'skipped' then raise exception 'expected skipped for an identical re-import, got %', outcome; end if;

  select o, i into outcome, entry_id from app_private.import_soundboard_catalogue_entry(
    'sb-air-horn', 'Air Horn v2', 'hype', 'pro',
    'soundboard/catalogue/sb-air-horn', repeat('a', 64), 'audio/mpeg', 240000, 3
  ) as t(o, i);
  if outcome <> 'updated' then raise exception 'expected updated for a changed display_name, got %', outcome; end if;
end
$$;

-- A Free-tier-floor entry and a Studio-tier-floor entry, used below.
select app_private.import_soundboard_catalogue_entry(
  'sb-clap', 'Clap', 'hype', 'free',
  'soundboard/catalogue/sb-clap', repeat('b', 64), 'audio/mpeg', 90000, 2
);
select app_private.import_soundboard_catalogue_entry(
  'sb-mega-horn', 'Mega Horn', 'hype', 'studio',
  'soundboard/catalogue/sb-mega-horn', repeat('c', 64), 'audio/mpeg', 500000, 5
);

do $$
begin
  begin
    perform app_private.import_soundboard_catalogue_entry(
      'sb-bad', 'Bad', 'hype', 'pro', '../etc/passwd', repeat('d', 64), 'audio/mpeg', 1000, 1
    );
    raise exception 'a traversal-shaped object key must be rejected';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform app_private.import_soundboard_catalogue_entry(
      'sb-bad2', 'Bad', 'hype', 'pro', 'soundboard/catalogue/sb-bad2', repeat('d', 64), 'text/html', 1000, 1
    );
    raise exception 'a non-audio mime type must be rejected';
  exception when sqlstate '22023' then null;
  end;
end
$$;

-- =====================================================================
-- Creator-facing catalogue list is NEVER tier-gated (§12.6): the
-- FREE-tier channel C sees every entry, including the studio-floor one.
-- =====================================================================
do $$
declare entry_count integer;
begin
  select count(*) into entry_count from app_private.list_soundboard_catalogue_for_channel('00000000-0000-4000-8000-000000005c13'::uuid);
  if entry_count < 3 then
    raise exception 'a free-tier channel must still be able to list the full catalogue (§12.6), got % rows', entry_count;
  end if;
end
$$;

-- Enable/disable: role gate, and live-on-next-read.
do $$
declare air_horn_id uuid; enabled_after boolean;
begin
  select id into air_horn_id from public.soundboard_catalogue_entries where external_key = 'sb-air-horn';

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false); -- viewer, not owner/admin
  begin
    perform app_private.set_channel_soundboard_catalogue_enabled('00000000-0000-4000-8000-000000005c11'::uuid, air_horn_id, false);
    raise exception 'a viewer must not be able to disable a catalogue entry';
  exception when sqlstate '42501' then null;
  end;

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false); -- owner
  perform app_private.set_channel_soundboard_catalogue_enabled('00000000-0000-4000-8000-000000005c11'::uuid, air_horn_id, false);
  select enabled into enabled_after from app_private.list_soundboard_catalogue_for_channel('00000000-0000-4000-8000-000000005c11'::uuid) where id = air_horn_id;
  if enabled_after <> false then raise exception 'disable must be visible on the very next read'; end if;

  perform app_private.set_channel_soundboard_catalogue_enabled('00000000-0000-4000-8000-000000005c11'::uuid, air_horn_id, true);
end
$$;

-- =====================================================================
-- SB.02 -- THE UPLOAD PATH IS INERT WHEN CAPS ARE UNSET.
-- =====================================================================
do $$
begin
  begin
    perform app_private.upload_channel_soundboard_clip(
      '00000000-0000-4000-8000-000000005c11'::uuid, 'My Clip', repeat('e', 64), 'audio/mpeg',
      1, 1, true, null, 1000000
    );
    raise exception 'a null duration cap must refuse the upload outright';
  exception when sqlstate '55000' then null;
  end;

  begin
    perform app_private.upload_channel_soundboard_clip(
      '00000000-0000-4000-8000-000000005c11'::uuid, 'My Clip', repeat('e', 64), 'audio/mpeg',
      1, 1, true, 30, null
    );
    raise exception 'a null byte-size cap must refuse the upload outright, even though the clip is tiny';
  exception when sqlstate '55000' then null;
  end;

  begin
    perform app_private.upload_channel_soundboard_clip(
      '00000000-0000-4000-8000-000000005c11'::uuid, 'My Clip', repeat('e', 64), 'audio/mpeg',
      1, 1, false, 30, 1000000
    );
    raise exception 'a missing rights attestation must be refused even when caps ARE configured';
  exception when sqlstate '22023' then null;
  end;
end
$$;

-- Now WITH both caps configured: within bounds succeeds; over either
-- bound is refused; the tier count limit is enforced; and the upload is
-- immediately usable with no intervening review step (SB.03).
do $$
declare outcome text; new_upload_id uuid; new_key text; play_id uuid;
begin
  select o, u, k into outcome, new_upload_id, new_key from app_private.upload_channel_soundboard_clip(
    '00000000-0000-4000-8000-000000005c11'::uuid, 'My Clip', repeat('e', 64), 'audio/mpeg',
    240000, 4, true, 30, 1000000
  ) as t(o, u, k);
  if outcome <> 'created' then raise exception 'expected created, got %', outcome; end if;
  if new_key <> 'soundboard/00000000-0000-4000-8000-000000005c11/' || repeat('e', 64) then
    raise exception 'the object key must be tenant-scoped and content-addressed, got %', new_key;
  end if;

  -- SB.03: no review step. Playable the instant the row exists.
  select app_private.trigger_soundboard_play('00000000-0000-4000-8000-000000005c11'::uuid, null, new_upload_id) into play_id;
  if play_id is null then raise exception 'a just-uploaded clip must be triggerable with no intervening step'; end if;

  begin
    perform app_private.upload_channel_soundboard_clip(
      '00000000-0000-4000-8000-000000005c11'::uuid, 'Too Long', repeat('f', 64), 'audio/mpeg',
      240000, 31, true, 30, 1000000
    );
    raise exception 'a clip over the configured duration cap must be refused';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform app_private.upload_channel_soundboard_clip(
      '00000000-0000-4000-8000-000000005c11'::uuid, 'Too Big', repeat('1', 64), 'audio/mpeg',
      1000001, 4, true, 30, 1000000
    );
    raise exception 'a clip over the configured byte-size cap must be refused';
  exception when sqlstate '22023' then null;
  end;
end
$$;

-- Tier upload count limit: channel C is FREE (limit 0), so its very
-- first upload attempt is refused by the count gate even with caps set
-- and a tiny, compliant clip.
do $$
begin
  begin
    perform app_private.upload_channel_soundboard_clip(
      '00000000-0000-4000-8000-000000005c13'::uuid, 'Tiny', repeat('2', 64), 'audio/mpeg',
      1, 1, true, 30, 1000000
    );
    raise exception 'a Free-tier channel has an upload count limit of zero and must be refused';
  exception when sqlstate '42501' then null;
  end;
end
$$;

-- =====================================================================
-- trigger_soundboard_play: role gate, tier floor, disabled entries,
-- unknown ids, and exactly-one-source.
-- =====================================================================
do $$
declare clap_id uuid; mega_id uuid;
begin
  select id into clap_id from public.soundboard_catalogue_entries where external_key = 'sb-clap';
  select id into mega_id from public.soundboard_catalogue_entries where external_key = 'sb-mega-horn';

  -- Channel A is PRO; the Studio-floor entry must be refused for it.
  begin
    perform app_private.trigger_soundboard_play('00000000-0000-4000-8000-000000005c11'::uuid, mega_id, null);
    raise exception 'a Studio-floor catalogue entry must not be triggerable on a Pro channel';
  exception when sqlstate '42501' then null;
  end;

  -- A Free-floor entry is fine on a Pro channel.
  perform app_private.trigger_soundboard_play('00000000-0000-4000-8000-000000005c11'::uuid, clap_id, null);

  -- Both null, or both set: rejected.
  begin
    perform app_private.trigger_soundboard_play('00000000-0000-4000-8000-000000005c11'::uuid, null, null);
    raise exception 'exactly one source must be required (both null)';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform app_private.trigger_soundboard_play('00000000-0000-4000-8000-000000005c11'::uuid, clap_id, clap_id);
    raise exception 'exactly one source must be required (both set)';
  exception when sqlstate '22023' then null;
  end;

  -- Disabled entries cannot be triggered.
  perform app_private.set_channel_soundboard_catalogue_enabled('00000000-0000-4000-8000-000000005c11'::uuid, clap_id, false);
  begin
    perform app_private.trigger_soundboard_play('00000000-0000-4000-8000-000000005c11'::uuid, clap_id, null);
    raise exception 'a disabled catalogue entry must not be triggerable';
  exception when sqlstate '42501' then null;
  end;
  perform app_private.set_channel_soundboard_catalogue_enabled('00000000-0000-4000-8000-000000005c11'::uuid, clap_id, true);

  -- SB.05: a FREE-tier channel (C, unentitled to the module) can still
  -- trigger its own catalogue playback -- storing/writing a durable
  -- record is never tier-gated; only the overlay renders it (or not).
  perform app_private.trigger_soundboard_play('00000000-0000-4000-8000-000000005c13'::uuid, clap_id, null);
end
$$;

-- =====================================================================
-- The overlay read.
-- =====================================================================
do $$
declare row_count integer;
begin
  -- Expired token.
  select count(*) into row_count from app_private.list_overlay_soundboard_play(
    '00000000-0000-4000-8000-000000005c43'::uuid, 'prf02s7-soundboard-expired-fingerprint');
  if row_count <> 0 then raise exception 'an expired overlay session must return zero rows'; end if;

  -- Revoked token.
  select count(*) into row_count from app_private.list_overlay_soundboard_play(
    '00000000-0000-4000-8000-000000005c44'::uuid, 'prf02s7-soundboard-revoked-fingerprint');
  if row_count <> 0 then raise exception 'a revoked overlay session must return zero rows'; end if;

  -- Wrong fingerprint for a real overlay id.
  select count(*) into row_count from app_private.list_overlay_soundboard_play(
    '00000000-0000-4000-8000-000000005c41'::uuid, 'wrong-fingerprint');
  if row_count <> 0 then raise exception 'a mismatched fingerprint must return zero rows'; end if;

  -- Cross-channel: B's overlay session must never surface A's plays.
  select count(*) into row_count from app_private.list_overlay_soundboard_play(
    '00000000-0000-4000-8000-000000005c42'::uuid, 'prf02s7-soundboard-b-fingerprint');
  if row_count <> 0 then raise exception 'channel B has triggered nothing and must return zero rows, not channel A''s plays'; end if;

  -- SB.05 continued -- Channel C is FREE, NOT entitled to the module:
  -- even though it has a real play on record (triggered above), the
  -- overlay must see nothing.
  select count(*) into row_count from app_private.list_overlay_soundboard_play(
    '00000000-0000-4000-8000-000000005c45'::uuid, 'prf02s7-soundboard-c-fingerprint');
  if row_count <> 0 then raise exception 'an unentitled (Free-tier) channel''s overlay read must return zero rows even with a real play on record'; end if;

  -- Channel A IS entitled (Pro) and has triggered plays: the overlay
  -- must return exactly the most recent one.
  select count(*) into row_count from app_private.list_overlay_soundboard_play(
    '00000000-0000-4000-8000-000000005c41'::uuid, 'prf02s7-soundboard-a-fingerprint');
  if row_count <> 1 then raise exception 'an entitled channel with plays on record must return exactly one row (the most recent), got %', row_count; end if;
end
$$;

-- =====================================================================
-- SB.04 -- THE OVERLAY READ'S RETURNED COLUMN SET.
-- =====================================================================
do $$
declare declared_result text;
begin
  select pg_catalog.pg_get_function_result(p.oid)
    into declared_result
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_soundboard_play';

  if declared_result is null then raise exception 'app_private.list_overlay_soundboard_play does not exist'; end if;
  if declared_result <> 'TABLE(play_id uuid, clip_kind text, display_name text, gcs_object_key text, mime_type text, duration_seconds integer, triggered_at timestamp with time zone)' then
    raise exception 'the overlay soundboard read must return exactly the seven declared columns and nothing else. Declared result is "%"', declared_result;
  end if;
end
$$;

create temporary table prf02s7_soundboard_returned_shape as
  select * from app_private.list_overlay_soundboard_play('00000000-0000-4000-8000-000000005c41'::uuid, 'prf02s7-soundboard-a-fingerprint');

do $$
declare actual_columns text;
begin
  select string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position)
    into actual_columns
    from information_schema.columns
   where table_name = 'prf02s7_soundboard_returned_shape';

  if actual_columns <> 'play_id uuid, clip_kind text, display_name text, gcs_object_key text, mime_type text, duration_seconds integer, triggered_at timestamp with time zone' then
    raise exception 'the columns actually returned by a live call must match the declared seven exactly, got "%"', actual_columns;
  end if;
end
$$;

-- No viewer/supporter/participant identifier field exists on the overlay
-- read's own function definition.
do $$
declare definition text; forbidden text;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_soundboard_play';

  foreach forbidden in array array['viewer', 'supporter', 'donor', 'participant', 'anonymous',
                                   'ip_address', 'remote_addr', 'discord', 'email', 'phone']
  loop
    if definition ilike '%' || forbidden || '%' then
      raise exception 'the overlay soundboard read must carry no identifying field; found forbidden token "%"', forbidden;
    end if;
  end loop;
end
$$;

-- =====================================================================
-- SB.06 -- NO FORBIDDEN WORD IN ANY SHIPPED FUNCTION BODY. The module's
-- OWN NAME is "Safe Soundboard Alert" (about playback, not content), so
-- this checks for the words used as a CONTENT truth-claim or a
-- moderation/reporting SURFACE, not for the module's own name string.
-- =====================================================================
do $$
declare definition text; forbidden text; fn text;
begin
  foreach fn in array array['soundboard_tier_rank', 'soundboard_upload_tier_limit',
                            'soundboard_module_entitled', 'import_soundboard_catalogue_entry',
                            'list_soundboard_catalogue_for_channel',
                            'set_channel_soundboard_catalogue_enabled',
                            'list_channel_soundboard_uploads', 'upload_channel_soundboard_clip',
                            'trigger_soundboard_play', 'list_overlay_soundboard_play']
  loop
    select pg_catalog.pg_get_functiondef(p.oid)
      into definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private'
       and p.proname = fn;

    if definition is null then raise exception 'app_private.% does not exist', fn; end if;

    foreach forbidden in array array['approved', 'checked_by', 'reviewed', 'vetted', 'curated',
                                     'content_rating', 'moderation_state', 'takedown', 'report_',
                                     'auto_scan', 'is_safe']
    loop
      if definition ilike '%' || forbidden || '%' then
        raise exception 'app_private.% must not carry the forbidden token "%": the module name describes the PLAYBACK being safe for a broadcast, never the content being vetted', fn, forbidden;
      end if;
    end loop;
  end loop;
end
$$;

-- No content-rating, moderation, report or takedown COLUMN exists on any
-- table this migration creates.
do $$
declare offending text;
begin
  select string_agg(table_name || '.' || column_name, ', ')
    into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('soundboard_catalogue_entries', 'channel_soundboard_disables',
                         'channel_soundboard_uploads', 'channel_soundboard_plays')
     and (column_name ilike '%rating%' or column_name ilike '%moderat%'
          or column_name ilike '%report%' or column_name ilike '%takedown%'
          or column_name ilike '%scan%' or column_name ilike '%approv%'
          or column_name ilike '%review%' or column_name ilike '%vett%'
          or column_name ilike '%curat%');
  if offending is not null then
    raise exception 'no review/moderation/rating/report/takedown/scan column is authorised (2026-09-17 decision). Found: %', offending;
  end if;
end
$$;
