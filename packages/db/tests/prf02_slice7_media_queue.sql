-- PRF-02 slice 7, §6 catalogue module #20 (Media / Meme Queue):
-- app_private.enqueue_media_queue_item, list_channel_media_queue_items,
-- update_media_queue_item, set_media_queue_item_status and
-- list_overlay_media_queue (migration 0146).
--
-- This file owns id block ...5b00-...5bff (recorded in
-- fixtures/00_base_world.sql's ID ALLOCATION REGISTRY). It seeds its OWN
-- channels, memberships and overlay sessions rather than reusing
-- base_world's, for the same reason prf02_slice6_giveaway_tournament.sql
-- does: the things under test are ROLE GATES, ALLOW-LISTS and the
-- STRUCTURAL absence of a submission surface, and an assertion another
-- file can move is not an assertion.
--
-- THE CASE THAT MATTERS MOST, BY A WIDE MARGIN:
--
--   MED20.1 -- NO VIEWER-SUBMISSION PATH EXISTS, STRUCTURALLY. The
--   owner's 2026-09-17 decision is explicit: "Creator-only. Viewers
--   cannot submit," and lists exactly what must never exist: a submission
--   endpoint, an approval queue, a viewer-facing surface, a moderation
--   queue, a rejection reason, a submitter identity field. This is
--   asserted three independent ways below: (a) every function this
--   migration ships is scanned for the tokens 'submit', 'submission',
--   'submitter', 'viewer_id', 'approve', 'approval' and 'reject'; (b)
--   information_schema.columns is scanned for any column on
--   media_queue_items named anything resembling a submitter/approval
--   field; (c) information_schema.tables is scanned to confirm no SECOND
--   table (a submission queue, distinct from the creator's own item
--   table) exists. No later edit can reintroduce a viewer-submission path
--   without turning this file red BY NAME, rather than merely by an
--   assertion someone would have had to think to write for that specific
--   new column.
--
--   MED20.2 -- THE OVERLAY READ IS "CURRENT AND NEXT", NEVER A QUEUE
--   DEPTH. Reuses the exact bound
--   apps/web/app/overlay/canvas/modules/support-theater-module.ts:68-72
--   already established for this codebase: at most two rows, and no
--   aggregate count of how many items are queued is ever returned.
--
--   MED20.16 -- NO bytea COLUMN. §19.1 / MED-21: metadata only, an
--   already-hosted GCS/CDN pointer, never bytes in this database.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Fixture.
--   Channel A (...5b11) -- FREE tier. The channel under test -- deliberately
--   Free, not Creator+, because §12.6 means NONE of the creator-facing
--   functions here may read or care about tier at all (MED20.11).
--   Channel B (...5b12) -- PRO tier. The cross-channel isolation probe.
-- Users ...0001 (owner of A), ...0002 (owner of B), and the
-- non-owner/admin probes ...0003/...0004/...0005/...0006 come from
-- base_world, with the SAME role assignments on channel A that
-- prf02_slice6_giveaway_tournament.sql uses on its own channel A.
-- ---------------------------------------------------------------------
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000005b11', '00000000-0000-4000-8000-000000000001', 'mediaq_a', 'Media Queue A', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000005b12', '00000000-0000-4000-8000-000000000002', 'mediaq_b', 'Media Queue B', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000005b11', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000005b11', '00000000-0000-4000-8000-000000000003', 'admin', current_timestamp),
  ('00000000-0000-4000-8000-000000005b11', '00000000-0000-4000-8000-000000000004', 'operator', current_timestamp),
  ('00000000-0000-4000-8000-000000005b11', '00000000-0000-4000-8000-000000000005', 'moderator', current_timestamp),
  ('00000000-0000-4000-8000-000000005b11', '00000000-0000-4000-8000-000000000006', 'viewer', current_timestamp),
  ('00000000-0000-4000-8000-000000005b12', '00000000-0000-4000-8000-000000000002', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

-- Channel A stays FREE tier (no entitlement version row needed -- the
-- default tier a channel with none is treated as); channel B is
-- deliberately given a HIGHER tier to prove MED20.11: tier makes no
-- difference to any creator-facing function in this file.
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000005b12', 1, 'studio', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- Two overlay sessions: a good one for A, and an expired one for A.
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, revoked_at, created_at)
values
  ('00000000-0000-4000-8000-000000005b41', '00000000-0000-4000-8000-000000005b11', 'prf02s7-mediaq-a-fingerprint', current_timestamp + interval '1 hour', null, current_timestamp),
  ('00000000-0000-4000-8000-000000005b43', '00000000-0000-4000-8000-000000005b11', 'prf02s7-mediaq-expired-fingerprint', current_timestamp - interval '1 minute', null, current_timestamp - interval '2 hours')
