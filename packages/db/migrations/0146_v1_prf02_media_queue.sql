-- PRF-02 slice 7, §6 catalogue module #20 (Media / Meme Queue), and the
-- MINIMUM schema needed to render it.
--
-- Authority: FULL-PRODUCT-DEFINITION.md §6 module #20, §9.1.1, §12.6,
-- §12.7, §19.1, §30.3, MED-20, MED-21, and the owner decision of
-- 2026-09-17 recorded in bharatstudio-requirements/reviews/
-- 2026-09-17-remaining-eight-modules-and-youtube-v1-amendment.md, Part 1
-- §8 ("Media / Meme Queue (§6 #20): creator-only, and MED-20 says so").
--
-- Task record: bharatstudio-requirements/active/tasks/
-- PRF-02-slice-7-media-queue.md.
-- Decision record: bharatstudio-requirements/reviews/
-- 2026-09-17-prf-02-slice-7-media-queue-implementation.md.
--
-- MIGRATION NUMBER: 0146, pre-assigned to this task. Nothing here
-- renumbers or globs the migrations directory.
--
-- ============================================================
-- THE LOAD-BEARING CONSTRAINT: CREATOR-ONLY, AND THAT IS
-- ENFORCED STRUCTURALLY, NOT BY POLICY.
-- ============================================================
-- The owner's decision: "The creator queues their own media. Viewers
-- cannot submit." Viewer submission would make BharatStudio a host of
-- viewer-supplied media at broadcast volume, carrying the same rights,
-- storage and takedown posture as the §6 #6 soundboard uploads but at far
-- higher volume and with NO relationship to the person submitting.
-- Creator-only has none of that.
--
-- NOT AUTHORISED, and none of it exists anywhere in this file: a
-- submission endpoint, an approval queue, a viewer-facing surface of any
-- kind, a moderation queue, a rejection reason, or a submitter identity
-- field. Adding any of those is a NEW decision, not an extension.
--
-- THE ONLY WRITE GATE IS THE ROLE GATE, and it lives in SQL:
-- app_private.has_channel_role(channel, ['owner','admin']) -- the same
-- gate 0131, 0135, 0140 and 0142 use for their own creator-facing writes.
-- Every function that inserts or updates a row in this file requires it.
-- There is no code path anywhere in this migration, this slice's API
-- routes, or its overlay read that accepts a value from an unauthenticated
-- or viewer-scoped caller and turns it into a row: the overlay read
-- (list_overlay_media_queue, below) is SELECT-ONLY, takes an overlay
-- session bearer token, and is granted no write privilege of any kind.
--
-- packages/db/tests/prf02_slice7_media_queue.sql's own structural test
-- (MED20.1) scans every function this migration ships for the tokens
-- 'submit', 'submission', 'submitter', 'viewer_id', 'approve', 'approval'
-- and 'reject' and fails the suite if any appears -- so a future edit that
-- reaches for one turns that file red by name rather than passing because
-- a comment said not to. That same test also asserts, against
-- information_schema.columns, that no column on public.media_queue_items
-- is named submitter_id, submitted_by, viewer_id, submission_id or
-- approved_by, and that no second table exists for a submission queue.
--
-- ============================================================
-- STORAGE: §19.1, METADATA ONLY. NO bytea COLUMN.
-- ============================================================
-- MED-21 records that the bytea path (migrations 0067, 0077, 0106, 0110,
-- 0119) is LEGACY, kept only as a rollback route, and that new writes go
-- to GCS/CDN with Postgres holding metadata only. This migration follows
-- that directly rather than reusing the bytea pipeline the way the
-- soundboard's own reuse anchor does (the soundboard's owner decision
-- explicitly reuses migration 0110's creator-pack bytea storage; this
-- module may not, because the hard constraint governing this task
-- specifically forbids a bytea column here). public.media_queue_items
-- therefore carries `storage_url` and `thumbnail_url` TEXT columns
-- pointing at an already-hosted GCS/CDN asset -- never bytes, never an
-- upload/transcode pipeline of its own. Building that pipeline (content-
-- addressed tenant-scoped storage, transcode/normalise/pre-scale on
-- import) is register item INT-07, which is `new-record-required` and not
-- part of this slice; this migration assumes an asset already has a URL
-- by the time it reaches enqueue_media_queue_item, exactly as
-- payment_order_qr_codes (migration 0123) assumes a QR image already has
-- a URL by the time it reaches attach_provider_qr.
--
-- URL VALIDATION reuses migration 0123_v1_l19d_provider_qr_codes.sql:192's
-- exact shape (`left(value, 8) <> 'https://'`) rather than inventing a new
-- one: both storage_url and thumbnail_url must be non-empty, at most 2048
-- characters, and https-only. This is a structural safety floor, not a
-- provider integration -- no GCS SDK call, no signed-URL minting and no
-- bucket-naming scheme is added here or implied by this check.
--
-- ============================================================
-- §9.1.1: NO THIRD-PARTY CODE CAN REACH THE MASTER CANVAS, AND
-- THAT HOLDS BY CONSTRUCTION.
-- ============================================================
-- `mime_type` is a closed allow-list -- image/png, image/jpeg, image/webp,
-- image/gif, video/mp4, video/webm -- checked at the table AND re-checked
-- inside enqueue_media_queue_item before the insert. There is deliberately
-- no `text/html`, no `image/svg+xml` (SVG can carry inline script) and no
-- `application/*` of any kind. This is an allow-list a client cannot
-- widen: `additionalProperties: false` on the route body (see
-- apps/api/src/routes/media-queue.ts) means an unrecognised mime type is a
-- 400 before the store is ever called, and the CHECK constraint is the
-- second, independent floor under that. There is no field anywhere in
-- this schema, in the contracts, or in the renderer capable of carrying a
-- script, an iframe or a stylesheet -- the type has no slot for one.
--
-- THE PRECISE RULE THIS SATISFIES, QUOTED RATHER THAN PARAPHRASED:
-- FULL-PRODUCT-DEFINITION.md §9.1.1 states "BharatStudio never embeds an
-- ARBITRARY THIRD-PARTY browser-source URL, HTML, JavaScript, CSS or
-- iframe inside the Master Canvas. Ever." -- the operative word is
-- ARBITRARY: the rule bans embedding a foreign PAGE (a URL that grants
-- its host code execution, DOM access or a rendering surface inside the
-- Canvas -- an iframe src or a script src), not every URL of any kind.
-- §9.2 confirms this reading directly: a first-party Canvas package
-- explicitly bundles "images, video, audio and Lottie assets", so a
-- BharatStudio-served media reference is the sanctioned case, not the
-- forbidden one.
--
-- storage_url and thumbnail_url are loaded by the renderer as `<img>` /
-- `<video>` SOURCES ONLY, never as a script, an iframe or a stylesheet,
-- and the closed mime_type allow-list is what guarantees that stays true
-- regardless of which host eventually serves the bytes: a browser
-- decoding a response as image/png or video/mp4 cannot execute it as
-- code or use it to control the page, in exactly the way an `<img src>`
-- pointing at any CDN never grants that CDN script access to the page
-- embedding it. That is a different, narrower and strictly weaker
-- capability than an iframe or a script tag, and it is the ONLY
-- capability this column can ever carry.
--
-- ============================================================
-- RETENTION: THE UNIFORM POLICY (§12.6.2), NEVER PER-TIER, NEVER
-- SOLD.
-- ============================================================
-- §12.6.2 makes retention a schedule by data class, uniform across tiers.
-- A queued media item is a durable creator record (the same class
-- giveaways, tournaments and challenges already occupy), so it is kept
-- exactly as they are: no per-row expiry, no tier-scoped retention window,
-- and no purchase of additional retention. A Storage Pack, per §12.6.2,
-- "sells space for new uploads only" and never buys back access to
-- anything historical -- so even if a Storage Pack is purchased or
-- expires, it changes nothing about whether an EXISTING media_queue_items
-- row stays readable. There is no expires_at, no ttl and no purge job in
-- this file.
--
-- ============================================================
-- §12.6: NEVER TIER-GATE STORING, VIEWING, SEARCHING, FETCHING OR
-- EXPORTING A CREATOR'S OWN DURABLE RECORD.
-- ============================================================
-- enqueue_media_queue_item, list_channel_media_queue_items,
-- update_media_queue_item and set_media_queue_item_status read NO tier
-- and call NO entitlement function. Their only gate is the role gate
-- above. A Free creator can queue media, edit it, mark it played or
-- skipped, and read all of it back at any time; what a tier caps is
-- whether the CANVAS renders the module at all, and that is 0131's
-- existing, untouched, module-wide "Master Canvas modules active" cap
-- (Free 2 / Pro 5 / Creator 12 / Studio all) -- 'media_meme_queue' has
-- already been one of that check constraint's twenty catalogue keys since
-- migration 0131, so no schema change is needed here to gate the module
-- itself. §30.3 names no PER-MODULE entitlement row for Media / Meme
-- Queue the way it does for the Lobby/Tournament engine (Creator+) or for
-- single-elimination tournaments -- this module has exactly the one
-- generic gate every catalogue module already carries, and this migration
-- adds no second one.
--
-- A tier cap may limit what RENDERS on a live broadcast; it may never
-- hide or delete what the creator already has. There is no LIMIT clause
-- anywhere in list_channel_media_queue_items driven by tier, and no
-- WHERE clause filtering by status that would make an item invisible to
-- its own creator.
--
-- ============================================================
-- QUEUE DEPTH: "CURRENT AND NEXT", NEVER A QUEUE DEPTH NUMBER --
-- REUSED FROM THE MASTER CANVAS'S OWN EXISTING BOUND.
-- ============================================================
-- §12.7's Overlay row authorises "current and next alert state" in those
-- exact words, and this codebase already has a live instance of that
-- bound: apps/web/app/overlay/canvas/modules/support-theater-module.ts
-- (lines 68-72) renders "exactly the CURRENT displayed group ... and
-- exactly ONE next-up entry -- never a queue depth, never a second item
-- deeper in the queue." list_overlay_media_queue (below) reuses that
-- SAME shape rather than inventing a queue-depth number of its own: it
-- returns AT MOST TWO rows (`limit 2`), labelled 'current' and 'next',
-- and no aggregate queue-depth count is returned at all -- an overlay
-- token cannot learn how many items are queued, only what the next two
-- are. Nothing in this migration was free to choose 3, 5 or any other
-- number; the anchor already fixes it at 2.
--
-- ============================================================
-- MEDIA DURATION AND QUEUE-ITEM-COUNT CAPS: CONFIGURED BUT UNSET.
-- ============================================================
-- This task's own instructions define "configured but unset" as "unset
-- means today's behaviour, never a guessed default" -- the identical
-- posture apps/api/src/config.ts already documents for
-- reactionCloudSampleMax, overlayMaxInstanceSubscribers and
-- derivedReadMaxConcurrent: build the mechanism, thread the value through
-- from deployment configuration, and let an absent value mean no
-- additional ceiling beyond what already exists structurally.
--
-- Neither a maximum media duration nor a maximum number of items a
-- channel may have queued at once has been decided anywhere in the
-- register, and neither has an honest reuse anchor -- there is no
-- existing media-duration or per-module queue-depth-cap limit anywhere in
-- this schema to borrow. So enqueue_media_queue_item(...) takes
-- `target_max_duration_ms` and `target_max_queue_items` as NULLABLE
-- parameters, defaulting to null, enforced ONLY when a caller supplies a
-- value -- never invented here, never hard-coded, and never read from a
-- table this migration creates. Today, with both unset, the only bounds
-- on a queued item are the ones that already exist regardless: duration_ms
-- must be non-negative (a duration cannot be negative) and the storage
-- column's own text length limits.
--
-- NOTE, precisely because the point above matters: this is a DIFFERENT
-- choice from the sibling Soundboard module's (§6 #6) own decision, which
-- ships its equivalent caps "configured but unset" in the sense that the
-- UPLOAD CONTROL ITSELF is inert until a cap exists. That was THAT
-- module's own owner-recorded decision for an anonymous-volume risk
-- profile; this task's instructions define "unset" as "today's behaviour"
-- for THIS module, and Media / Meme Queue is creator-only with no
-- anonymous-volume risk to weigh against it, so the more permissive
-- (mechanism-built, value-absent) reading is the one applied here, and is
-- recorded rather than silently chosen.
--
-- ============================================================
-- WHY THIS IS NOT AN APPROVAL QUEUE, AND WHY THAT MATTERS FOR THE
-- COLUMN NAMES CHOSEN.
-- ============================================================
-- `status` carries exactly three PLAYBACK values -- 'queued', 'played',
-- 'skipped' -- never 'approved', 'rejected', 'pending_review' or anything
-- resembling a moderation state. The creator sets it because they queued
-- their own asset and are managing their own rotation, not because
-- something they did not upload is awaiting a decision. `enabled` is a
-- creator-only pause switch (temporarily pull an item from rotation
-- without losing the durable row, §12.6) and is likewise never a
-- moderation flag.
--
-- ROLLBACK: additive only.
--   drop function app_private.list_overlay_media_queue(uuid, text);
--   drop function app_private.set_media_queue_item_status(uuid, uuid, text);
--   drop function app_private.update_media_queue_item(uuid, uuid, text, boolean);
--   drop function app_private.list_channel_media_queue_items(uuid, integer);
--   drop function app_private.enqueue_media_queue_item(uuid, text, text, text, text, text, integer, integer, integer);
--   drop table public.media_queue_items;
-- No existing table, column, constraint, trigger, function, index or row
-- is created, altered or deleted by this migration, and 0131's module
-- catalogue already carries 'media_meme_queue' -- so dropping the five
-- objects above leaves the entitlement ladder, the module catalogue and
-- every other overlay read byte-for-byte unaffected. That drop DOES
-- delete every queued media item (there is no other way to undo a create
-- table); it is an operator-initiated rollback of the whole capability,
-- not a downgrade. No production migration without separate explicit
-- approval.

