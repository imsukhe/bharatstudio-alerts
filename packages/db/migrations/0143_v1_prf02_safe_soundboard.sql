-- PRF-02 slice 7, §6 catalogue module #6 (Safe Soundboard Alert), and the
-- minimum schema behind it.
--
-- Authority: FULL-PRODUCT-DEFINITION.md §6 module #6, §9.1.1, §12.6,
-- §12.6.2, §12.7, §18 (18.1, 18.2), §19.1, §30.3, AUD-03, AUD-06, and the
-- owner decision of 2026-09-17 recorded in bharatstudio-requirements/
-- reviews/2026-09-17-remaining-eight-modules-and-youtube-v1-amendment.md
-- Part 1 §1.
--
-- Task record: bharatstudio-requirements/active/tasks/
-- PRF-02-slice-7-safe-soundboard.md.
--
-- MIGRATION NUMBER: 0143, assigned to this task. Nothing is renumbered and
-- no other number is written here.
--
-- ============================================================
-- THE NAME IS ABOUT THE BROADCAST, NOT THE CONTENT. READ THIS FIRST.
-- ============================================================
-- "Safe Soundboard Alert" describes playback being safe for a live
-- broadcast (no arbitrary code, no arbitrary URL, no arbitrary embed --
-- see §9.1.1 below), never that a clip's CONTENT has been vetted. The
-- 2026-09-17 decision is explicit and binding: no UI copy, no schema
-- comment other than this file's own explanatory prose, no API field and
-- no test name may claim a clip is "safe", "approved", "checked",
-- "reviewed", "vetted" or "curated". A creator's own uploaded clip plays
-- WITHOUT ANY REVIEW STEP -- uploading to your own soundboard is
-- publishing your own content to your own stream, exactly as every other
-- creator-authored asset in this product already works, and naming a
-- review queue nobody staffs would be worse than having none.
--
-- NOT AUTHORISED, NAMED ONE BY ONE, AND NONE OF IT IS HERE: a takedown
-- flow, a reporting surface, automated content scanning, or any
-- content-rating column. Grep this file for "rating", "report", "scan",
-- "takedown", "moderat" -- there is no column and no function for any of
-- them.
--
-- ============================================================
-- TWO SOURCES, ONE PLAYBACK PATH.
-- ============================================================
-- `soundboard_catalogue_entries` is the first-party clip set BharatStudio
-- authors and imports (mirrors `sticker_catalogue_entries`, migration
-- 0110, exactly in shape: upsert-by-external_key, a tier floor, a
-- per-channel disable). `channel_soundboard_uploads` is a creator's own
-- clip, usable the instant its row exists -- no status column, no
-- moderation_state, nothing to be "pending" in, because there is no state
-- between "uploaded" and "playable" for this path to occupy.
--
-- ============================================================
-- §19.1: GCS/CDN, METADATA ONLY. NO `bytea` COLUMN EXISTS IN THIS FILE.
-- ============================================================
-- §19.1.1 is explicit that `bytea` "does not extend to audio and GIF
-- libraries" and must not be copied forward from 0110's sticker design.
-- Every clip here is a Postgres METADATA row (id, channel, key, hash,
-- mime, size, duration) pointing at bytes that live in GCS behind a CDN;
-- Postgres never holds the bytes. `gcs_object_key` is constrained to a
-- narrow character set (see the column definition) precisely so this
-- field can never carry a scheme, a host or a `..` traversal segment --
-- it is a content-addressed key fragment the API server appends to its
-- OWN configured CDN base, never a caller-supplied URL. That is what
-- keeps this migration inside §9.1.1: there is no field anywhere in this
-- file capable of carrying third-party code, a third-party URL, an
-- iframe or a stylesheet onto the Master Canvas.
--
-- Tenant-scoped content addressing (§19.1's corrected 2026-09-14 rule):
-- an upload's key is deterministically `channel_id` + `content_sha256`,
-- computed by `upload_channel_soundboard_clip` itself, never accepted
-- verbatim from the caller. A first-party catalogue import's key is
-- supplied by the (trusted, internal) import caller, exactly as 0110's
-- `import_sticker_catalogue_entry` trusts its own caller for
-- `target_asset_bytes` after that caller has already validated it.
--
-- ============================================================
-- DURATION AND FILE-SIZE CAPS: CONFIGURED BUT UNSET, ON PURPOSE.
-- ============================================================
-- The 2026-09-17 decision is explicit: "there is no existing audio-
-- duration limit anywhere in the register" for a per-clip cap, so none is
-- invented here. `upload_channel_soundboard_clip` takes
-- `target_max_duration_seconds` and `target_max_byte_size` as PARAMETERS
-- (the API layer reads them from config, not from this schema) and its
-- very first check is that BOTH are non-null -- if either is null, the
-- upload is refused outright with a dedicated error code. UNSET DOES NOT
-- MEAN UNLIMITED: it means the upload control is INERT, exactly as the
-- decision requires. There is no column in `channel_soundboard_uploads`
-- storing a cap, because a cap is a deployment-time config value, not a
-- durable fact about a clip.
--
-- First-party catalogue clips are UNAFFECTED by this gate: they are
-- pre-authored by BharatStudio, not uploaded through this check, and
-- `import_soundboard_catalogue_entry` takes no cap parameter at all.
--
-- ============================================================
-- COOLDOWN: ALSO CONFIGURED-BUT-UNSET, WHICH TODAY MEANS "NONE".
-- ============================================================
-- The §6 catalogue row text carries forward "with cooldown and queue"
-- from the module's original template description. No cooldown VALUE is
-- decided anywhere in this repository (grepped: no migration mentions
-- "cooldown" before this one), so none is invented. `trigger_soundboard_
-- play` applies NO rate limit of any kind. When a cooldown number is
-- decided, it is a straightforward addition of the same
-- window-plus-counter shape 0139's `channel_reaction_rate_limits`
-- already uses -- not a redesign.
--
-- ============================================================
-- "QUEUE" IS "THE MOST RECENT TRIGGER", NOT A NEVER-DROP FIFO.
-- ============================================================
-- Every other Master Canvas card built in this program (lobby status,
-- giveaway/tournament, moderator status) exposes a single CURRENT
-- aggregate snapshot that the overlay polls, and none of them carries a
-- consumed/acknowledged queue -- see db/giveaway-tournament-overlay-
-- store.ts's own header for why: RT-10/RT-11's derivedReadSql pool is
-- reads only, and a write-on-read "pop the queue" design would misuse
-- it. This slice follows that same shape: `channel_soundboard_plays` is
-- an append-only trigger log, and the overlay read
-- (`list_overlay_soundboard_play`) returns only the SINGLE most recent
-- trigger for the channel. The overlay client remembers the last play id
-- it has already played and treats a repeat as a no-op; two triggers
-- inside one poll interval mean the earlier one is silently superseded.
-- A never-drop multi-item queue needs either a decided ordering-depth
-- bound or a write path on the overlay's read pool, and neither exists
-- today -- building one now would be inventing scope this decision does
-- not authorise. This is recorded as an open item, not hidden.
--
-- ============================================================
-- NO SUPPORTER-TRIGGER PATH IN THIS SLICE (AUD-03 STAYS OPEN).
-- ============================================================
-- §31.17's AUD-03 ("Supporter-triggerable soundboard") and the §18.1
-- prose ("soundboard clips triggerable by supporters") describe a
-- future viewer-facing trigger, most likely attached to a paid tip the
-- way 0110's `attach_sticker_to_tip` attaches a sticker selection. The
-- 2026-09-17 decision for module #6 authorises exactly two things:
-- sourcing (catalogue + upload) and the no-review-step upload rule. It
-- does not authorise a new payment-attached trigger surface, and
-- building one silently would be scope creep with real payment-adjacent
-- consequences. So this migration gives the CREATOR a trigger function
-- (`trigger_soundboard_play`, role-gated exactly like every other
-- creator write in this program) and leaves the supporter path for a
-- separate, explicitly authorised decision. Named as a blocker in the
-- task record, not built around.
--
-- ============================================================
-- TIER: THE MODULE IS GATED, THE CREATOR'S OWN RECORD NEVER IS (§12.6).
-- ============================================================
-- §30.3 lists "Sound Moments (catalogue)" as Pro+ (Free: none) and
-- "Creator sound uploads" as a per-tier COUNT ladder: Free 0, Pro 5,
-- Creator 25, Studio 100. Both are already-decided numbers reused
-- verbatim here (`soundboard_module_entitled`,
-- `soundboard_upload_tier_limit`) -- they are not the undecided
-- per-clip duration/size caps above; they are a different, already-
-- specified axis (module availability and upload COUNT, not per-clip
-- size). Storing, viewing, enabling/disabling and uploading a creator's
-- own durable record is NEVER tier-gated (§12.6): a Free creator can
-- still manage their catalogue selections and upload nothing (their
-- limit is zero, enforced the same way as everyone else's, not by a
-- separate rule); a Pro creator can upload up to five. What §30.3 gates
-- is the CANVAS rendering the card, and that lives in exactly one place:
-- inside `list_overlay_soundboard_play`.
--
-- ============================================================
-- AUD-06: RIGHTS ATTESTATION, REUSED RATHER THAN INVENTED.
-- ============================================================
-- §18.2 requires "a positive attestation of rights -- a checkbox with a
-- recorded timestamp" for any creator audio/media upload, and AUD-06
-- names this as a decided, v1, P1 backlog item. `channel_soundboard_
-- uploads.rights_attested_at` is that timestamp, recorded only when the
-- caller passes `target_rights_attested = true`; a false or missing
-- attestation is refused before any other check runs. This is a legal
-- consent record, categorically different from content review, and is
-- required at every tier that can upload at all.
--
-- ROLLBACK: additive only.
--   drop function app_private.list_overlay_soundboard_play(uuid, text);
--   drop function app_private.trigger_soundboard_play(uuid, uuid, uuid);
--   drop function app_private.upload_channel_soundboard_clip(uuid, text, text, text, integer, integer, boolean, integer, integer);
--   drop function app_private.list_channel_soundboard_uploads(uuid);
--   drop function app_private.set_channel_soundboard_catalogue_enabled(uuid, uuid, boolean);
--   drop function app_private.list_soundboard_catalogue_for_channel(uuid);
--   drop function app_private.import_soundboard_catalogue_entry(text, text, text, text, text, text, text, integer, integer);
--   drop function app_private.soundboard_module_entitled(uuid);
--   drop function app_private.soundboard_upload_tier_limit(text);
--   drop function app_private.soundboard_tier_rank(text);
--   drop table public.channel_soundboard_plays;
--   drop table public.channel_soundboard_uploads;
--   drop table public.channel_soundboard_disables;
--   drop table public.soundboard_catalogue_entries;
-- No existing table, column, constraint, trigger, function, index or row
-- is created, altered or deleted by this migration. No production
-- migration without separate explicit approval.

-- =========================================================================
-- soundboard_catalogue_entries: BharatStudio-authored first-party clips.
-- Metadata only -- see header. Identity key is external_key, mirroring
-- 0110's sticker_catalogue_entries design exactly.
-- =========================================================================
create table public.soundboard_catalogue_entries (
  id uuid primary key,
  external_key text not null check (char_length(external_key) between 1 and 64),
  -- 1-120 is not invented here: it is 0109's title-text bound, already
  -- reused by 0135, and reused again for the identical "short creator-
  -- facing label" reason.
  display_name text not null check (char_length(display_name) between 1 and 120),
  category text not null check (char_length(category) between 1 and 60),
  min_tier text not null check (min_tier in ('free', 'pro', 'creator', 'studio')),
  -- Content-addressed GCS key fragment. The restricted character set is
  -- what keeps this column incapable of carrying a scheme, a host or a
  -- `..` traversal segment -- see header, §9.1.1.
  gcs_object_key text not null check (gcs_object_key ~ '^[A-Za-z0-9/_.-]{1,255}$' and gcs_object_key !~ '\.\.'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check (mime_type ~ '^audio/[a-z0-9.+-]+$'),
  -- Metadata only, first-party pre-authored clips. No upper bound at the
  -- catalogue level -- see header ("first-party clips are unaffected").
  byte_size integer not null check (byte_size > 0),
  duration_seconds integer not null check (duration_seconds > 0),
  imported_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (external_key),
  unique (gcs_object_key)
);

alter table public.soundboard_catalogue_entries enable row level security;
revoke all on public.soundboard_catalogue_entries from public;
revoke all on public.soundboard_catalogue_entries from bsa_app;

-- =========================================================================
-- channel_soundboard_disables: presence = this channel turned this
-- catalogue entry off. No row = enabled (subject to tier eligibility).
-- Mirrors channel_sticker_disables (0110) exactly.
-- =========================================================================
create table public.channel_soundboard_disables (
  channel_id uuid not null references public.channels(id),
  sound_id uuid not null references public.soundboard_catalogue_entries(id),
  disabled_at timestamptz not null default current_timestamp,
  primary key (channel_id, sound_id)
);

alter table public.channel_soundboard_disables enable row level security;
revoke all on public.channel_soundboard_disables from public;
revoke all on public.channel_soundboard_disables from bsa_app;

-- =========================================================================
-- channel_soundboard_uploads: a creator's own clip. Playable the instant
-- the row exists -- no review, no moderation_state, no status column of
-- any kind. See header for AUD-06's rights_attested_at.
-- =========================================================================
create table public.channel_soundboard_uploads (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  display_name text not null check (char_length(display_name) between 1 and 120),
  gcs_object_key text not null check (gcs_object_key ~ '^[A-Za-z0-9/_.-]{1,255}$' and gcs_object_key !~ '\.\.'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check (mime_type ~ '^audio/[a-z0-9.+-]+$'),
  byte_size integer not null check (byte_size > 0),
  duration_seconds integer not null check (duration_seconds > 0),
  -- AUD-06 / §18.2. Never null: a row cannot exist without this having
  -- been recorded true at insert time (enforced in
  -- upload_channel_soundboard_clip, not by a default here).
  rights_attested_at timestamptz not null,
  uploaded_at timestamptz not null default current_timestamp,
  -- Tenant-scoped content addressing (§19.1): dedup within one channel
  -- only, never global -- a global unique key would let one creator's
  -- upload reveal that another creator already holds identical bytes.
  unique (channel_id, content_sha256),
  unique (gcs_object_key)
);

alter table public.channel_soundboard_uploads enable row level security;
revoke all on public.channel_soundboard_uploads from public;
revoke all on public.channel_soundboard_uploads from bsa_app;

-- =========================================================================
-- channel_soundboard_plays: an append-only trigger log. Exactly one of
-- catalogue_entry_id / upload_id is set -- never both, never neither.
-- No viewer/supporter column exists anywhere on this table -- see header,
-- "no supporter-trigger path in this slice".
-- =========================================================================
create table public.channel_soundboard_plays (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  catalogue_entry_id uuid references public.soundboard_catalogue_entries(id),
  upload_id uuid references public.channel_soundboard_uploads(id),
  created_at timestamptz not null default current_timestamp,
  constraint channel_soundboard_plays_exactly_one_source
    check ((catalogue_entry_id is null) <> (upload_id is null))
);

create index channel_soundboard_plays_channel_created_idx
  on public.channel_soundboard_plays (channel_id, created_at desc);

alter table public.channel_soundboard_plays enable row level security;
revoke all on public.channel_soundboard_plays from public;
revoke all on public.channel_soundboard_plays from bsa_app;

-- Same fail-closed shape as sticker_tier_rank (0110), template_tier_rank
-- (0106) and tier_custom_branding_allowed (0077): each domain keeps its
-- own copy of this rank rather than sharing one, per those files' own
-- headers, and this one follows the convention rather than breaking it.
create or replace function app_private.soundboard_tier_rank(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 0;
    when 'pro' then return 1;
    when 'creator' then return 2;
    when 'studio' then return 3;
    else raise exception 'unrecognised tier for soundboard entitlement: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.soundboard_tier_rank(text) from public;
grant execute on function app_private.soundboard_tier_rank(text) to bsa_app;

-- §30.3's "Creator sound uploads" row: Free 0, Pro 5, Creator 25,
-- Studio 100. Reused verbatim, not chosen here.
create or replace function app_private.soundboard_upload_tier_limit(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 0;
    when 'pro' then return 5;
    when 'creator' then return 25;
    when 'studio' then return 100;
    else raise exception 'unrecognised tier for soundboard upload limit: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.soundboard_upload_tier_limit(text) from public;
grant execute on function app_private.soundboard_upload_tier_limit(text) to bsa_app;

-- §30.3's "Sound Moments (catalogue)" row: Free is excluded outright
-- (Pro+ only). This is the MODULE gate; see header, §12.6 -- it is never
-- applied to the creator's own catalogue/upload management routes.
create or replace function app_private.soundboard_module_entitled(target_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select app_private.soundboard_tier_rank(app_private.current_channel_tier(target_channel_id))
      >= app_private.soundboard_tier_rank('pro')
$$;

revoke execute on function app_private.soundboard_module_entitled(uuid) from public;
grant execute on function app_private.soundboard_module_entitled(uuid) to bsa_app;

-- Import/seed boundary for the first-party catalogue. Upsert-by-
-- external_key, mirrors import_sticker_catalogue_entry (0110) exactly,
-- minus the bytea hash computation -- the caller (a trusted internal
-- import path, never end-user input) already has the object's sha256
-- because it computed it before uploading the bytes to GCS.
create or replace function app_private.import_soundboard_catalogue_entry(
  target_external_key text,
  target_display_name text,
  target_category text,
  target_min_tier text,
  target_gcs_object_key text,
  target_content_sha256 text,
  target_mime_type text,
  target_byte_size integer,
  target_duration_seconds integer
)
returns table (outcome text, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing record;
  new_id uuid;
begin
  if target_external_key is null or char_length(target_external_key) not between 1 and 64 then
    raise exception 'invalid soundboard external_key' using errcode = '22023';
  end if;
  if target_display_name is null or char_length(target_display_name) not between 1 and 120 then
    raise exception 'invalid soundboard display_name' using errcode = '22023';
  end if;
  if target_category is null or char_length(target_category) not between 1 and 60 then
    raise exception 'invalid soundboard category' using errcode = '22023';
  end if;
  perform app_private.soundboard_tier_rank(target_min_tier);
  if target_gcs_object_key is null or target_gcs_object_key !~ '^[A-Za-z0-9/_.-]{1,255}$' or target_gcs_object_key ~ '\.\.' then
    raise exception 'invalid soundboard object key' using errcode = '22023';
  end if;
  if target_content_sha256 is null or target_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid soundboard content hash' using errcode = '22023';
  end if;
  if target_mime_type is null or target_mime_type !~ '^audio/[a-z0-9.+-]+$' then
    raise exception 'invalid soundboard mime type' using errcode = '22023';
  end if;
  if target_byte_size is null or target_byte_size <= 0 then
    raise exception 'invalid soundboard byte size' using errcode = '22023';
  end if;
  if target_duration_seconds is null or target_duration_seconds <= 0 then
    raise exception 'invalid soundboard duration' using errcode = '22023';
  end if;

  select id, gcs_object_key, content_sha256, display_name, category, min_tier, mime_type, byte_size, duration_seconds
    into existing
    from public.soundboard_catalogue_entries
   where external_key = target_external_key;

  if not found then
    new_id := gen_random_uuid();
    insert into public.soundboard_catalogue_entries
      (id, external_key, display_name, category, min_tier, gcs_object_key, content_sha256, mime_type, byte_size, duration_seconds, imported_at, updated_at)
    values
      (new_id, target_external_key, target_display_name, target_category, target_min_tier, target_gcs_object_key, target_content_sha256, target_mime_type, target_byte_size, target_duration_seconds, current_timestamp, current_timestamp);
    return query select 'created'::text, new_id;
    return;
  end if;

  if existing.content_sha256 = target_content_sha256
     and existing.display_name = target_display_name
     and existing.category = target_category
     and existing.min_tier = target_min_tier
     and existing.gcs_object_key = target_gcs_object_key
     and existing.mime_type = target_mime_type
     and existing.byte_size = target_byte_size
     and existing.duration_seconds = target_duration_seconds then
    return query select 'skipped'::text, existing.id;
    return;
  end if;

  update public.soundboard_catalogue_entries
     set display_name = target_display_name,
         category = target_category,
         min_tier = target_min_tier,
         gcs_object_key = target_gcs_object_key,
         content_sha256 = target_content_sha256,
         mime_type = target_mime_type,
         byte_size = target_byte_size,
         duration_seconds = target_duration_seconds,
         updated_at = current_timestamp
   where id = existing.id;

  return query select 'updated'::text, existing.id;
end
$$;

revoke execute on function app_private.import_soundboard_catalogue_entry(text, text, text, text, text, text, text, integer, integer) from public;
grant execute on function app_private.import_soundboard_catalogue_entry(text, text, text, text, text, text, text, integer, integer) to bsa_app;

-- Creator-facing catalogue list. NEVER TIER-GATED (§12.6): every entry is
-- listed regardless of the channel's own tier, with `enabled` reflecting
-- only the presence-based disable -- a creator can always SEE and manage
-- their catalogue selections; whether the CARD renders on the canvas is
-- decided later, in list_overlay_soundboard_play alone.
create or replace function app_private.list_soundboard_catalogue_for_channel(
  target_channel_id uuid
)
returns table (id uuid, external_key text, display_name text, category text, min_tier text, byte_size integer, duration_seconds integer, enabled boolean, updated_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select entry.id, entry.external_key, entry.display_name, entry.category, entry.min_tier,
         entry.byte_size, entry.duration_seconds, (disable.sound_id is null), entry.updated_at
    from public.soundboard_catalogue_entries entry
    left join public.channel_soundboard_disables disable
      on disable.channel_id = target_channel_id and disable.sound_id = entry.id
   where app_private.can_access_channel(target_channel_id)
   order by entry.category, entry.external_key
$$;

revoke execute on function app_private.list_soundboard_catalogue_for_channel(uuid) from public;
grant execute on function app_private.list_soundboard_catalogue_for_channel(uuid) to bsa_app;

-- Creator enable/disable. Owner/admin only, single insert/delete, live on
-- the very next read -- mirrors set_channel_sticker_enabled (0110)
-- exactly.
create or replace function app_private.set_channel_soundboard_catalogue_enabled(
  target_channel_id uuid,
  target_sound_id uuid,
  target_enabled boolean
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s soundboard' using errcode = '42501';
  end if;

  if not exists (select 1 from public.soundboard_catalogue_entries where id = target_sound_id) then
    raise exception 'unknown soundboard catalogue entry' using errcode = '22023';
  end if;

  if target_enabled then
    delete from public.channel_soundboard_disables
     where channel_id = target_channel_id and sound_id = target_sound_id;
  else
    insert into public.channel_soundboard_disables (channel_id, sound_id, disabled_at)
    values (target_channel_id, target_sound_id, current_timestamp)
    on conflict (channel_id, sound_id) do nothing;
  end if;

  return target_enabled;
end
$$;

revoke execute on function app_private.set_channel_soundboard_catalogue_enabled(uuid, uuid, boolean) from public;
grant execute on function app_private.set_channel_soundboard_catalogue_enabled(uuid, uuid, boolean) to bsa_app;

-- Creator-facing list of their own uploads. NEVER TIER-GATED (§12.6).
create or replace function app_private.list_channel_soundboard_uploads(
  target_channel_id uuid
)
returns table (id uuid, display_name text, byte_size integer, duration_seconds integer, uploaded_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select upload.id, upload.display_name, upload.byte_size, upload.duration_seconds, upload.uploaded_at
    from public.channel_soundboard_uploads upload
   where upload.channel_id = target_channel_id
     and app_private.can_access_channel(target_channel_id)
   order by upload.uploaded_at desc
$$;

revoke execute on function app_private.list_channel_soundboard_uploads(uuid) from public;
grant execute on function app_private.list_channel_soundboard_uploads(uuid) to bsa_app;

-- The upload path. Owner/admin only. See header for why BOTH cap
-- parameters being non-null is checked FIRST, before rights attestation,
-- before the tier count, before anything else: an inert control must
-- refuse identically regardless of what else is wrong with the request,
-- so nothing about a caller's input can be inferred from which check
-- fails first while caps are unset.
--
-- gcs_object_key is DERIVED here, never accepted from the caller --
-- tenant-scoped content addressing (§19.1): 'soundboard/' || channel_id
-- || '/' || sha256.
create or replace function app_private.upload_channel_soundboard_clip(
  target_channel_id uuid,
  target_display_name text,
  target_content_sha256 text,
  target_mime_type text,
  target_byte_size integer,
  target_duration_seconds integer,
  target_rights_attested boolean,
  target_max_duration_seconds integer,
  target_max_byte_size integer
)
returns table (outcome text, upload_id uuid, gcs_object_key text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_id uuid;
  computed_key text;
  current_tier text;
  upload_count integer;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to upload to this channel''s soundboard' using errcode = '42501';
  end if;

  -- CONFIGURED BUT UNSET (see header): unset must not mean unlimited. An
  -- absent cap on either axis makes the whole upload path inert.
  if target_max_duration_seconds is null or target_max_byte_size is null then
    raise exception 'soundboard upload caps are not configured' using errcode = '55000';
  end if;

  if target_rights_attested is distinct from true then
    raise exception 'rights attestation is required to upload a soundboard clip' using errcode = '22023';
  end if;

  if target_display_name is null or char_length(target_display_name) not between 1 and 120 then
    raise exception 'invalid soundboard display_name' using errcode = '22023';
  end if;
  if target_content_sha256 is null or target_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid soundboard content hash' using errcode = '22023';
  end if;
  if target_mime_type is null or target_mime_type !~ '^audio/[a-z0-9.+-]+$' then
    raise exception 'invalid soundboard mime type' using errcode = '22023';
  end if;
  if target_byte_size is null or target_byte_size <= 0 or target_byte_size > target_max_byte_size then
    raise exception 'soundboard clip exceeds the configured size cap' using errcode = '22023';
  end if;
  if target_duration_seconds is null or target_duration_seconds <= 0 or target_duration_seconds > target_max_duration_seconds then
    raise exception 'soundboard clip exceeds the configured duration cap' using errcode = '22023';
  end if;

  select app_private.current_channel_tier(target_channel_id) into current_tier;
  select count(*) into upload_count from public.channel_soundboard_uploads where channel_id = target_channel_id;
  if upload_count >= app_private.soundboard_upload_tier_limit(current_tier) then
    raise exception 'soundboard upload count limit reached for this channel''s tier' using errcode = '42501';
  end if;

  computed_key := 'soundboard/' || target_channel_id::text || '/' || target_content_sha256;
  new_id := gen_random_uuid();

  insert into public.channel_soundboard_uploads (
    id, channel_id, display_name, gcs_object_key, content_sha256, mime_type, byte_size, duration_seconds,
    rights_attested_at, uploaded_at
  ) values (
    new_id, target_channel_id, target_display_name, computed_key, target_content_sha256, target_mime_type,
    target_byte_size, target_duration_seconds, current_timestamp, current_timestamp
  );

  return query select 'created'::text, new_id, computed_key;
end
$$;

revoke execute on function app_private.upload_channel_soundboard_clip(uuid, text, text, text, integer, integer, boolean, integer, integer) from public;
grant execute on function app_private.upload_channel_soundboard_clip(uuid, text, text, text, integer, integer, boolean, integer, integer) to bsa_app;

-- The creator's own trigger. Owner/admin only. NO SUPPORTER PATH -- see
-- header. NO COOLDOWN -- see header. Exactly one of
-- target_catalogue_entry_id / target_upload_id must be supplied; the
-- other must be null.
create or replace function app_private.trigger_soundboard_play(
  target_channel_id uuid,
  target_catalogue_entry_id uuid,
  target_upload_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_id uuid;
  current_tier text;
  entry record;
  is_disabled boolean;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to trigger this channel''s soundboard' using errcode = '42501';
  end if;

  if (target_catalogue_entry_id is null) = (target_upload_id is null) then
    raise exception 'exactly one soundboard source must be supplied' using errcode = '22023';
  end if;

  if target_catalogue_entry_id is not null then
    select id, min_tier into entry
      from public.soundboard_catalogue_entries
     where id = target_catalogue_entry_id;
    if not found then
      raise exception 'unknown soundboard catalogue entry' using errcode = 'P0002';
    end if;

    select app_private.current_channel_tier(target_channel_id) into current_tier;
    if app_private.soundboard_tier_rank(entry.min_tier) > app_private.soundboard_tier_rank(current_tier) then
      raise exception 'soundboard clip not available at this channel''s tier' using errcode = '42501';
    end if;

    select exists (
      select 1 from public.channel_soundboard_disables
       where channel_id = target_channel_id and sound_id = target_catalogue_entry_id
    ) into is_disabled;
    if is_disabled then
      raise exception 'soundboard clip is disabled for this channel' using errcode = '42501';
    end if;
  else
    if not exists (
      select 1 from public.channel_soundboard_uploads
       where id = target_upload_id and channel_id = target_channel_id
    ) then
      raise exception 'unknown soundboard upload' using errcode = 'P0002';
    end if;
  end if;

  new_id := gen_random_uuid();
  insert into public.channel_soundboard_plays (id, channel_id, catalogue_entry_id, upload_id, created_at)
  values (new_id, target_channel_id, target_catalogue_entry_id, target_upload_id, current_timestamp);

  return new_id;
end
$$;

revoke execute on function app_private.trigger_soundboard_play(uuid, uuid, uuid) from public;
grant execute on function app_private.trigger_soundboard_play(uuid, uuid, uuid) to bsa_app;

-- =========================================================================
-- THE OVERLAY READ. Seven columns, one row at most, and nothing else.
-- =========================================================================
-- Gated by the SAME overlay_sessions token-fingerprint check every other
-- Master Canvas card in this program uses (0136, 0138, 0139, 0140, 0142),
-- and by soundboard_module_entitled (§30.3 Pro+), exactly as
-- list_overlay_lobby_status calls events_pack_entitled from inside
-- itself rather than the caller reimplementing it.
--
-- NO channel id, NO catalogue/upload id beyond the opaque play_id (an
-- event id for cursoring client-side de-dup, not a participant or viewer
-- identifier -- there is no viewer row anywhere in this schema for it to
-- join to), and NO supporter/viewer field of any kind exists on this
-- path, because none exists in the schema for a future read to start
-- returning.
create or replace function app_private.list_overlay_soundboard_play(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (
  play_id uuid, clip_kind text, display_name text, gcs_object_key text,
  mime_type text, duration_seconds integer, triggered_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select play.id,
         case when play.catalogue_entry_id is not null then 'catalogue' else 'upload' end,
         coalesce(entry.display_name, upload.display_name),
         coalesce(entry.gcs_object_key, upload.gcs_object_key),
         coalesce(entry.mime_type, upload.mime_type),
         coalesce(entry.duration_seconds, upload.duration_seconds),
         play.created_at
    from public.overlay_sessions session
    join public.channel_soundboard_plays play on play.channel_id = session.channel_id
    left join public.soundboard_catalogue_entries entry on entry.id = play.catalogue_entry_id
    left join public.channel_soundboard_uploads upload on upload.id = play.upload_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and app_private.soundboard_module_entitled(session.channel_id)
   order by play.created_at desc
   limit 1
$$;

revoke execute on function app_private.list_overlay_soundboard_play(uuid, text) from public;
grant execute on function app_private.list_overlay_soundboard_play(uuid, text) to bsa_app;