on conflict (id) do nothing;

-- =====================================================================
-- MED20.1 -- NO VIEWER-SUBMISSION PATH EXISTS, STRUCTURALLY. See header.
-- =====================================================================
do $$
declare definition text; forbidden text; fn text;
begin
  foreach fn in array array['enqueue_media_queue_item', 'list_channel_media_queue_items',
                            'update_media_queue_item', 'set_media_queue_item_status',
                            'list_overlay_media_queue']
  loop
    select pg_catalog.pg_get_functiondef(p.oid)
      into definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname = fn;
    if definition is null then raise exception 'app_private.% does not exist', fn; end if;

    foreach forbidden in array array['submit', 'submission', 'submitter', 'viewer_id',
                                     'approve', 'approval', 'reject']
    loop
      if position(forbidden in definition) > 0 then
        raise exception 'app_private.% contains a "%" token -- Media / Meme Queue is CREATOR-ONLY (owner decision, 2026-09-17): no submission endpoint, no approval queue, no moderation queue, no rejection reason, no submitter identity field may ever exist', fn, forbidden;
      end if;
    end loop;
  end loop;
end
$$;

do $$
declare offending text;
begin
  select string_agg(column_name, ', ')
    into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'media_queue_items'
     and (
       column_name ilike '%submit%' or column_name ilike '%submission%'
       or column_name = 'viewer_id' or column_name ilike '%approv%'
       or column_name ilike '%reject%'
     );
  if offending is not null then
    raise exception 'public.media_queue_items must carry no submitter, submission, viewer, approval or rejection column; found: %', offending;
  end if;
end
$$;

do $$
declare extra_tables text;
begin
  select string_agg(table_name, ', ')
    into extra_tables
    from information_schema.tables
   where table_schema = 'public'
     and (table_name ilike '%media_queue%submission%' or table_name ilike '%media%submit%'
          or table_name ilike '%media%approv%');
  if extra_tables is not null then
    raise exception 'no second table for a media submission/approval queue may exist; found: %', extra_tables;
  end if;
end
$$;

-- =====================================================================
-- MED20.16 / MED20.17 -- NO bytea COLUMN, NO EXPIRY/TTL COLUMN.
-- §19.1 / MED-21 (metadata only) and §12.6.2 (uniform retention, never
-- per-row, never per-tier).
-- =====================================================================
do $$
declare offending text;
begin
  select string_agg(column_name || ' ' || data_type, ', ')
    into offending
    from information_schema.columns
   where table_schema = 'public' and table_name = 'media_queue_items' and data_type = 'bytea';
  if offending is not null then
    raise exception 'public.media_queue_items must hold metadata only (§19.1, MED-21) -- no bytea column may exist; found: %', offending;
  end if;
end
$$;

do $$
declare offending text;
begin
  select string_agg(column_name, ', ')
    into offending
    from information_schema.columns
   where table_schema = 'public' and table_name = 'media_queue_items'
     and (column_name ilike '%expire%' or column_name ilike '%ttl%' or column_name ilike '%retention%');
  if offending is not null then
    raise exception 'retention is the uniform policy (§12.6.2), never a per-row or per-tier column; found: %', offending;
  end if;
end
$$;

-- =====================================================================
-- MED20.11 -- NONE OF THE FOUR CREATOR-FACING FUNCTIONS MAY READ TIER OR
-- CALL AN ENTITLEMENT FUNCTION (§12.6). Only the role gate.
-- =====================================================================
do $$
declare definition text; fn text;
begin
  foreach fn in array array['enqueue_media_queue_item', 'list_channel_media_queue_items',
                            'update_media_queue_item', 'set_media_queue_item_status']
  loop
    select pg_catalog.pg_get_functiondef(p.oid)
      into definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname = fn;
    if position('entitled' in definition) > 0 or position('tier_' in definition) > 0
       or position('channel_entitlement_versions' in definition) > 0 then
      raise exception 'app_private.% must never read tier or call an entitlement function -- storing, viewing and changing a durable creator record is never tier-gated (§12.6)', fn;
    end if;
  end loop;
end
$$;

