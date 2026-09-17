-- PRF-02 slice 7 follow-up: Media / Meme Queue URL hardening.
--
-- Authority: FULL-PRODUCT-DEFINITION.md §9.1.1, §19.1, and a hostile code
-- review finding of 2026-09-17 (bharatstudio-requirements/reviews/
-- 2026-09-17-prf-02-media-url-hardening-implementation.md; task record
-- bharatstudio-requirements/active/tasks/
-- PRF-02-slice-7-media-url-hardening.md).
--
-- MIGRATION NUMBER: 0148, assigned to this task. Nothing is renumbered and
-- no other number is written here.
--
-- ============================================================
-- THE FINDING. public.media_queue_items.storage_url / thumbnail_url
-- (migration 0146) were validated as ONLY "https:// prefix + length
-- <=2048". No host allowlist, no CDN restriction, no signature -- a
-- creator could enqueue a URL pointing at ANY host on the internet, and
-- apps/web/app/overlay/canvas/modules/media-queue-module.ts assigned it
-- straight to <img>.src / <video>.src on the Master Canvas. An <img>/
-- <video> src is decode-only (not a script/iframe/stylesheet execution
-- surface), so this was never an XSS hole -- but §9.1.1 ("BharatStudio
-- never embeds an arbitrary third-party browser-source URL ... There is
-- no tier, no attestation and no 'advanced mode' that makes it
-- acceptable") and §19.1 ("GCS behind the CDN with short-lived signed
-- URLs. No public bucket path in either case.") both govern WHICH ORIGIN
-- the canvas contacts, not only whether that origin can run code. A
-- remote host chosen by the creator could still degrade OBS performance
-- and reliability, carry off-brand content onto the canvas, learn the
-- creator's IP on every poll, and swap the served bytes after the
-- creator queued it -- three of §9.1.1's stated harms, plus one more.
--
-- ============================================================
-- THE FIX. Migration 0143's soundboard pattern, mirrored exactly, not
-- reinvented.
-- ============================================================
-- `storage_url` / `thumbnail_url` (arbitrary-origin URLs) are replaced by
-- `gcs_object_key` / `thumbnail_gcs_object_key`: content-key fragments
-- restricted to migration 0143's EXACT character set
-- (`^[A-Za-z0-9/_.-]{1,255}$`, and never containing `..`). That character
-- set cannot express a scheme (`https://`) or a host (no `:` or handled
-- via a host-bearing prefix) -- a value satisfying this CHECK constraint
-- is structurally incapable of naming a third-party origin, exactly as
-- 0143's own header explains for soundboard_catalogue_entries.
-- gcs_object_key and channel_soundboard_uploads.gcs_object_key.
--
-- The overlay read (`list_overlay_media_queue`, redefined below) now
-- returns the KEY, never a URL. Resolution to a playable URL happens in
-- apps/api/src/db/media-queue-overlay-store.ts's new
-- `resolveMediaPlaybackUrl(cdnBaseUrl, objectKey)`, which concatenates
-- the key onto the server's OWN configured CDN base
-- (`config.mediaCdnBaseUrl` -- the SAME config value
-- db/safe-soundboard-overlay-store.ts already reads; no second config
-- value is introduced by this migration or by that file). Concatenating
-- a scheme-less, host-less key onto a base that is itself validated
-- https at config load time (apps/api/src/config.ts) can only ever
-- produce a URL on our own configured origin -- never a caller- or
-- row-supplied one. `mediaCdnBaseUrl` is CONFIGURED BUT UNSET in every
-- environment today, so `resolveMediaPlaybackUrl` returns null for every
-- item until it is provisioned, and
-- apps/web/app/overlay/canvas/modules/media-queue-module.ts renders
-- nothing for an entry whose playbackUrl is null -- the same honest
-- "cannot display until GCS/CDN exists" posture
-- db/safe-soundboard-overlay-store.ts already documents for the
-- soundboard card. The mime_type closed allow-list and the image/svg+xml
-- exclusion (migration 0146) are UNCHANGED by this migration -- this was
-- never an XSS fix and remains none.
--
-- The creator write path changes symmetrically: `enqueue_media_queue_item`
-- now takes `target_gcs_object_key` / `target_thumbnail_gcs_object_key`
-- (validated against the same character-set CHECK the column carries,
-- mirroring `import_soundboard_catalogue_entry`'s validation shape
-- exactly) in place of `target_storage_url` / `target_thumbnail_url`.
-- Unlike the soundboard's upload path, this migration does not derive the
-- key from a content hash server-side -- Media / Meme Queue's own upload
-- pipeline is register item INT-07 (`new-record-required`, not part of
-- this slice, per migration 0146's own header) -- so the creator caller
-- still supplies the key directly, exactly as it previously supplied the
-- URL directly. The security property does not depend on who computes
-- the key: no value matching this character set can EVER become a
-- third-party origin, regardless of caller.
--
-- `list_channel_media_queue_items` (the creator's own durable read) is
-- updated the same way: it returns the key, never a URL -- the creator
-- dashboard resolves it against the identical configured CDN base the
-- overlay does, via the same `resolveMediaPlaybackUrl` helper.
--
-- `update_media_queue_item` and `set_media_queue_item_status` touch
-- neither column and are UNCHANGED by this migration -- grep them in
-- migration 0146: neither references storage_url, thumbnail_url, or any
-- replacement column.
--
-- ============================================================
-- EXISTING ROWS: DELETED, ANNOUNCED, NEVER SILENT.
-- ============================================================
-- A `storage_url` value (an arbitrary https URL, e.g.
-- "https://example.net/whatever.png") has no lossless mapping to a
-- content-key fragment restricted to `^[A-Za-z0-9/_.-]{1,255}$` -- the
-- scheme and host that made it a URL are precisely what that character
-- set cannot carry, and there is no GCS object behind any of these rows
-- to re-key against (this table has never had a real GCS-backed asset;
-- every environment's `mediaCdnBaseUrl` has been unset since migration
-- 0146 shipped, so nothing could have been resolved or played from it).
-- There is therefore no honest conversion, and none is invented here --
-- see this task's own hard constraint against inventing a numeric limit,
-- provider behaviour or deployment value. Every existing
-- public.media_queue_items row is deleted below, logged by RAISE NOTICE
-- with the exact count first, before the column drop makes the old data
-- unrecoverable by this migration. Per AGENTS.md, no shared/production
-- database is migrated by this change without separate explicit
-- approval; in every environment this migration is meant to run against
-- (fresh schemas, the SQL test suite's per-file template databases), the
-- expected count is zero, and the NOTICE fires only if that expectation
-- is ever wrong.
--
-- ROLLBACK: additive/corrective only, no production migration without
-- separate explicit approval. The delete above is destructive and not
-- reversible by this rollback -- it restores the SCHEMA shape only, not
-- any deleted row.
--   drop function app_private.list_overlay_media_queue(uuid, text);
--   create function app_private.list_overlay_media_queue(uuid, text) ...
--     -- (migration 0146's original body, returning storage_url/thumbnail_url)
--   drop function app_private.list_channel_media_queue_items(uuid, integer);
--   create function app_private.list_channel_media_queue_items(uuid, integer) ...
--     -- (migration 0146's original body)
--   drop function app_private.enqueue_media_queue_item(uuid, text, text, text, text, text, integer, integer, integer);
--   create function app_private.enqueue_media_queue_item(uuid, text, text, text, text, text, integer, integer, integer) ...
--     -- (migration 0146's original body, target_storage_url/target_thumbnail_url)
--   alter table public.media_queue_items drop column if exists gcs_object_key;
--   alter table public.media_queue_items drop column if exists thumbnail_gcs_object_key;
--   alter table public.media_queue_items add column storage_url text not null
--     check (char_length(storage_url) between 1 and 2048 and left(storage_url, 8) = 'https://');
--   alter table public.media_queue_items add column thumbnail_url text
--     check (thumbnail_url is null or (char_length(thumbnail_url) between 1 and 2048 and left(thumbnail_url, 8) = 'https://'));

-- ---------------------------------------------------------------------
-- Delete existing rows. Logged, never silent -- see header. Expected
-- count is zero everywhere this migration is meant to run today.
-- ---------------------------------------------------------------------
do $$
declare
  deleted_count integer;
begin
  select count(*) into deleted_count from public.media_queue_items;

  delete from public.media_queue_items;

  if deleted_count > 0 then
    raise notice 'migration 0148: deleted % existing public.media_queue_items row(s) -- storage_url/thumbnail_url values have no lossless mapping to a gcs_object_key (see this migration''s header); these rows WERE renderable before this migration -- 0146''s module assigned storage_url directly to an <img>/<video> src with no CDN base involved, which is precisely the arbitrary-origin defect 0148 exists to close -- so this delete removes real, previously displayable creator configuration and is not a no-op', deleted_count;
  else
    raise notice 'migration 0148: 0 existing public.media_queue_items rows affected';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Column shape: mirrors migration 0143's soundboard object-key columns
-- EXACTLY. A key fragment cannot carry a scheme, a host or a `..`
-- traversal segment.
-- ---------------------------------------------------------------------
alter table public.media_queue_items drop column storage_url;
alter table public.media_queue_items drop column thumbnail_url;

alter table public.media_queue_items add column gcs_object_key text not null
  check (gcs_object_key ~ '^[A-Za-z0-9/_.-]{1,255}$' and gcs_object_key !~ '\.\.');

alter table public.media_queue_items add column thumbnail_gcs_object_key text
  check (
    thumbnail_gcs_object_key is null
    or (thumbnail_gcs_object_key ~ '^[A-Za-z0-9/_.-]{1,255}$' and thumbnail_gcs_object_key !~ '\.\.')
  );

comment on column public.media_queue_items.gcs_object_key is
  'PRF-02 media-url-hardening (0148): a content-key fragment, never a URL -- see migration 0143''s identical column for why this character set cannot carry a scheme or a host. Resolved to a playable URL server-side only, against config.mediaCdnBaseUrl (apps/api/src/db/media-queue-overlay-store.ts, apps/api/src/db/media-queue-store.ts), the same config value the soundboard overlay store already reads.';
comment on column public.media_queue_items.thumbnail_gcs_object_key is
  'PRF-02 media-url-hardening (0148): same shape as gcs_object_key, nullable -- an image has no separate thumbnail.';

-- =========================================================================
-- enqueue_media_queue_item: same role gate, same field validation shape as
-- migration 0146, with target_gcs_object_key / target_thumbnail_gcs_object_key
-- replacing target_storage_url / target_thumbnail_url. Validation mirrors
-- import_soundboard_catalogue_entry's object-key check (migration 0143)
-- exactly, in place of the https-prefix check it replaces.
-- =========================================================================
drop function app_private.enqueue_media_queue_item(uuid, text, text, text, text, text, integer, integer, integer);

create function app_private.enqueue_media_queue_item(
  target_channel_id uuid,
  target_title text,
  target_media_kind text,
  target_mime_type text,
  target_gcs_object_key text,
  target_thumbnail_gcs_object_key text default null,
  target_duration_ms integer default null,
  target_max_duration_ms integer default null,
  target_max_queue_items integer default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_id uuid;
  queued_count integer;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s media queue' using errcode = '42501';
  end if;

  if target_title is null or char_length(target_title) not between 1 and 120 then
    raise exception 'invalid media queue item title' using errcode = '22023';
  end if;

  if target_media_kind is null or target_media_kind not in ('image', 'gif', 'video') then
    raise exception 'invalid media kind' using errcode = '22023';
  end if;

  if target_mime_type is null or target_mime_type not in (
    'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'
  ) then
    raise exception 'invalid or disallowed media mime type' using errcode = '22023';
  end if;

  if target_gcs_object_key is null or target_gcs_object_key !~ '^[A-Za-z0-9/_.-]{1,255}$' or target_gcs_object_key ~ '\.\.' then
    raise exception 'invalid media object key' using errcode = '22023';
  end if;

  if target_thumbnail_gcs_object_key is not null and (
    target_thumbnail_gcs_object_key !~ '^[A-Za-z0-9/_.-]{1,255}$' or target_thumbnail_gcs_object_key ~ '\.\.'
  ) then
    raise exception 'invalid media thumbnail object key' using errcode = '22023';
  end if;

  if target_duration_ms is not null and target_duration_ms < 0 then
    raise exception 'invalid media duration' using errcode = '22023';
  end if;

  -- CONFIGURED BUT UNSET (migration 0146's header, unchanged by this
  -- migration). A null cap imposes no ceiling beyond what is already true
  -- today; neither number is invented here.
  if target_max_duration_ms is not null and target_duration_ms is not null
     and target_duration_ms > target_max_duration_ms then
    raise exception 'media duration exceeds the configured limit' using errcode = '22023';
  end if;

  if target_max_queue_items is not null then
    select count(*) into queued_count
      from public.media_queue_items
     where channel_id = target_channel_id
       and status = 'queued';
    if queued_count >= target_max_queue_items then
      raise exception 'media queue item limit reached' using errcode = '22023';
    end if;
  end if;

  new_id := gen_random_uuid();
  insert into public.media_queue_items (
    id, channel_id, created_by_user_id, title, media_kind, mime_type,
    gcs_object_key, thumbnail_gcs_object_key, duration_ms, status, enabled, created_at, updated_at
  ) values (
    new_id, target_channel_id, app_private.current_user_id(), target_title, target_media_kind, target_mime_type,
    target_gcs_object_key, target_thumbnail_gcs_object_key, target_duration_ms, 'queued', true, current_timestamp, current_timestamp
  );

  return new_id;
end
$$;

revoke execute on function app_private.enqueue_media_queue_item(uuid, text, text, text, text, text, integer, integer, integer) from public;
grant execute on function app_private.enqueue_media_queue_item(uuid, text, text, text, text, text, integer, integer, integer) to bsa_app;

-- =========================================================================
-- list_channel_media_queue_items: identical role gate and pagination
-- ceiling as migration 0146; returns gcs_object_key / thumbnail_gcs_object_key
-- in place of storage_url / thumbnail_url.
-- =========================================================================
drop function app_private.list_channel_media_queue_items(uuid, integer);

create function app_private.list_channel_media_queue_items(
  target_channel_id uuid,
  target_limit integer default null
)
returns table (
  media_queue_item_id uuid, title text, media_kind text, mime_type text,
  gcs_object_key text, thumbnail_gcs_object_key text, duration_ms integer,
  status text, enabled boolean, created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select item.id, item.title, item.media_kind, item.mime_type,
         item.gcs_object_key, item.thumbnail_gcs_object_key, item.duration_ms,
         item.status, item.enabled, item.created_at, item.updated_at
    from public.media_queue_items item
   where item.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
   order by item.created_at desc
   limit greatest(1, least(coalesce(target_limit, 100), 100))
$$;

revoke execute on function app_private.list_channel_media_queue_items(uuid, integer) from public;
grant execute on function app_private.list_channel_media_queue_items(uuid, integer) to bsa_app;

-- =========================================================================
-- list_overlay_media_queue: identical bearer-token gate and "current and
-- next" LIMIT 2 shape as migration 0146; returns gcs_object_key /
-- thumbnail_gcs_object_key in place of storage_url / thumbnail_url. URL
-- resolution against the configured CDN base happens ONLY in
-- apps/api/src/db/media-queue-overlay-store.ts, never in SQL -- the
-- identical structural position db/safe-soundboard-overlay-store.ts's
-- resolveSoundboardPlaybackUrl already occupies.
-- =========================================================================
drop function app_private.list_overlay_media_queue(uuid, text);

create function app_private.list_overlay_media_queue(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (
  queue_slot text,
  title text,
  media_kind text,
  mime_type text,
  gcs_object_key text,
  thumbnail_gcs_object_key text,
  duration_ms integer
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select case row_number() over (order by item.created_at asc, item.id asc)
           when 1 then 'current' else 'next' end,
         item.title, item.media_kind, item.mime_type,
         item.gcs_object_key, item.thumbnail_gcs_object_key, item.duration_ms
    from public.overlay_sessions session
    join public.media_queue_items item
      on item.channel_id = session.channel_id
     and item.status = 'queued'
     and item.enabled
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
   order by item.created_at asc, item.id asc
   limit 2
$$;

revoke execute on function app_private.list_overlay_media_queue(uuid, text) from public;
grant execute on function app_private.list_overlay_media_queue(uuid, text) to bsa_app;
