-- PRF-02 slice 7, §6 catalogue module #10: QR Smart Card.
--
-- AUTHORITY. bharatstudio-requirements/reviews/
-- 2026-09-17-remaining-eight-modules-and-youtube-v1-amendment.md Part 1
-- §2 (owner Sukhdev Singh, 2026-09-17). Verbatim scope, not relitigated
-- here: "The creator sets one destination and one label. The card shows
-- or hides on a single toggle. That is the entire feature." That review
-- closes the slice-5 scope review's `BLOCKED-DECISION` classification of
-- module #10 -- it had been blocked on `CMP-17` (Clutch Mode) and a
-- scene-profile system, and the owner's answer is that neither is
-- needed for a card with exactly one state and one destination.
--
-- NO SCENE CONCEPT, ANYWHERE IN THIS FILE, ON PURPOSE. The review is
-- explicit: "Forward compatible on purpose: a single-destination card
-- later gains scene awareness by being SELECTED BY a scene profile, so
-- the module must hold no scene concept at all -- nothing a future
-- CMP-17 could conflict with." There is therefore no `scene_id`, no
-- `visibility_rule`, no `safe_zone` column and no scene-shaped table
-- anywhere below -- not stubbed, not nullable-and-unused, absent.
-- packages/db/tests/prf02_slice7_qr_smart_card.sql case QR.STRUCT
-- asserts that against information_schema directly.
--
-- WHAT THIS DOES NOT AUTHORISE, STATED AS PLAINLY AS THE REVIEW STATES
-- IT: "No destination allow-list, no link shortening, no scan counting,
-- and no claim about how many people scanned anything." Concretely,
-- absent from this migration and never to be added by a later one
-- without a new decision: any allow-list/denylist table or check on the
-- destination value beyond a length bound; any short-link/redirect
-- table or column; and -- the one enforced structurally below, not just
-- by omission -- any scan, view, impression or exposure counter of any
-- kind, on this table or anywhere this migration touches. There is
-- exactly one numeric-shaped thing in `qr_smart_cards`, and it is a
-- primary key's implicit row count, never a count column.
--
-- §9.1.1 TENSION, MADE STRUCTURALLY TRUE. The creator's destination IS a
-- URL -- that is the whole point of the card -- and §9.1.1 forbids any
-- third-party code, URL, iframe, script or stylesheet from reaching the
-- Master Canvas. The resolution is that `destination` is DATA the client
-- renders as a QR code image (a first-party encoder,
-- apps/web/app/overlay/canvas/modules/qr-smart-card-logic.ts, ships with
-- this slice -- no third-party QR library and no remote QR-image
-- service), never a URL the canvas fetches, navigates to or embeds. That
-- is a client-side rendering property this migration cannot enforce
-- directly, but it can and does keep the column an inert `text` value
-- with no format that implies fetchability (no `href`, `src` or
-- `iframe`-shaped column anywhere in this schema), and
-- master-canvas-runtime.test.ts's existing §9.1.1 structural assertion
-- (a CanvasModuleDefinition has no field capable of carrying a
-- third-party URL/HTML/script/iframe) already covers this module
-- generically, since it holds unchanged for every module; this slice
-- adds a module-specific proof on top of it --
-- apps/web/app/overlay/canvas/modules/qr-smart-card-module.test.ts
-- asserts directly against the RENDERED DOM that no `<a>`, `<iframe>` or
-- `<script>` element exists and that `destination` never appears as an
-- `href`/`src` attribute anywhere in the module's output.
--
-- REUSE, NOT A NEW NUMBER. Both creator-authored text fields --
-- `destination` and `label` -- are bounded 1 to 120 characters, REUSING
-- the already-decided challenge-title bound: 0109_v1_l17_paid_challenges
-- .sql line 67, `check (char_length(title) between 1 and 120)`, already
-- reused verbatim by 0135_v1_prf02_slice5_stream_mission.sql line 79 for
-- `objective`. The same numbers appear below because it is the same
-- decision, reused a third time -- not a fresh bound chosen for a URL.
-- No other numeric limit, price, provider behaviour, legal wording,
-- retention window or security control is invented anywhere in this
-- file; §12.6's uniform retention policy applies as it does to every
-- other durable creator record and is not restated here.
--
-- THE STATE IS ONE ROW PER CHANNEL, NOT AN EVENT LOG. Unlike
-- stream_missions (0135, a record with a start/end lifecycle) or
-- giveaways/tournaments (0142, a record with entry/bracket state), a QR
-- Smart Card has exactly one current destination, one current label and
-- one current toggle -- there is nothing to supersede and nothing to
-- keep history of. So `channel_id` is the primary key (at most one card
-- per channel, enforced by the database rather than by convention) and
-- writes are upserts, not inserts-plus-supersede. Setting a new
-- destination/label never clears `is_enabled`, and toggling visibility
-- never touches `destination`/`label` -- two independent writes for two
-- independent decisions, exactly as the review's "one destination, one
-- label... shows or hides on a single toggle" describes three separate
-- creator inputs, not one combined form.
--
-- TOGGLING BEFORE A CARD EXISTS IS A NOT-FOUND, NOT AN IMPLICIT CREATE.
-- `set_qr_smart_card_enabled` never inserts a row -- a channel that has
-- never set a destination/label has nothing to toggle, and inventing an
-- empty enabled card would let a viewer-facing overlay ask "enabled, to
-- show what?".
--
-- ALL TIERS, LIKE EVERY OTHER BUILT CANVAS MODULE. 'qr_smart_card' is
-- already one of 0131's twenty catalogue module keys (line 43), so this
-- migration does not touch 0131 and adds no second tier gate. §12.6:
-- storing, viewing and exporting a durable creator record is never
-- tier-gated; only whether the Canvas RENDERS the card is capped, and
-- that cap already exists.
--
-- ROLLBACK: additive only. Undone by a NEW forward migration dropping
-- the four functions and the table -- never by editing or deleting this
-- file. That rollback deletes card rows; it is an operator-initiated
-- rollback of the whole capability, not a downgrade, and §12.6's "never
-- destroys configuration" binds the downgrade path exactly as 0131's own
-- rollback note records. No production migration without separate
-- explicit approval.