-- =====================================================================
-- MED20.4 -- ROLE GATE: only owner/admin may enqueue, update or set
-- status. Operator, moderator and viewer are refused.
-- =====================================================================
do $$
declare probe record; before_count bigint; after_count bigint;
begin
  select count(*) into before_count from public.media_queue_items where channel_id = '00000000-0000-4000-8000-000000005b11';
  for probe in
    select * from (values
      ('00000000-0000-4000-8000-000000000004'::uuid, 'operator'),
      ('00000000-0000-4000-8000-000000000005'::uuid, 'moderator'),
      ('00000000-0000-4000-8000-000000000006'::uuid, 'viewer')
    ) as t(user_id, role_name)
  loop
    perform set_config('app.user_id', probe.user_id::text, true);
    begin
      perform app_private.enqueue_media_queue_item(
        '00000000-0000-4000-8000-000000005b11'::uuid, 'should be refused', 'image', 'image/png',
        'https://cdn.example.com/refused.png', null, null, null, null
      );
      raise exception 'a % must not be able to enqueue a media item', probe.role_name;
    exception when sqlstate '42501' then null;
    end;
  end loop;
  select count(*) into after_count from public.media_queue_items where channel_id = '00000000-0000-4000-8000-000000005b11';
  if before_count <> after_count then raise exception 'a refused enqueue must insert nothing'; end if;
end
$$;

-- =====================================================================
-- MED20.5 / MED20.6 / MED20.7 / MED20.8 -- FIELD VALIDATION: title bound,
-- media_kind / mime_type allow-lists, storage/thumbnail URL shape,
-- non-negative duration.
-- =====================================================================
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);

  begin
    perform app_private.enqueue_media_queue_item('00000000-0000-4000-8000-000000005b11'::uuid, '', 'image', 'image/png', 'https://cdn.example.com/x.png', null, null, null, null);
    raise exception 'an empty title must be refused';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform app_private.enqueue_media_queue_item('00000000-0000-4000-8000-000000005b11'::uuid, repeat('x', 121), 'image', 'image/png', 'https://cdn.example.com/x.png', null, null, null, null);
    raise exception 'a 121-character title must be refused -- the bound is 1-120 (0109_v1_l17_paid_challenges.sql:67)';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform app_private.enqueue_media_queue_item('00000000-0000-4000-8000-000000005b11'::uuid, 'ok title', 'audio', 'image/png', 'https://cdn.example.com/x.png', null, null, null, null);
    raise exception 'an unrecognised media_kind must be refused';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform app_private.enqueue_media_queue_item('00000000-0000-4000-8000-000000005b11'::uuid, 'ok title', 'image', 'text/html', 'https://cdn.example.com/x.png', null, null, null, null);
    raise exception 'text/html must be refused -- §9.1.1: no script, iframe or stylesheet may ever reach the Master Canvas';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform app_private.enqueue_media_queue_item('00000000-0000-4000-8000-000000005b11'::uuid, 'ok title', 'image', 'image/svg+xml', 'https://cdn.example.com/x.png', null, null, null, null);
    raise exception 'image/svg+xml must be refused -- SVG can carry inline script (§9.1.1)';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform app_private.enqueue_media_queue_item('00000000-0000-4000-8000-000000005b11'::uuid, 'ok title', 'image', 'image/png', 'http://cdn.example.com/x.png', null, null, null, null);
    raise exception 'a non-https storage url must be refused (0123_v1_l19d_provider_qr_codes.sql:192''s shape, reused)';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform app_private.enqueue_media_queue_item('00000000-0000-4000-8000-000000005b11'::uuid, 'ok title', 'image', 'image/png', 'https://cdn.example.com/x.png', 'http://cdn.example.com/thumb.png', null, null, null);
    raise exception 'a non-https thumbnail url must be refused';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform app_private.enqueue_media_queue_item('00000000-0000-4000-8000-000000005b11'::uuid, 'ok title', 'video', 'video/mp4', 'https://cdn.example.com/x.mp4', null, -1, null, null);
    raise exception 'a negative duration must be refused';
  exception when sqlstate '22023' then null;
  end;
end
$$;