-- =========================================================================
-- media_queue_items: one row per media item a CREATOR queued for their own
-- broadcast. A title, a kind, a CDN pointer, a playback lifecycle, and
-- NOTHING ELSE.
--
-- Deliberately absent, one by one: no submitter/submission column of any
-- kind, no viewer_id, no approval/rejection column, no moderation queue,
-- no bytea column (§19.1, MED-21), no expiry/ttl (§12.6.2's uniform
-- policy), no per-tier cap column (§12.6), and no field capable of
-- carrying a script, an iframe or a stylesheet (§9.1.1).
-- =========================================================================
create table public.media_queue_items (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  -- The CREATOR who queued this item. This is an ownership/audit column,
  -- the same role every created_by_user_id column plays on giveaways
  -- (0142), tournaments (0142) and lobby_sessions (0140) -- it is never a
  -- distinct "submitter identity" concept, because there is no submitter
  -- other than the creator: only app_private.has_channel_role's
  -- owner/admin gate can ever cause a row to exist here.
  created_by_user_id uuid not null references public.app_users(id),
  -- Reuses the already-decided title bound verbatim: 1-120 characters,
  -- from packages/db/migrations/0109_v1_l17_paid_challenges.sql:67
  -- (`check (char_length(title) between 1 and 120)`), the same bound
  -- 0135's mission objective reuses. No separate limit was chosen here.
  title text not null check (char_length(title) between 1 and 120),
  -- §9.1.1 structural allow-list, not a business number: what KIND of
  -- asset this is, closed to the three kinds the mime_type allow-list
  -- below can express.
  media_kind text not null check (media_kind in ('image', 'gif', 'video')),
  -- §9.1.1: closed allow-list. No text/html, no image/svg+xml (SVG can
  -- carry inline script) and no application/* of any kind -- nothing here
  -- can ever describe a document capable of executing code on the Canvas.
  mime_type text not null check (mime_type in (
    'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'
  )),
  -- §19.1 / MED-21: METADATA ONLY. This points at an already-hosted
  -- GCS/CDN asset; no bytes ever pass through this column or this
  -- migration. Validation reuses migration
  -- 0123_v1_l19d_provider_qr_codes.sql:192's exact https-only shape.
  storage_url text not null check (
    char_length(storage_url) between 1 and 2048 and left(storage_url, 8) = 'https://'
  ),
  thumbnail_url text check (
    thumbnail_url is null
    or (char_length(thumbnail_url) between 1 and 2048 and left(thumbnail_url, 8) = 'https://')
  ),
  -- Nullable: an image has none. Never negative. The upper bound is
  -- CONFIGURED BUT UNSET -- see the header -- and is enforced only inside
  -- enqueue_media_queue_item, which is the one place a deployment-supplied
  -- cap can be threaded through; a table CHECK constraint cannot read
  -- configuration.
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  -- PLAYBACK lifecycle only -- see the header for why these three words
  -- and no others. Never a moderation state.
  status text not null default 'queued' check (status in ('queued', 'played', 'skipped')),
  -- Creator-only pause switch. Pulling an item from rotation is never a
  -- delete (§12.6): the durable row stays exactly as it is.
  enabled boolean not null default true,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

-- The creator's own list, newest first, durable and complete regardless of
-- status or enabled (§12.6: never hide what the creator already has).
create index media_queue_items_channel_created_idx
  on public.media_queue_items (channel_id, created_at desc);

-- The overlay's "current and next" read (§12.7, see header): the live
-- rotation only, oldest-first so a FIFO queue plays in the order items
-- were added. A partial index -- played/skipped/disabled items are never
-- visited by the overlay path at all, the same shape 0142's
-- giveaways_channel_open_idx and tournaments_channel_running_idx use for
-- their own "current state only" guarantee.
create index media_queue_items_channel_live_idx
  on public.media_queue_items (channel_id, created_at asc)
  where status = 'queued' and enabled;

alter table public.media_queue_items enable row level security;
revoke all on public.media_queue_items from public;
revoke all on public.media_queue_items from bsa_app;

-- =========================================================================
-- enqueue_media_queue_item: owner/admin only. The one and only insert path
-- for this table -- see the header's load-bearing constraint. Validates
-- every field against the allow-lists and bounds the header documents,
-- and enforces the two CONFIGURED-BUT-UNSET caps only when a caller
-- supplies one.
-- =========================================================================
create or replace function app_private.enqueue_media_queue_item(
  target_channel_id uuid,
  target_title text,
  target_media_kind text,
  target_mime_type text,
  target_storage_url text,
  target_thumbnail_url text default null,
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

  if target_storage_url is null or char_length(target_storage_url) not between 1 and 2048
     or left(target_storage_url, 8) <> 'https://' then
    raise exception 'invalid media storage url' using errcode = '22023';
  end if;

  if target_thumbnail_url is not null and (
    char_length(target_thumbnail_url) not between 1 and 2048
    or left(target_thumbnail_url, 8) <> 'https://'
  ) then
    raise exception 'invalid media thumbnail url' using errcode = '22023';
  end if;

  if target_duration_ms is not null and target_duration_ms < 0 then
    raise exception 'invalid media duration' using errcode = '22023';
  end if;

  -- CONFIGURED BUT UNSET (see header). A null cap imposes no ceiling
  -- beyond what is already true today; neither number is invented here.
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
    storage_url, thumbnail_url, duration_ms, status, enabled, created_at, updated_at
  ) values (
    new_id, target_channel_id, app_private.current_user_id(), target_title, target_media_kind, target_mime_type,
    target_storage_url, target_thumbnail_url, target_duration_ms, 'queued', true, current_timestamp, current_timestamp
  );

  return new_id;
end
$$;

revoke execute on function app_private.enqueue_media_queue_item(uuid, text, text, text, text, text, integer, integer, integer) from public;
grant execute on function app_private.enqueue_media_queue_item(uuid, text, text, text, text, text, integer, integer, integer) to bsa_app;

-- =========================================================================
-- list_channel_media_queue_items: the creator's own durable read. Every
-- status, every enabled/disabled item, forever (§12.6) -- paginated with
-- the SAME cursor-safety ceiling migration 0137's cursor reads already
-- use (`greatest(1, least(target_limit, 100))`,
-- packages/db/migrations/0137_v1_rt01_overlay_events_cursor_parameters.sql:101),
-- an engineering pagination floor rather than a product-decided queue
-- depth.
-- =========================================================================
create or replace function app_private.list_channel_media_queue_items(
  target_channel_id uuid,
  target_limit integer default null
)
returns table (
  media_queue_item_id uuid, title text, media_kind text, mime_type text,
  storage_url text, thumbnail_url text, duration_ms integer,
  status text, enabled boolean, created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select item.id, item.title, item.media_kind, item.mime_type,
         item.storage_url, item.thumbnail_url, item.duration_ms,
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
-- update_media_queue_item: owner/admin only, addressed by item id. Title
-- and the enabled pause switch -- see the header for why enabled is never
-- a moderation flag. NOT-FOUND AND NOT-AUTHORIZED ARE THE SAME ANSWER
-- (P0002), the identical shape 0142's update_giveaway_entry_count uses.
-- =========================================================================
create or replace function app_private.update_media_queue_item(
  target_channel_id uuid,
  target_item_id uuid,
  target_title text,
  target_enabled boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare affected integer;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'media queue item not found' using errcode = 'P0002';
  end if;

  if target_title is null or char_length(target_title) not between 1 and 120 then
    raise exception 'invalid media queue item title' using errcode = '22023';
  end if;

  if target_enabled is null then
    raise exception 'invalid media queue item enabled flag' using errcode = '22023';
  end if;

  update public.media_queue_items
     set title = target_title,
         enabled = target_enabled,
         updated_at = current_timestamp
   where id = target_item_id
     and channel_id = target_channel_id;

  get diagnostics affected = row_count;
  if affected = 0 then
    raise exception 'media queue item not found' using errcode = 'P0002';
  end if;
end
$$;

revoke execute on function app_private.update_media_queue_item(uuid, uuid, text, boolean) from public;
grant execute on function app_private.update_media_queue_item(uuid, uuid, text, boolean) to bsa_app;

-- =========================================================================
-- set_media_queue_item_status: owner/admin only, addressed by item id.
-- PLAYBACK lifecycle only -- 'queued', 'played', 'skipped' -- never a
-- moderation decision. Marking an item played or skipped does not delete
-- it (§12.6); it simply removes it from the "current and next" overlay
-- read's live rotation (the partial index above), and it stays in the
-- creator's own durable list forever.
-- =========================================================================
create or replace function app_private.set_media_queue_item_status(
  target_channel_id uuid,
  target_item_id uuid,
  target_status text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare affected integer;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'media queue item not found' using errcode = 'P0002';
  end if;

  if target_status is null or target_status not in ('queued', 'played', 'skipped') then
    raise exception 'invalid media queue item status' using errcode = '22023';
  end if;

  update public.media_queue_items
     set status = target_status,
         updated_at = current_timestamp
   where id = target_item_id
     and channel_id = target_channel_id;

  get diagnostics affected = row_count;
  if affected = 0 then
    raise exception 'media queue item not found' using errcode = 'P0002';
  end if;
end
$$;

revoke execute on function app_private.set_media_queue_item_status(uuid, uuid, text) from public;
grant execute on function app_private.set_media_queue_item_status(uuid, uuid, text) to bsa_app;

-- =========================================================================
-- list_overlay_media_queue: the AGGREGATE-FREE overlay read -- "current
-- and next", never a queue depth. See the header for the exact anchor
-- (support-theater-module.ts:68-72) this bound is reused from.
--
-- SELECT-ONLY. This function is granted no write privilege of any kind,
-- takes an overlay session bearer token exactly like
-- list_overlay_giveaway_tournament (migration 0142), and is the ONLY
-- surface a viewer's browser source can ever reach. It returns AT MOST
-- TWO rows and no item id, no submitter, no viewer identity and no
-- channel-wide queue-depth count -- there is nothing on this path for a
-- future read to start correlating one visit to another with, because
-- there is no per-viewer row anywhere in this schema for it to join to in
-- the first place.
-- =========================================================================
create or replace function app_private.list_overlay_media_queue(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (
  queue_slot text,
  title text,
  media_kind text,
  mime_type text,
  storage_url text,
  thumbnail_url text,
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
         item.storage_url, item.thumbnail_url, item.duration_ms
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
