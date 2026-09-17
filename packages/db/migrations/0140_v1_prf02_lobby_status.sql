-- PRF-02 slice 6, §6 catalogue module #16 (Lobby Status), and the MINIMUM
-- §16 Lobby schema needed to render it.
--
-- Authority: FULL-PRODUCT-DEFINITION.md §6 module #16, §9.1.1, §12.6,
-- §12.7, §16 (in full), §30.3, §33, §34, and the owner decisions of
-- 2026-09-16 recorded in bharatstudio-requirements/reviews/
-- 2026-09-16-prf-02-slice-6-owner-decisions.md (decisions 4 and 5).
--
-- Task record: bharatstudio-requirements/active/tasks/
-- PRF-02-slice-6-lobby-status.md.
--
-- MIGRATION NUMBER: 0140, assigned to this task. Nothing is renumbered and
-- no other number is written here.
--
-- ============================================================
-- WHAT §34 SAYS, AND WHY THIS FILE EXISTS ANYWAY.
-- ============================================================
-- §34 places the Lobby Engine in Phase 3. The owner's decision 4 overrides
-- that placement FOR MODULE #16 ONLY, to build the minimum schema the card
-- needs -- the same override already taken for module #9's mission record
-- (migration 0135). It authorises nothing else from Phase 3, and this file
-- takes nothing else.
--
-- ============================================================
-- THE MINIMUM IS THREE INTEGERS, AND THERE IS NO VIEWER ROW.
-- ============================================================
-- §16 L3002-3003: the public overlay shows "aggregate status ONLY: '8/16
-- seats confirmed', queue count, next round, and opted-in initials or
-- avatars. Never player identifiers, never Discord names, never codes or
-- passwords."
--
-- Rendering that needs exactly three numbers and a lifecycle to scope them
-- to, so this migration creates ONE table carrying seat_count,
-- confirmed_seat_count and queue_count, and NO waitlist table, NO
-- participant table and NO per-viewer row of any kind.
--
-- THAT IS THE STRONGER PRIVACY POSITION, NOT THE WEAKER ONE. Owner
-- decision 4 forbids "a per-viewer row on the overlay path, and nothing
-- that correlates one visit to another". Because no viewer column exists
-- ANYWHERE in this migration, that holds by construction rather than by
-- projection discipline: there is nothing for a future read to start
-- returning, and nothing two visits could be joined on.
--
-- THE COST, STATED RATHER THAN GLOSSED: the numbers are as accurate as
-- whoever reports them, and in this slice that is the creator (or their
-- tooling) through app_private.update_lobby_session_counts. The mechanism
-- that would DERIVE them -- the public waitlist, the ready check and the
-- reserve bench -- is the Lobby Engine, is Phase 3, and is not built here.
-- Inventing a derivation would be inventing the subsystem.
--
-- ============================================================
-- WHAT IS DELIBERATELY NOT BUILT, NAMED ONE BY ONE.
-- ============================================================
-- The rule applied throughout: IF THE CARD CAN RENDER WITHOUT IT, IT IS OUT
-- OF SCOPE. §16.1's flow has eight steps; this file serves the three
-- numbers and nothing else.
--
--   * NO READY CHECK (§16.1 step 4). The card reads confirmed_seat_count;
--     HOW a seat became confirmed never reaches the overlay. §16.4 calls
--     the ready check the highest-value feature of the Lobby Engine, which
--     is exactly why it is not a side effect of a card slice.
--   * NO SEAT TOKENS (step 5). Single-use short-lived private tokens are
--     the Lobby Engine's delivery mechanism. There is no column for one
--     here, and building the storage "for later" would create the very
--     thing §16's prohibition exists to prevent.
--   * NO ROOM CODE AND NO PASSWORD (step 6). §16 forbids both on the
--     overlay in the same sentence. Neither exists in this schema at all.
--   * NO NO-SHOW EXPIRY OR RESERVE PROMOTION (step 7). Those change how a
--     number gets its value, never whether the card can paint it.
--   * NO SELECTION POLICY AND NO REDACTED AUDIT LOG (§16.2). Join time,
--     selection method, promotion, no-show expiry, moderator override and
--     reason are a fairness subsystem with records of their own.
--   * NO FEEDBACK, NO REPORT OPTIONS, NO AUTOMATIC DELETION OF TEMPORARY
--     LOBBY DATA (step 8). There IS no temporary lobby data here -- no
--     tokens, no codes, no per-viewer rows -- so a deletion job would be a
--     retention policy for an empty set, and retention policy is not this
--     slice's to decide.
--   * NO GAME, REGION, MODE, PLATFORM, TIME OR RESERVE-SEAT DESCRIPTORS
--     (step 1). The card paints none of them.
--   * NO OPTED-IN INITIALS OR AVATARS. §16 permits them; owner decision 5
--     puts them out of scope because they need an opt-in mechanism that
--     does not exist in this schema. None is built here and none is
--     approximated.
--
-- ============================================================
-- NOT ONE NUMBER IN THIS FILE WAS CHOSEN BY ITS AUTHOR.
-- ============================================================
--   * seat_count >= 1 -- arithmetic, not policy: a lobby with no seats
--     cannot render a seat status. There is deliberately NO UPPER BOUND;
--     §16 states no maximum seat count and this file will not invent one.
--   * confirmed_seat_count >= 0 and queue_count >= 0 -- a count cannot be
--     negative.
--   * confirmed_seat_count <= seat_count -- the arithmetic of "8/16". A
--     lobby cannot confirm more seats than it has.
--   * closed_at >= opened_at -- the same shape 0135 already uses for
--     ended_at >= started_at.
--   * one OPEN lobby per channel -- §12.7's bounded read as a database
--     guarantee, the identical partial unique index 0135's
--     stream_missions_channel_running_idx already uses, for the identical
--     reason.
--
-- THERE IS NO DURATION, TIMER, EXPIRY, DEADLINE, COUNTDOWN OR SCHEDULED-END
-- COLUMN OF ANY KIND, and there must never be one added quietly. §16.1's
-- "time" belongs to step 1's session setup, which is out of scope, and
-- choosing a lobby duration would be inventing a number. closed_at is a
-- RECORD of when the creator closed the lobby, never a schedule -- exactly
-- the distinction 0135 drew for ended_at.
--
-- ============================================================
-- THE ENTITLEMENT, AND THE ONE REASON NOTHING CAN GRANT THE PACK.
-- ============================================================
-- Owner decision 5: the entitlement for §16/§17 is
--   tier in ('creator','studio')  OR  an active Events Pack grant,
-- with the pack side built as a check that has NO GRANT PATH YET, so
-- present behaviour is exactly "included at Creator+" -- the established
-- configured-but-unset discipline applied to an entitlement instead of a
-- number.
--
-- app_private.events_pack_entitled below is that check. Its pack branch
-- reads `values -> 'eventsPack' ->> 'active'` out of the channel's latest
-- public.channel_entitlement_versions row -- the entitlement store that
-- already exists. NO grants table is created, because a grants table would
-- ITSELF be a grant path: it would need a shape, a lifecycle and an expiry,
-- all of which are undecided, and any of them would be a product surface
-- nobody asked for.
--
-- WHY NOTHING CAN CURRENTLY MAKE THAT BRANCH TRUE, STATED AS ONE FACT:
-- channel_entitlement_versions.values is NEVER caller-supplied. Every
-- writer in this schema builds it server-side -- the publishers (0048
-- L114, 0070 L144/L212/L259, 0080 L152/L215/L258) write
-- app_private.tier_entitlement_dimensions(tier) verbatim, and the admin
-- override (0074 L150) writes that value merged with exactly two literal
-- keys, queueCount and adminOverrideReason. tier_entitlement_dimensions
-- emits no eventsPack key for any tier. So no publisher, no admin and no
-- API caller can produce one. packages/db/tests/prf02_slice6_lobby_status.
-- sql asserts that against every app_private function definition and
-- against tier_entitlement_dimensions' own output for all four tiers --
-- not against this comment.
--
-- NO PRICE, NO BILLING, NO PURCHASE PATH. §33's Rs 129/mo figure stays in
-- the authority. There is no amount, currency, paise, plan, subscription or
-- billing token anywhere in this file, and the SQL test asserts that too.
-- Purchasing, when it is built, is website-only per the standing
-- constraint -- and it is not built here.
--
-- ============================================================
-- THE TIER GATE IS ON THE MODULE, NEVER ON THE CREATOR'S RECORD.
-- ============================================================
-- §12.6: storing, viewing, searching, fetching and exporting a durable
-- creator record is never tier-gated. So open_lobby_session,
-- update_lobby_session_counts, close_lobby_session and
-- list_channel_lobby_session read NO tier and call NO entitlement function.
-- Their only gate is the role gate, and it lives in SQL:
-- app_private.has_channel_role -- the same gate 0135's mission functions
-- and 0079's payout-onboarding setting already use.
--
-- app_private.events_pack_entitled is called from exactly ONE place: the
-- OVERLAY read. A Pro creator can open a lobby, report seats, close it and
-- read it back at any time; what they do not get is the Canvas module
-- painting it on a broadcast. That is §30.3's own row implemented
-- literally.
--
-- 0131's §30.3 MODULE CAP is untouched: 'lobby_status' was already one of
-- its twenty catalogue keys, so that check constraint is not altered here.
-- The cap and this entitlement are two independent gates and both stand.
--
-- ============================================================
-- "AGGREGATE STATUS ONLY" IS A PROPERTY OF THE QUERY (§6 #16, §16).
-- ============================================================
-- app_private.list_overlay_lobby_status returns exactly
--   (seat_count integer, confirmed_seat_count integer, queue_count integer)
-- and nothing else, ever. No room code, no password, no seat token, no
-- player identifier, no in-game name, no Discord name, no viewer id, no
-- anonymous identity, no session id -- and not merely withheld: none of
-- those things EXISTS in this schema for a future read to start returning.
--
-- The lobby id is not returned either. It would carry no information the
-- card paints, and "a session id" is on the prohibited list. Three numbers
-- is the whole projection, and the SQL test asserts that column set twice
-- -- from pg_get_function_result AND from a table materialised out of a
-- live call -- exactly as 0136 (moderator status) and 0139 (reaction cloud)
-- do for theirs.
--
-- §12.7 IS SATISFIED BY CONSTRUCTION: the read returns CURRENT aggregate
-- state, at most one row by construction (the partial unique index), never
-- a history. §9.1.1 is untouched -- nothing in this file can put a URL,
-- script or iframe anywhere near the Canvas.
--
-- AN INVALID SESSION RETURNS ZERO ROWS, and so does an unentitled channel
-- and a channel with no open lobby. The module renders the same nothing for
-- all three, which is correct: none of them has anything to tell a viewer,
-- and distinguishing them on a broadcast overlay would mean inventing copy
-- for a state not worth a pixel.
--
-- ROLLBACK: additive only.
--   drop function app_private.list_overlay_lobby_status(uuid, text);
--   drop function app_private.list_channel_lobby_session(uuid);
--   drop function app_private.close_lobby_session(uuid, uuid);
--   drop function app_private.update_lobby_session_counts(uuid, uuid, integer, integer);
--   drop function app_private.open_lobby_session(uuid, integer);
--   drop function app_private.events_pack_entitled(uuid);
--   drop table public.lobby_sessions;
-- No existing table, column, constraint, trigger, function, index or row is
-- created, altered or deleted by this migration, so dropping the seven
-- objects above leaves the entitlement ladder, the module catalogue, the
-- dispatcher and every other overlay read byte-for-byte unaffected. That
-- drop DOES delete lobby rows (there is no other way to undo a create
-- table); it is an operator-initiated rollback of the whole capability, not
-- a downgrade, exactly as 0131's and 0135's own rollback notes record. No
-- production migration without separate explicit approval.

-- =========================================================================
-- lobby_sessions: one row per lobby a creator opened. Three counts, a
-- lifecycle, and NOTHING ELSE. No room code, no password, no seat token, no
-- viewer column of any kind -- see the header.
-- =========================================================================
create table public.lobby_sessions (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  created_by_user_id uuid not null references public.app_users(id),
  -- Arithmetic, not policy. No upper bound: §16 names no maximum.
  seat_count integer not null check (seat_count >= 1),
  confirmed_seat_count integer not null default 0 check (confirmed_seat_count >= 0),
  queue_count integer not null default 0 check (queue_count >= 0),
  opened_at timestamptz not null default current_timestamp,
  -- A RECORD of when the creator closed the lobby, never a schedule. Null
  -- means open. There is no other temporal column on this table and there
  -- must never be one.
  closed_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  -- The arithmetic of "8/16 seats confirmed": a lobby cannot confirm more
  -- seats than it has. Enforced by the DATABASE so it stays true whatever
  -- writes the counts.
  constraint lobby_sessions_confirmed_within_seats
    check (confirmed_seat_count <= seat_count),
  constraint lobby_sessions_closed_after_opened
    check (closed_at is null or closed_at >= opened_at)
);

-- §12.7's "at most the current lobby" as a database guarantee rather than
-- an application convention -- the same shape 0135's
-- stream_missions_channel_running_idx already uses.
create unique index lobby_sessions_channel_open_idx
  on public.lobby_sessions (channel_id)
  where closed_at is null;

-- Closed lobbies stay durable and readable (§12.6); this index serves the
-- channel-scoped lookups without making the history itself a live surface.
create index lobby_sessions_channel_opened_idx
  on public.lobby_sessions (channel_id, opened_at desc);

alter table public.lobby_sessions enable row level security;
revoke all on public.lobby_sessions from public;
revoke all on public.lobby_sessions from bsa_app;

-- =========================================================================
-- events_pack_entitled: owner decision 5's entitlement, in one place.
--
--   tier in ('creator','studio')  OR  an active Events Pack grant.
--
-- The pack branch exists and is reachable; NOTHING CAN MAKE IT TRUE. See
-- the header for the single reason: channel_entitlement_versions.values is
-- never caller-supplied, every writer builds it server-side from
-- tier_entitlement_dimensions (plus, for 0074's admin override, exactly
-- queueCount and adminOverrideReason), and tier_entitlement_dimensions
-- emits no eventsPack key for any tier.
--
-- The grant is read with ->> and compared to the literal 'true' rather than
-- cast to boolean: a cast would raise on any other stored text, turning a
-- malformed value into an error on a live overlay read instead of an
-- absent grant. Absent, malformed and false all mean the same thing here --
-- today's behaviour, which is "included at Creator+".
--
-- current_channel_tier (0086) is reused unchanged: it already reads the
-- latest entitlement version and already defaults a channel with no version
-- at all to 'free', so a missing row can never be read as a higher tier.
-- =========================================================================
create or replace function app_private.events_pack_entitled(target_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select app_private.current_channel_tier(target_channel_id) in ('creator', 'studio')
      or coalesce(
           (select (entitlement.values -> 'eventsPack' ->> 'active') = 'true'
              from public.channel_entitlement_versions entitlement
             where entitlement.channel_id = target_channel_id
             order by entitlement.version desc
             limit 1),
           false
         )
$$;

revoke execute on function app_private.events_pack_entitled(uuid) from public;
grant execute on function app_private.events_pack_entitled(uuid) to bsa_app;

-- =========================================================================
-- open_lobby_session: owner/admin only, the same role set and the same
-- has_channel_role check 0135's start_stream_mission and 0131's
-- upsert_master_canvas_module already use.
--
-- READS NO TIER AND CALLS NO ENTITLEMENT FUNCTION (§12.6). Opening a lobby
-- writes a durable creator record, and a creator's own record is never
-- tier-gated. The tier gate is on the OVERLAY read, which is the module.
-- =========================================================================
create or replace function app_private.open_lobby_session(
  target_channel_id uuid,
  target_seat_count integer
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  open_id uuid;
  new_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s lobby' using errcode = '42501';
  end if;

  if target_seat_count is null or target_seat_count < 1 then
    raise exception 'invalid lobby seat count' using errcode = '22023';
  end if;

  -- Raised explicitly, before the insert, so the caller gets a readable
  -- message rather than a raw constraint violation. The partial unique
  -- index above is still the hard guarantee -- this is the courteous path,
  -- not the enforcing one. A second lobby is a CONFLICT the creator
  -- resolves, never a silent supersede of the one already running.
  select id into open_id
    from public.lobby_sessions
   where channel_id = target_channel_id
     and closed_at is null;

  if open_id is not null then
    raise exception 'a lobby session is already open for this channel' using errcode = '23505';
  end if;

  new_id := gen_random_uuid();
  insert into public.lobby_sessions (
    id, channel_id, created_by_user_id, seat_count, confirmed_seat_count, queue_count,
    opened_at, closed_at, created_at, updated_at
  ) values (
    new_id, target_channel_id, app_private.current_user_id(), target_seat_count, 0, 0,
    current_timestamp, null, current_timestamp, current_timestamp
  );

  return new_id;
end
$$;

revoke execute on function app_private.open_lobby_session(uuid, integer) from public;
grant execute on function app_private.open_lobby_session(uuid, integer) to bsa_app;

-- =========================================================================
-- update_lobby_session_counts: the creator reports how many seats are
-- confirmed and how long the queue is. Owner/admin only, and ADDRESSED
-- rather than ambient -- it takes the lobby id as well as the channel id,
-- so a stale dashboard tab cannot write counts onto a lobby opened after
-- that tab loaded. The read that precedes it already returns the id, so
-- this costs the caller nothing.
--
-- BOTH COUNTS ARE WRITTEN TOGETHER, not one at a time, because they are
-- read together on one card: a partial write would paint a seat figure
-- from one moment beside a queue figure from another.
--
-- NOT-FOUND AND NOT-AUTHORIZED ARE THE SAME ANSWER (P0002), deliberately --
-- the same non-leaking mapping 0135 uses and routes/master-canvas.ts
-- already applies when it turns a forbidden outcome into a 404.
-- =========================================================================
create or replace function app_private.update_lobby_session_counts(
  target_channel_id uuid,
  target_lobby_id uuid,
  target_confirmed_seat_count integer,
  target_queue_count integer
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
    raise exception 'lobby session not found' using errcode = 'P0002';
  end if;

  if target_confirmed_seat_count is null or target_confirmed_seat_count < 0
     or target_queue_count is null or target_queue_count < 0 then
    raise exception 'invalid lobby counts' using errcode = '22023';
  end if;

  -- Checked here so the caller gets a readable 22023 rather than a raw
  -- check-constraint violation; lobby_sessions_confirmed_within_seats
  -- remains the hard guarantee.
  if exists (
    select 1 from public.lobby_sessions
     where id = target_lobby_id
       and channel_id = target_channel_id
       and closed_at is null
       and target_confirmed_seat_count > seat_count
  ) then
    raise exception 'a lobby cannot confirm more seats than it has' using errcode = '22023';
  end if;

  update public.lobby_sessions
     set confirmed_seat_count = target_confirmed_seat_count,
         queue_count = target_queue_count,
         updated_at = current_timestamp
   where id = target_lobby_id
     and channel_id = target_channel_id
     and closed_at is null;

  get diagnostics affected = row_count;
  if affected = 0 then
    raise exception 'lobby session not found' using errcode = 'P0002';
  end if;
end
$$;

revoke execute on function app_private.update_lobby_session_counts(uuid, uuid, integer, integer) from public;
grant execute on function app_private.update_lobby_session_counts(uuid, uuid, integer, integer) to bsa_app;

-- =========================================================================
-- close_lobby_session: owner/admin only, addressed by lobby id, and the
-- same one-indistinguishable-P0002 answer for an unknown, already-closed,
-- other-channel or unauthorised lobby.
--
-- CLOSING DELETES NOTHING. The row stays durable and readable (§12.6);
-- §16.1 step 8's "automatic deletion of temporary lobby data" is about the
-- Lobby Engine's codes, tokens and per-viewer rows -- none of which exist
-- here -- and is not built by this slice.
-- =========================================================================
create or replace function app_private.close_lobby_session(
  target_channel_id uuid,
  target_lobby_id uuid
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
    raise exception 'lobby session not found' using errcode = 'P0002';
  end if;

  update public.lobby_sessions
     set closed_at = current_timestamp,
         updated_at = current_timestamp
   where id = target_lobby_id
     and channel_id = target_channel_id
     and closed_at is null;

  get diagnostics affected = row_count;
  if affected = 0 then
    raise exception 'lobby session not found' using errcode = 'P0002';
  end if;
end
$$;

revoke execute on function app_private.close_lobby_session(uuid, uuid) from public;
grant execute on function app_private.close_lobby_session(uuid, uuid) to bsa_app;

-- =========================================================================
-- list_channel_lobby_session: the creator/dashboard read of THE CURRENT
-- lobby. Any current channel member (owner through viewer -- the same role
-- set list_channel_goals, list_channel_master_canvas_modules and
-- list_channel_stream_mission already use) sees it; a non-member sees zero
-- rows.
--
-- READS NO TIER (§12.6). A Free or Pro creator reads their own lobby record
-- exactly as a Studio creator does; what the tier decides is whether the
-- CANVAS renders it.
--
-- "Current", not "history", matches §12.7 and this slice's stated scope --
-- closed lobbies remain durable rows (and remain exportable by any future
-- export job), but no history SURFACE is built here and none is claimed.
-- =========================================================================
create or replace function app_private.list_channel_lobby_session(target_channel_id uuid)
returns table (
  lobby_id uuid, seat_count integer, confirmed_seat_count integer, queue_count integer,
  opened_at timestamptz, closed_at timestamptz, created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select lobby.id, lobby.seat_count, lobby.confirmed_seat_count, lobby.queue_count,
         lobby.opened_at, lobby.closed_at, lobby.created_at, lobby.updated_at
    from public.lobby_sessions lobby
   where lobby.channel_id = target_channel_id
     and lobby.closed_at is null
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
   order by lobby.opened_at desc
   limit 1
$$;

revoke execute on function app_private.list_channel_lobby_session(uuid) from public;
grant execute on function app_private.list_channel_lobby_session(uuid) to bsa_app;

-- =========================================================================
-- list_overlay_lobby_status: the AGGREGATE-ONLY overlay read.
--
-- Same overlay_sessions token-fingerprint gate as every other
-- list_overlay_* function (0105 L926 is the canonical shape, 0136 and 0139
-- are the two most recent); no second auth path is introduced. An
-- unrecognised, foreign, expired or revoked session matches no row, so the
-- join produces nothing and the function returns ZERO ROWS -- never another
-- channel's lobby.
--
-- THREE INTEGERS. THAT IS THE WHOLE PROJECTION, and it is enforced on the
-- DECLARED RESULT TYPE below rather than by what the renderer chooses to
-- draw -- exactly as 0136 enforces `held_count bigint` and 0139 enforces
-- its four columns. A room code, a password, a seat token, a player
-- identifier, an in-game name, a Discord name, a viewer id, an anonymous
-- identity or a session id cannot be added without changing this signature,
-- which packages/db/tests/prf02_slice6_lobby_status.sql asserts directly
-- (from pg_get_function_result AND from a table materialised out of a live
-- call). None of them exists in this schema to be added in the first place.
--
-- THE LOBBY ID IS NOT RETURNED. It carries no information the card paints,
-- and "a session id" is on the prohibited list.
--
-- THE ENTITLEMENT GATE IS HERE AND NOWHERE ELSE. §30.3 places the Lobby
-- Engine at Creator+ or the Events Pack; owner decision 5 makes that
-- `tier in ('creator','studio') or an active pack grant`, and nothing can
-- currently grant the pack. So an unentitled channel's perfectly valid
-- overlay token returns zero rows, which the module renders as nothing.
--
-- §12.7 BOUNDED: at most the current lobby, never a history. The
-- `closed_at is null` predicate plus the partial unique index means this
-- returns zero or one row by construction; `limit 1` is belt to that
-- braces, matching list_overlay_stream_mission's own shape.
-- =========================================================================
create or replace function app_private.list_overlay_lobby_status(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (seat_count integer, confirmed_seat_count integer, queue_count integer)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select lobby.seat_count, lobby.confirmed_seat_count, lobby.queue_count
    from public.overlay_sessions session
    join public.lobby_sessions lobby on lobby.channel_id = session.channel_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and lobby.closed_at is null
     and app_private.events_pack_entitled(session.channel_id)
   order by lobby.opened_at desc
   limit 1
$$;

revoke execute on function app_private.list_overlay_lobby_status(uuid, text) from public;
grant execute on function app_private.list_overlay_lobby_status(uuid, text) to bsa_app;