-- =====================================================================
-- MED20.9 -- CONFIGURED-BUT-UNSET CAPS. Neither cap is invented by this
-- function; both are enforced ONLY when a caller supplies one.
-- =====================================================================
do $$
declare unbounded_id uuid; capped_ok_id uuid;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);

  -- Unset duration cap: any non-negative duration is accepted.
  select app_private.enqueue_media_queue_item(
    '00000000-0000-4000-8000-000000005b11'::uuid, 'long clip, unset cap', 'video', 'video/mp4',
    'https://cdn.example.com/long.mp4', null, 999999999, null, null
  ) into unbounded_id;
  if unbounded_id is null then raise exception 'an unset duration cap must not refuse any non-negative duration'; end if;

  -- Set duration cap: a duration under it is accepted, and one over it is refused.
  select app_private.enqueue_media_queue_item(
    '00000000-0000-4000-8000-000000005b11'::uuid, 'short clip, capped', 'video', 'video/mp4',
    'https://cdn.example.com/short.mp4', null, 500, 1000, null
  ) into capped_ok_id;
  if capped_ok_id is null then raise exception 'a duration under a supplied cap must be accepted'; end if;

  begin
    perform app_private.enqueue_media_queue_item(
      '00000000-0000-4000-8000-000000005b11'::uuid, 'too long, capped', 'video', 'video/mp4',
      'https://cdn.example.com/toolong.mp4', null, 1500, 1000, null
    );
    raise exception 'a duration over a supplied cap must be refused';
  exception when sqlstate '22023' then null;
  end;

  -- Set queue-item-count cap: with the cap at the CURRENT queued count,
  -- one more enqueue must be refused; the same call with the cap unset
  -- (tested implicitly above and throughout this file, which enqueues
  -- more than any small cap would allow) must succeed.
  declare current_queued integer;
  begin
    select count(*) into current_queued from public.media_queue_items
     where channel_id = '00000000-0000-4000-8000-000000005b11' and status = 'queued';
    begin
      perform app_private.enqueue_media_queue_item(
        '00000000-0000-4000-8000-000000005b11'::uuid, 'over the cap', 'image', 'image/png',
        'https://cdn.example.com/overcap.png', null, null, null, current_queued
      );
      raise exception 'a supplied queue-item-count cap at the current count must refuse one more item';
    exception when sqlstate '22023' then null;
    end;

    -- One above the current count must be accepted.
    perform app_private.enqueue_media_queue_item(
      '00000000-0000-4000-8000-000000005b11'::uuid, 'right at the cap', 'image', 'image/png',
      'https://cdn.example.com/atcap.png', null, null, null, current_queued + 1
    );
  end;
end
$$;

-- =====================================================================
-- MED20.10 -- CROSS-CHANNEL ISOLATION. Channel B's owner cannot read,
-- update or change the status of Channel A's items.
-- =====================================================================
do $$
declare an_item_id uuid; seen_count integer;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  select media_queue_item_id into an_item_id
    from app_private.list_channel_media_queue_items('00000000-0000-4000-8000-000000005b11'::uuid, 1);

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000002', true);

  select count(*) into seen_count from app_private.list_channel_media_queue_items('00000000-0000-4000-8000-000000005b11'::uuid, null);
  if seen_count <> 0 then raise exception 'channel B''s owner must not be able to list channel A''s media queue, saw %', seen_count; end if;

  begin
    perform app_private.update_media_queue_item('00000000-0000-4000-8000-000000005b11'::uuid, an_item_id, 'hijacked title', true);
    raise exception 'channel B''s owner must not be able to update channel A''s item';
  exception when sqlstate 'P0002' then null;
  end;

  begin
    perform app_private.set_media_queue_item_status('00000000-0000-4000-8000-000000005b11'::uuid, an_item_id, 'played');
    raise exception 'channel B''s owner must not be able to change channel A''s item status';
  exception when sqlstate 'P0002' then null;
  end;
end
$$;

-- =====================================================================
-- MED20.15 -- NOT-FOUND: an unknown item id, on the caller's own channel,
-- is the same P0002 answer.
-- =====================================================================
do $$
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
  begin
    perform app_private.update_media_queue_item('00000000-0000-4000-8000-000000005b11'::uuid, gen_random_uuid(), 'no such item', true);
    raise exception 'an unknown item id must be refused with not-found';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform app_private.set_media_queue_item_status('00000000-0000-4000-8000-000000005b11'::uuid, gen_random_uuid(), 'played');
    raise exception 'an unknown item id must be refused with not-found';
  exception when sqlstate 'P0002' then null;
  end;
end
$$;

