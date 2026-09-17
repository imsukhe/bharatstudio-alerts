-- PRF-02 slice 7, §6 catalogue module #11: Sponsor Card. The card renders
-- the sponsor and COUNTS NOTHING.
--
-- AUTHORITY. bharatstudio-requirements/reviews/
-- 2026-09-17-remaining-eight-modules-and-youtube-v1-amendment.md, Part 1
-- §3. That decision is the whole authorisation for this migration and is
-- not restated in full here -- only implemented. Task record:
-- bharatstudio-requirements/active/tasks/PRF-02-slice-7-sponsor-card.md.
--
-- MIGRATION NUMBER: 0145, assigned to this task. 0143, 0144 and 0146 are
-- held concurrently by other agents, are never written here, and nothing
-- is renumbered.
--
-- ============================================================
-- THE LOAD-BEARING CONSTRAINT: NOTHING IS COUNTED, TIMED OR
-- ACCUMULATED ABOUT THE CARD BEING DISPLAYED. NOT EVEN "LAST SHOWN AT".
-- ============================================================
-- §6's original row for this module was "scheduled placement with an
-- exposure event log". That phrase is DROPPED, not narrowed. An
-- internal-only, explicitly-not-billable counter was considered and
-- declined: any number this product renders will eventually be
-- screenshotted into a sponsorship negotiation, and at that moment a
-- label saying it is not an auditable metric protects nobody. The two
-- definitions this module was blocked on -- what counts as an exposure,
-- and who may rely on the log -- both stop existing once nothing is
-- counted.
--
-- So there is no impression column, no exposure table, no duration field,
-- no display counter, no "times shown", no "last shown at" and no
-- sponsor-facing report anywhere in this file. Building one later is a
-- NEW decision requiring legal review, not an extension of this one.
-- packages/db/tests/prf02_slice7_sponsor_card.sql case SP11.18 asserts
-- this structurally against every function this migration ships and
-- against every column of the one table it creates, so a future edit that
-- reaches for a counter turns that file red by name rather than passing
-- because a comment said not to.
--
-- "SCHEDULED PLACEMENT" SURVIVES, AND THE LINE IS EXACT. A schedule is an
-- instruction about the FUTURE ("show this sponsor between two instants")
-- and never a record of the PAST ("it was shown"). schedule_starts_at and
-- schedule_ends_at are both nullable, creator-supplied, forward-looking
-- instants -- never stamped by the system, never advanced by a read, and
-- never a log of anything that already happened.
--
-- ============================================================
-- THE LOGO IS AN ASSET, NOT A REMOTE URL, AND NOT A bytea COLUMN.
-- ============================================================
-- §9.1.1 forbids any field on the Master Canvas capable of carrying
-- third-party code, a URL, an iframe, a script or a stylesheet. A sponsor
-- logo is an asset (§19.1: GCS/CDN for bytes, Postgres holds metadata
-- only), never a URL the canvas fetches from a third party -- so there is
-- no url/href/src-shaped column anywhere in this file, and there is no
-- bytea column either (every earlier asset table in this codebase --
-- 0067, 0077, 0106, 0110, 0119, 0122 -- stores bytes as bytea, which this
-- task explicitly forbids reusing here).
--
-- What is stored is METADATA ONLY, in the shape §19.1's own target design
-- names: content sha256, mime type, byte size, and a TENANT-SCOPED
-- content-addressed storage key -- "channel_id + sha256". That key is a
-- GENERATED column here, computed from channel_id and
-- logo_content_sha256, so the two can never independently drift: there is
-- no second place to write a wrong key.
--
-- BLOCKER, REPORTED RATHER THAN WORKED AROUND: no GCS/CDN client, bucket,
-- credential or signed-URL code exists anywhere in this repository
-- (grepped; see the decision record). Standing one up is new
-- infrastructure, out of this slice's ownership boundary -- the identical
-- judgement apps/api/src/domain/asset-scan-pipeline.ts already makes in
-- this codebase for malware scanning. So the logo is OPTIONAL everywhere
-- in this schema (all three logo_* columns nullable, all-or-nothing), and
-- this slice ships no route that accepts logo bytes. The sponsor name,
-- toggle and schedule are fully functional without one.
--
-- ============================================================
-- ONE ROW PER CHANNEL. AN UPSERT, NOT A SESSION LIFECYCLE.
-- ============================================================
-- Unlike the Stream Mission or Giveaway/Tournament cards, a sponsor card
-- has no start/end lifecycle to model -- it is a single, always-present,
-- creator-toggled configuration, the same shape module #12's safe mode
-- and module #10's QR Card (built concurrently) use. `channel_id` is
-- UNIQUE, so there is exactly one sponsor card per channel and writing
-- again always updates that same row.
--
-- ============================================================
-- NO SECOND TIER GATE. `sponsor_card` IS ALREADY ONE OF 0131's TWENTY
-- CATALOGUE KEYS.
-- ============================================================
-- §30.3's placement table names no tier for Sponsor Card specifically --
-- only the generic module-count cap (Free 2 / Pro 5 / Creator 12 / Studio
-- all) applies, and that cap already governs whether the CANVAS renders
-- this card (migration 0131). So nothing below reads a tier and nothing
-- calls an entitlement function -- the identical reasoning 0135 and 0136
-- record for Stream Mission and Moderator Status. §12.6: storing, viewing
-- and changing a durable creator record is never tier-gated.
--
-- TIMEZONE: NOT INVENTED. "Scheduled placement" ships as an ABSOLUTE UTC
-- timestamptz window -- "show this sponsor between these two instants" --
-- never a recurring daily/local-time window ("every day 7-9pm"), because
-- that would need a creator-timezone concept that is not decided anywhere
-- in this repository (grepped for timezone/time_zone/tz_name across every
-- migration; nothing exists).
--
-- ROLLBACK: additive only. Undone by a NEW forward migration dropping the
-- three functions and the table -- never by editing or deleting this
-- file. No production migration without separate explicit approval.