create table public.qr_smart_cards (
  channel_id uuid primary key references public.channels(id),
  created_by_user_id uuid not null references public.app_users(id),
  -- Reuse anchor: 0109_v1_l17_paid_challenges.sql line 67
  -- (`check (char_length(title) between 1 and 120)`), already reused by
  -- 0135 line 79. The destination is data rendered as a QR code, never a
  -- link the canvas fetches -- see the file header's §9.1.1 note.
  destination text not null check (char_length(destination) between 1 and 120),
  label text not null check (char_length(label) between 1 and 120),
  -- The single toggle the review names. Defaults to false: creating a
  -- card (setting a destination/label for the first time) does not, by
  -- itself, put it on the broadcast -- a second, explicit act does.
  is_enabled boolean not null default false,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

alter table public.qr_smart_cards enable row level security;
revoke all on public.qr_smart_cards from public;
revoke all on public.qr_smart_cards from bsa_app;

-- Owner/admin only, the same role set and the same has_channel_role
-- check 0109's create_challenge, 0131's upsert_master_canvas_module and
-- 0135's start_stream_mission already use. Creates the card on first
-- call, updates destination/label on every later call -- `is_enabled` is
-- untouched either way, per the file header's "two independent writes"
-- note.
create or replace function app_private.upsert_qr_smart_card(
  target_channel_id uuid,
  target_destination text,
  target_label text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s QR smart card' using errcode = '42501';
  end if;

  if target_destination is null or char_length(target_destination) not between 1 and 120 then
    raise exception 'invalid QR smart card destination' using errcode = '22023';
  end if;
  if target_label is null or char_length(target_label) not between 1 and 120 then
    raise exception 'invalid QR smart card label' using errcode = '22023';
  end if;

  insert into public.qr_smart_cards (channel_id, created_by_user_id, destination, label, is_enabled, created_at, updated_at)
  values (target_channel_id, app_private.current_user_id(), target_destination, target_label, false, current_timestamp, current_timestamp)
  on conflict (channel_id) do update
    set destination = excluded.destination,
        label = excluded.label,
        updated_at = current_timestamp;
end
$$;

revoke execute on function app_private.upsert_qr_smart_card(uuid, text, text) from public;
grant execute on function app_private.upsert_qr_smart_card(uuid, text, text) to bsa_app;

-- Owner/admin only. Never creates a row -- see the file header's
-- "toggling before a card exists is a not-found" note. The same
-- not-found-and-not-authorized-are-the-same-answer shape
-- end_stream_mission (0135) already uses.
create or replace function app_private.set_qr_smart_card_enabled(
  target_channel_id uuid,
  target_enabled boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  affected integer;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'QR smart card not found' using errcode = 'P0002';
  end if;

  if target_enabled is null then
    raise exception 'invalid QR smart card toggle value' using errcode = '22023';
  end if;

  update public.qr_smart_cards
     set is_enabled = target_enabled,
         updated_at = current_timestamp
   where channel_id = target_channel_id;

  get diagnostics affected = row_count;
  if affected = 0 then
    raise exception 'QR smart card not found' using errcode = 'P0002';
  end if;
end
$$;

revoke execute on function app_private.set_qr_smart_card_enabled(uuid, boolean) from public;
grant execute on function app_private.set_qr_smart_card_enabled(uuid, boolean) to bsa_app;

-- Creator/dashboard-facing read. Any current channel member (owner
-- through viewer -- the same role set list_channel_stream_mission and
-- list_channel_master_canvas_modules already use) sees it; a non-member
-- sees zero rows. Reads no tier: §12.6 forbids tier-gating the read of a
-- durable creator record, and nothing here does. At most one row, by
-- construction of the primary key.
create or replace function app_private.list_channel_qr_smart_card(target_channel_id uuid)
returns table (
  destination text, label text, is_enabled boolean,
  created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select card.destination, card.label, card.is_enabled, card.created_at, card.updated_at
    from public.qr_smart_cards card
   where card.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
$$;

revoke execute on function app_private.list_channel_qr_smart_card(uuid) from public;
grant execute on function app_private.list_channel_qr_smart_card(uuid) to bsa_app;

-- Overlay/browser-source-facing read. Same token-fingerprint gate as
-- list_overlay_stream_mission (0135), list_overlay_moderator_status
-- (0138) and list_overlay_lobby_status (0140) -- one shared
-- overlay_sessions model, no second auth path.
--
-- THE PROJECTION IS DELIBERATELY TWO COLUMNS: destination, label. No
-- channel_id, no card id, no timestamps and -- pointedly -- no
-- `is_enabled`: the `where card.is_enabled` predicate below means a row
-- is returned ONLY when the card is on, so the column's own presence
-- IS the toggle's true state; returning it again would carry no
-- information while adding a field this projection does not need. A
-- disabled card and a channel that has never configured one return the
-- identical nothing -- zero rows -- because neither has anything for
-- the overlay to paint. packages/db/tests/prf02_slice7_qr_smart_card.sql
-- asserts this exact OUT column list against
-- information_schema.parameters, so a future widening (a scan count,
-- a card id, an enabled flag) is a failing test, not a silent change.
create or replace function app_private.list_overlay_qr_smart_card(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (destination text, label text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select card.destination, card.label
    from public.overlay_sessions session
    join public.qr_smart_cards card on card.channel_id = session.channel_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and card.is_enabled
$$;

revoke execute on function app_private.list_overlay_qr_smart_card(uuid, text) from public;
grant execute on function app_private.list_overlay_qr_smart_card(uuid, text) to bsa_app;