-- =====================================================================
-- MED20.13 / MED20.14 -- FIFO "CURRENT AND NEXT", PLAYED/SKIPPED/DISABLED
-- ITEMS EXCLUDED FROM THE LIVE ROTATION BUT RETAINED IN THE CREATOR'S OWN
-- LIST (§12.6).
--
-- Fresh channel for this block so ordering is exact and not disturbed by
-- the items MED20.4-MED20.9 already created on channel A.
-- =====================================================================
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000005b13', '00000000-0000-4000-8000-000000000001', 'mediaq_fifo', 'Media Queue FIFO', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;
insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000005b13', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;
insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, created_at)
values ('00000000-0000-4000-8000-000000005b44', '00000000-0000-4000-8000-000000005b13', 'prf02s7-mediaq-fifo-fingerprint', current_timestamp + interval '1 hour', current_timestamp)
on conflict (id) do nothing;

-- Each enqueue below is its OWN top-level statement (never nested inside
-- one plpgsql `do $$ ... $$` block) precisely so each gets its OWN
-- transaction and its OWN `current_timestamp` -- `current_timestamp` is
-- fixed for the lifetime of a single transaction in PostgreSQL, so three
-- inserts sharing one enclosing transaction would tie on created_at
-- regardless of any pg_sleep between them, making this ordering
-- assertion meaningless. Splitting them into separate statements plus a
-- real sleep between each is what makes the FIFO order deterministic.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
select app_private.enqueue_media_queue_item('00000000-0000-4000-8000-000000005b13'::uuid, 'meme one', 'image', 'image/png', 'https://cdn.example.com/1.png', null, null, null, null) as id1 \gset
select pg_sleep(0.05);
select app_private.enqueue_media_queue_item('00000000-0000-4000-8000-000000005b13'::uuid, 'meme two', 'image', 'image/png', 'https://cdn.example.com/2.png', null, null, null, null) as id2 \gset
select pg_sleep(0.05);
select app_private.enqueue_media_queue_item('00000000-0000-4000-8000-000000005b13'::uuid, 'meme three', 'image', 'image/png', 'https://cdn.example.com/3.png', null, null, null, null) as id3 \gset

do $$
declare row1 record; row2 record; rows_seen integer;
begin
  select count(*) into rows_seen from app_private.list_overlay_media_queue('00000000-0000-4000-8000-000000005b44'::uuid, 'prf02s7-mediaq-fifo-fingerprint');
  if rows_seen <> 2 then raise exception 'the overlay read must return AT MOST TWO rows regardless of how many items are queued (§12.7: current and next, never a queue depth) -- saw %', rows_seen; end if;

  select * into row1 from app_private.list_overlay_media_queue('00000000-0000-4000-8000-000000005b44'::uuid, 'prf02s7-mediaq-fifo-fingerprint') where queue_slot = 'current';
  if row1.queue_slot <> 'current' or row1.title <> 'meme one' then raise exception 'the CURRENT slot must be the oldest queued+enabled item (FIFO), got % / %', row1.queue_slot, row1.title; end if;
end
$$;

-- Mark "meme one" played: it must drop out of the live rotation, and
-- "meme two" must now be current, "meme three" next.
select app_private.set_media_queue_item_status('00000000-0000-4000-8000-000000005b13'::uuid, :'id1', 'played');

do $$
declare row1 record; row2 record; rows_seen integer;
begin
  select * into row1 from app_private.list_overlay_media_queue('00000000-0000-4000-8000-000000005b44'::uuid, 'prf02s7-mediaq-fifo-fingerprint') where queue_slot = 'current';
  select * into row2 from app_private.list_overlay_media_queue('00000000-0000-4000-8000-000000005b44'::uuid, 'prf02s7-mediaq-fifo-fingerprint') where queue_slot = 'next';
  if row1.title <> 'meme two' then raise exception 'after "meme one" is played, "meme two" must be current, got %', row1.title; end if;
  if row2.title <> 'meme three' then raise exception 'after "meme one" is played, "meme three" must be next, got %', row2.title; end if;
end
$$;

-- Disable "meme two": it must also drop out, leaving only "meme three".
select app_private.update_media_queue_item('00000000-0000-4000-8000-000000005b13'::uuid, :'id2', 'meme two', false);