create table public.sponsor_cards (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  created_by_user_id uuid not null references public.app_users(id),

  -- The same 1-120 bound public.challenges.title (0109 line 67) and
  -- public.stream_missions.objective (0135) already use -- reused, not a
  -- new number chosen here.
  sponsor_name text not null check (char_length(sponsor_name) between 1 and 120),

  -- Logo metadata, §19.1: GCS/CDN for bytes, Postgres holds metadata
  -- only. All three nullable, and all-or-nothing (checked below) -- the
  -- logo is optional, and this slice ships no path that populates it (see
  -- the file header's blocker).
  logo_content_sha256 text check (logo_content_sha256 is null or logo_content_sha256 ~ '^[0-9a-f]{64}$'),
  -- No image-mime-type allow-list is decided anywhere in this repository
  -- (grepped) and none is invented here -- the same "no honest reuse
  -- anchor, ship without inventing one" posture 0106/0110/0077 apply to
  -- their own single-mime-type checks, generalised here to "a bounded,
  -- non-empty string" rather than a fabricated enum.
  logo_mime_type text check (logo_mime_type is null or char_length(logo_mime_type) between 1 and 120),
  -- A STORAGE fact (how many bytes), not a product cap. No maximum is
  -- decided or invented; the column's own `integer` range is the only
  -- bound, exactly the posture 0142's GIVEAWAY_COUNT_MAX comment states
  -- for entry_count.
  logo_byte_size integer check (logo_byte_size is null or logo_byte_size > 0),
  -- TENANT-SCOPED CONTENT-ADDRESSED KEY (§19.1: "channel_id + sha256"),
  -- as a GENERATED column so it can never drift from the two values it is
  -- built from and is never independently writable.
  logo_storage_key text generated always as (
    case when logo_content_sha256 is null then null
         else channel_id::text || '/' || logo_content_sha256
    end
  ) stored,
  check (
    (logo_content_sha256 is null) = (logo_mime_type is null)
    and (logo_mime_type is null) = (logo_byte_size is null)
  ),

  -- The single show/hide toggle (owner decision: "one show/hide
  -- toggle"), matching module #10's QR Card shape.
  enabled boolean not null default false,

  -- SCHEDULED PLACEMENT: an instruction about the FUTURE, never a record
  -- of the past. Both null (no schedule -- the card follows `enabled`
  -- alone) or both set (an absolute UTC window); a partial pair is
  -- rejected below. There is no recurring/daily/local-time concept here
  -- -- see the file header on why none is invented.
  schedule_starts_at timestamptz,
  schedule_ends_at timestamptz,
  check ((schedule_starts_at is null) = (schedule_ends_at is null)),
  check (schedule_ends_at is null or schedule_ends_at > schedule_starts_at),

  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,

  unique (channel_id)
);

alter table public.sponsor_cards enable row level security;
revoke all on public.sponsor_cards from public;
revoke all on public.sponsor_cards from bsa_app;

-- Owner/admin only, the same role set and the same has_channel_role check
-- 0109's create_challenge, 0131's upsert_master_canvas_module and 0135's
-- start_stream_mission already use. Reads no tier and calls no
-- entitlement function (see file header).
--
-- AN UPSERT, NOT A SESSION LIFECYCLE: `channel_id` is UNIQUE, so this
-- always writes the one row for the channel -- insert on first call,
-- update on every call after. There is no separate "end"/"close"
-- function because there is no lifecycle to end; disabling the card is
-- just `target_enabled := false`.
create or replace function app_private.upsert_sponsor_card(
  target_channel_id uuid,
  target_sponsor_name text,
  target_logo_content_sha256 text,
  target_logo_mime_type text,
  target_logo_byte_size integer,
  target_enabled boolean,
  target_schedule_starts_at timestamptz,
  target_schedule_ends_at timestamptz
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing_id uuid;
  written_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s sponsor card' using errcode = '42501';
  end if;

  if target_sponsor_name is null or char_length(target_sponsor_name) not between 1 and 120 then
    raise exception 'invalid sponsor name' using errcode = '22023';
  end if;

  if (target_logo_content_sha256 is null) <> (target_logo_mime_type is null)
     or (target_logo_mime_type is null) <> (target_logo_byte_size is null) then
    raise exception 'logo metadata must be set all together or not at all' using errcode = '22023';
  end if;

  if target_logo_content_sha256 is not null and target_logo_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid logo content hash' using errcode = '22023';
  end if;

  if target_logo_mime_type is not null and char_length(target_logo_mime_type) not between 1 and 120 then
    raise exception 'invalid logo mime type' using errcode = '22023';
  end if;

  if target_logo_byte_size is not null and target_logo_byte_size <= 0 then
    raise exception 'invalid logo byte size' using errcode = '22023';
  end if;

  if (target_schedule_starts_at is null) <> (target_schedule_ends_at is null) then
    raise exception 'a schedule window needs both a start and an end, or neither' using errcode = '22023';
  end if;

  if target_schedule_starts_at is not null and target_schedule_ends_at <= target_schedule_starts_at then
    raise exception 'the schedule window must end after it starts' using errcode = '22023';
  end if;

  select id into existing_id from public.sponsor_cards where channel_id = target_channel_id;

  if existing_id is null then
    written_id := gen_random_uuid();
    insert into public.sponsor_cards (
      id, channel_id, created_by_user_id, sponsor_name,
      logo_content_sha256, logo_mime_type, logo_byte_size,
      enabled, schedule_starts_at, schedule_ends_at, created_at, updated_at
    )
    values (
      written_id, target_channel_id, app_private.current_user_id(), target_sponsor_name,
      target_logo_content_sha256, target_logo_mime_type, target_logo_byte_size,
      target_enabled, target_schedule_starts_at, target_schedule_ends_at, current_timestamp, current_timestamp
    );
  else
    written_id := existing_id;
    update public.sponsor_cards
       set sponsor_name = target_sponsor_name,
           logo_content_sha256 = target_logo_content_sha256,
           logo_mime_type = target_logo_mime_type,
           logo_byte_size = target_logo_byte_size,
           enabled = target_enabled,
           schedule_starts_at = target_schedule_starts_at,
           schedule_ends_at = target_schedule_ends_at,
           updated_at = current_timestamp
     where id = existing_id;
  end if;

  return written_id;
end
$$;

revoke execute on function app_private.upsert_sponsor_card(uuid, text, text, text, integer, boolean, timestamptz, timestamptz) from public;
grant execute on function app_private.upsert_sponsor_card(uuid, text, text, text, integer, boolean, timestamptz, timestamptz) to bsa_app;

-- Creator/dashboard-facing read of the channel's one sponsor card. Any
-- current channel member (owner through viewer -- the same role set
-- list_channel_stream_mission and list_channel_master_canvas_modules
-- already use) sees it; a non-member sees zero rows. Reads no tier
-- (§12.6).
create or replace function app_private.list_channel_sponsor_card(target_channel_id uuid)
returns table (
  sponsor_card_id uuid, sponsor_name text,
  logo_content_sha256 text, logo_mime_type text, logo_byte_size integer, logo_storage_key text,
  enabled boolean, schedule_starts_at timestamptz, schedule_ends_at timestamptz,
  created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select card.id, card.sponsor_name,
         card.logo_content_sha256, card.logo_mime_type, card.logo_byte_size, card.logo_storage_key,
         card.enabled, card.schedule_starts_at, card.schedule_ends_at,
         card.created_at, card.updated_at
    from public.sponsor_cards card
   where card.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
$$;

revoke execute on function app_private.list_channel_sponsor_card(uuid) from public;
grant execute on function app_private.list_channel_sponsor_card(uuid) to bsa_app;

-- Overlay/browser-source-facing read. Same token-fingerprint gate as
-- list_overlay_stream_mission (0135), list_overlay_lobby_status (0140)
-- and list_overlay_giveaway_tournament (0142) -- one shared
-- overlay_sessions model, no second auth path.
--
-- THE PROJECTION IS DELIBERATELY THREE COLUMNS, AND CARRIES NOTHING
-- ABOUT DISPLAY. sponsor_name and the two logo identifiers are what the
-- card paints; there is no schedule field, no enabled flag, no id, no
-- timestamp and -- the whole point of this module -- no count, no
-- duration and no "last shown" of any kind. A row is returned ONLY when
-- the card is currently supposed to be visible: enabled = true AND
-- (no schedule OR now is inside it). Every other case -- disabled,
-- outside the window, wrong/expired/revoked/foreign token, no card at
-- all -- returns ZERO ROWS, which is the only signal the renderer needs:
-- paint nothing.
--
-- packages/db/tests/prf02_slice7_sponsor_card.sql asserts this exact OUT
-- column list against information_schema.parameters and against a live
-- call, so a future widening is a failing test rather than a silent
-- change.
create or replace function app_private.list_overlay_sponsor_card(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (sponsor_name text, logo_mime_type text, logo_storage_key text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select card.sponsor_name, card.logo_mime_type, card.logo_storage_key
    from public.overlay_sessions session
    join public.sponsor_cards card on card.channel_id = session.channel_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and card.enabled = true
     and (
       (card.schedule_starts_at is null and card.schedule_ends_at is null)
       or (current_timestamp between card.schedule_starts_at and card.schedule_ends_at)
     )
$$;

revoke execute on function app_private.list_overlay_sponsor_card(uuid, text) from public;
grant execute on function app_private.list_overlay_sponsor_card(uuid, text) to bsa_app;