do $$
declare rows_seen integer;
begin
  select count(*) into rows_seen from app_private.list_overlay_media_queue('00000000-0000-4000-8000-000000005b44'::uuid, 'prf02s7-mediaq-fifo-fingerprint');
  if rows_seen <> 1 then raise exception 'with one played and one disabled, exactly one item should remain live, saw %', rows_seen; end if;

  -- BUT the creator's own list still shows all three, forever (§12.6).
  select count(*) into rows_seen from app_private.list_channel_media_queue_items('00000000-0000-4000-8000-000000005b13'::uuid, null);
  if rows_seen <> 3 then raise exception 'the creator''s own durable list must retain every item regardless of status or enabled, saw %', rows_seen; end if;
end
$$;

-- =====================================================================
-- MED20.12 -- A BAD OR EXPIRED OVERLAY TOKEN RETURNS ZERO ROWS.
-- =====================================================================
do $$
declare rows_seen integer;
begin
  select count(*) into rows_seen from app_private.list_overlay_media_queue('00000000-0000-4000-8000-000000005b41'::uuid, 'wrong-fingerprint-entirely');
  if rows_seen <> 0 then raise exception 'a wrong token fingerprint must return zero rows, saw %', rows_seen; end if;

  select count(*) into rows_seen from app_private.list_overlay_media_queue(gen_random_uuid(), 'prf02s7-mediaq-a-fingerprint');
  if rows_seen <> 0 then raise exception 'an unrecognised overlay id must return zero rows, saw %', rows_seen; end if;

  select count(*) into rows_seen from app_private.list_overlay_media_queue('00000000-0000-4000-8000-000000005b43'::uuid, 'prf02s7-mediaq-expired-fingerprint');
  if rows_seen <> 0 then raise exception 'an expired overlay session must return zero rows, saw %', rows_seen; end if;
end
$$;

-- =====================================================================
-- MED20.2 -- THE RETURNED COLUMN SET IS EXACTLY THE SEVEN DECLARED
-- COLUMNS, AND NOTHING ELSE, EVER. Two independent checks, exactly the
-- shape 0136, 0139, 0140 and 0142 use for theirs.
-- =====================================================================
do $$
declare declared_result text;
begin
  select pg_catalog.pg_get_function_result(p.oid)
    into declared_result
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_media_queue';

  if declared_result is null then raise exception 'app_private.list_overlay_media_queue does not exist'; end if;
  if declared_result <> 'TABLE(queue_slot text, title text, media_kind text, mime_type text, storage_url text, thumbnail_url text, duration_ms integer)' then
    raise exception 'the overlay media queue read must return exactly queue_slot/title/media_kind/mime_type/storage_url/thumbnail_url/duration_ms and nothing else -- no item id, no submitter, no viewer identity, no queue-depth count. Declared result is "%"', declared_result;
  end if;
end
$$;

create temporary table prf02s7_mediaqueue_returned_shape as
  select * from app_private.list_overlay_media_queue('00000000-0000-4000-8000-000000005b41'::uuid, 'prf02s7-mediaq-a-fingerprint');

do $$
declare actual_columns text;
begin
  select string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position)
    into actual_columns
    from information_schema.columns
   where table_name = 'prf02s7_mediaqueue_returned_shape';

  if actual_columns <> 'queue_slot text, title text, media_kind text, mime_type text, storage_url text, thumbnail_url text, duration_ms integer' then
    raise exception 'the columns actually returned by a live call must be exactly the seven declared columns, got "%" -- any additional column is an identifier or a queue-depth count leaving the database on the overlay path', actual_columns;
  end if;
end
$$;

-- =====================================================================
-- MED20.3 -- NO IDENTIFYING TOKEN EXISTS ON THE OVERLAY PATH, PROVEN
-- AGAINST THE SHIPPED FUNCTION DEFINITION RATHER THAN A COMMENT.
--
-- `session` is deliberately NOT on this list, for the same reason it is
-- excluded in prf02_slice6_giveaway_tournament.sql: the read's own auth
-- predicate is public.overlay_sessions, and banning that token outright
-- would ban the token-fingerprint gate every list_overlay_* function
-- uses. What matters is that no identifier LEAVES the database, and that
-- is MED20.2's job.
-- =====================================================================
do $$
declare definition text; forbidden text;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'list_overlay_media_queue';

  foreach forbidden in array array['viewer', 'anonymous', 'ip_address', 'remote_addr',
                                   'submitter', 'submission', 'approve', 'reject']
  loop
    if position(forbidden in definition) > 0 then
      raise exception 'the overlay media queue read must contain no "%" token at all', forbidden;
    end if;
  end loop;
end
$$;

select 'prf02_slice7_media_queue.sql: all assertions passed' as result;
