-- PRF-02 slice 6, §6 catalogue module #17 (Giveaway / Tournament Card), and
-- the MINIMUM §17 schema needed to render it.
--
-- Authority: FULL-PRODUCT-DEFINITION.md §6 module #17, §9.1.1, §12.6,
-- §12.7, §16, §17 IN FULL (§17.1 and §17.2), §30.3, §34, GIV-07, and the
-- owner decisions of 2026-09-16 recorded in bharatstudio-requirements/
-- reviews/2026-09-16-prf-02-slice-6-owner-decisions.md (decisions 4 and 5).
--
-- Task record: bharatstudio-requirements/active/tasks/
-- PRF-02-slice-6-giveaway-tournament.md.
-- Decision record: bharatstudio-requirements/reviews/
-- 2026-09-17-prf-02-slice-6-giveaway-tournament-decisions.md.
--
-- MIGRATION NUMBER: 0142, assigned to this task. 0141 is held concurrently
-- by another agent, is never written here, and nothing is renumbered.
--
-- BUILT ON TOP OF 0140 (§16 Lobby Status), which landed first. §17.2 says
-- tournaments are "built on the Lobby Engine rather than beside it", so
-- module #17 DEPENDS on module #16 and could not be built in parallel with
-- it.
--
-- ============================================================
-- THE FOUR THINGS THIS FILE DOES NOT BUILD, AND WHY EACH IS A
-- PRE-EXISTING DECISION RATHER THAN A PREFERENCE.
-- ============================================================
--
-- 1. NO CHANCE MECHANIC OF ANY KIND. Not a selection, not a seeded pick,
--    not a shuffle, not weighted odds, no randomness primitive anywhere.
--    §17.1 decided this on 2026-09-13 -- BEFORE and INDEPENDENTLY of
--    GIV-07 -- restricting giveaways to "free-entry and skill-based
--    formats only" and stating plainly that supporter-weighted odds are
--    not built. GIV-07 separately gates chance-based formats on legal
--    review that has not happened, and stays Blocked; nothing in this file
--    closes, narrows or may be described as progress against it.
--
--    gen_random_uuid() is used for primary keys exactly as 0140 uses it,
--    and is the ONLY token in this file containing the substring "random".
--    packages/db/tests/prf02_slice6_giveaway_tournament.sql asserts that
--    structurally against every shipped function definition, so a future
--    edit that reaches for a randomness primitive turns that file red by
--    name rather than passing because a comment said not to.
--
-- 2. NO "THE CREATOR RECORDS WHO WON" SURFACE. Owner decision 4 names that
--    outright as an invented product surface nobody decided. There is no
--    column for a result here, and none is approximated.
--
-- 3. BHARATSTUDIO NEVER HOLDS, ESCROWS, SHIPS OR GUARANTEES A PRIZE
--    (§17.1). The creator is the promoter and is responsible for
--    eligibility, taxes and delivery. So there is no custody column, no
--    fulfilment state, no delivery state, no postal field and no claim
--    surface in this schema, in the contracts, in the copy or in the
--    renderer. There is no prize description column either: the card does
--    not paint one, and storing free text about an item we have nothing to
--    do with is the first step toward language §17.1 forbids.
--
-- 4. NEVER A PAID-ONLY ENTRY, and no chance mechanic behind payment
--    (§17.1). That holds BY CONSTRUCTION here rather than by policy: there
--    is no entry path in this slice at all. entry_count is a number the
--    creator reports, exactly as 0140's seat and queue counts are, so
--    there is nothing for a payment to gate. No price, amount, currency,
--    paise, plan, subscription or billing token appears in this file, and
--    the SQL test asserts that too.
--
-- ============================================================
-- WHY THE CARD CANNOT SHOW A WINNER AT ALL IN THIS SLICE.
-- ============================================================
-- Owner decision 4 anticipated this and said that if the card cannot show
-- one, that is the correct conclusion. It cannot, for three independent
-- reasons, any one of which is sufficient:
--
--   * §17.1 permits the announcement only WITH CONSENT. No consent
--     mechanism exists anywhere in this schema, and building one is out of
--     scope -- the same ruling §16 already made for opted-in initials and
--     avatars.
--   * The name would be a participant identifier, and the overlay read
--     here is aggregate-only. No participant identity exists in this
--     migration to name in the first place.
--   * Nothing could produce one. The mechanic is not built (point 1
--     above), and a creator-typed result is point 2.
--
-- CONSEQUENTLY THERE IS NO TERMINAL TOURNAMENT STATE EITHER. A concluded
-- tournament returns nothing to the overlay -- the same nothing a channel
-- with no tournament returns. There is deliberately no "final complete"
-- or "champion decided" copy anywhere, because a terminal label on a
-- bracket is an announcement with the name left out, and it invites the
-- obvious next edit.
--
-- ============================================================
-- THE BRACKET TENSION, REPORTED RATHER THAN SOLVED.
-- ============================================================
-- A bracket TREE -- who plays whom -- is meaningless without participant
-- labels, and §16 already ruled that opted-in initials and avatars need an
-- opt-in mechanism that does not exist. So the tree is NOT built, and no
-- display-name concept was invented to make it buildable.
--
-- What ships instead is bracket PROGRESS: which round the tournament is
-- in, how many rounds there are, and how many of the current round's
-- matches are done. "Round 2 of 3, 2 of 4 matches complete" is true,
-- complete and useful to a viewer joining mid-stream, and it needs no
-- participant label at all. §17.2's own overlay contribution is a
-- "standings overlay module" (TRN-05); this is the part of it that can be
-- aggregate-only. What it costs -- the card cannot show who is still in --
-- is stated in the decision record rather than hidden.
--
-- ============================================================
-- SINGLE ELIMINATION, AND WHY IT IS THE ONLY BRACKET TYPE THAT
-- COULD SHIP HERE.
-- ============================================================
-- §17.2 lists four: single elimination, double elimination, round robin,
-- points table. Three independent reasons pick single elimination, each
-- sufficient on its own:
--
--   * §30.3 AND TRN-01/TRN-01b PUT THEM AT DIFFERENT TIERS. "Tournaments
--     -- single elim, up to 8" is (— | — | yes | yes), i.e. Creator+.
--     "Tournaments -- double elim, round robin, seeding, sponsor slots" is
--     (— | — | — | yes), i.e. Studio only. The entitlement owner decision
--     5 authorises is ONE gate -- tier in ('creator','studio') or a pack
--     grant -- not two. Shipping a Studio-only format behind a Creator+
--     gate would be implementing a tier nobody decided.
--   * A POINTS TABLE IS NOT A BRACKET. It is a standings table keyed on
--     participants, and it cannot be rendered at all without the labels
--     the section above rules out.
--   * ROUND ROBIN AND DOUBLE ELIMINATION HAVE NO ROUND STRUCTURE THAT IS
--     PURE ARITHMETIC. In single elimination the whole shape follows from
--     the field size: round r holds field / 2^r matches and there are
--     log2(field) rounds, so nothing has to be stored, chosen or invented.
--     A losers' bracket's length depends on a seeding convention, and a
--     round-robin schedule depends on a pairing algorithm. Both are
--     choices, and choices are what this slice may not make.
--
-- ============================================================
-- HOW THE TOURNAMENT REFERENCES 0140'S LOBBY INSTEAD OF
-- DUPLICATING IT.
-- ============================================================
-- public.tournaments carries a NOT NULL foreign key to
-- public.lobby_sessions(id), and THE BRACKET'S FIELD SIZE IS THE
-- REFERENCED LOBBY'S seat_count. There is no field-size column, no seat
-- column, no confirmed-seat column, no queue column, no queue policy, no
-- ready check and no participant column on public.tournaments at all.
--
-- The strongest reading of §17.2's "built on the Lobby Engine rather than
-- beside it" is not "point at a lobby and keep your own copy of its size";
-- it is that the LOBBY ROW is where the session's size lives, and the
-- tournament adds only the thing the lobby does not have -- where the
-- bracket has got to. start_tournament therefore READS
-- lobby_sessions.seat_count, refuses a lobby whose seat count is not 2, 4
-- or 8, and stores nothing; set_tournament_progress bounds its arguments
-- against that same column; and both reads derive total_rounds and
-- matches_in_round from it at read time. That deletes the entire class of
-- drift where a tournament says 8 and its lobby says 16.
--
-- THE COST, STATED RATHER THAN GLOSSED: a creator running an 8-TEAM
-- bracket on a 16-SEAT squad lobby cannot start a tournament, because
-- teams do not exist in this schema -- only seats do. That is a refusal
-- with a readable error rather than a wrong render, and the alternative (a
-- team concept) is a product surface nobody decided.
--
-- The tournament does NOT end when the lobby is closed. The lobby row
-- stays durable (§12.6) and both reads join it BY ID rather than by
-- closed_at, so closing a lobby never silently blanks a running bracket.
--
-- ============================================================
-- NOT ONE NUMBER IN THIS FILE WAS CHOSEN BY ITS AUTHOR.
-- ============================================================
--   * field size in (2, 4, 8) -- §30.3's "up to 8" is the ceiling;
--     power-of-two is the arithmetic of single elimination WITHOUT BYES,
--     and byes belong to seeding (TRN-02), which is not built.
--   * current_round between 1 and 3 -- log2(8) = 3. The ceiling is §30.3's
--     8, not a preference.
--   * completed_matches_in_round between 0 and 4 -- 8/2 = 4 is the largest
--     any round can be at field size 8. Same source.
--   * the EXACT per-tournament bound, completed_matches_in_round <=
--     seat_count >> current_round, is enforced in set_tournament_progress
--     rather than in a check constraint, because it depends on ANOTHER
--     ROW (the referenced lobby) and a table check constraint cannot reach
--     one. The table constraints above are the hard outer bounds; the
--     function is the exact one.
--   * entry_count >= 0 -- a count cannot be negative.
--   * entry_closes_at > entry_opens_at -- a window that closes before it
--     opens is not a window.
--   * closed_at >= entry_opens_at, concluded_at >= started_at -- the same
--     shape 0135 uses for ended_at and 0140 for closed_at.
--   * one OPEN giveaway and one RUNNING tournament per channel -- §12.7's
--     bounded read as a database guarantee, the identical partial unique
--     index 0135 and 0140 already use, for the identical reason.
--
-- THE ONE TEMPORAL COLUMN THAT EXISTS, AND WHY IT IS NOT THE THING 0140
-- REFUSED. entry_closes_at is an instant the CREATOR SUPPLIES, because
-- §17.1 names the entry window as something the creator defines and
-- publishes before entry opens, and §17.1's overlay list names "time
-- remaining". 0140 refused a lobby duration because §16 named no such
-- value and choosing one would have been inventing a number. Here the
-- authority names the value and the creator provides it. There is still NO
-- duration, countdown or timer column -- only the two window instants --
-- and the SQL test asserts that.
--
-- ============================================================
-- THE ENTITLEMENT IS 0140'S FUNCTION, CALLED AND NOT REWRITTEN.
-- ============================================================
-- Owner decision 5: the entitlement for §16/§17 is
--   tier in ('creator','studio')  OR  an active Events Pack grant,
-- with the pack side built as a check that has NO GRANT PATH YET.
-- app_private.events_pack_entitled(uuid) is that check and 0140 already
-- ships it. This migration CALLS it from exactly ONE place -- the OVERLAY
-- read -- and does not reimplement, copy or modify it.
--
-- This file does not mention the pack grant key at all, which is what
-- keeps 0140's own "nothing can grant the Events Pack" assertion -- it
-- scans EVERY app_private function except the check itself -- true after
-- this migration lands.
--
-- NO PRICE, NO BILLING, NO PURCHASE PATH. §33's Rs 129/mo stays in the
-- authority. Purchasing, when it is built, is website-only per the
-- standing constraint, and it is not built here.
--
-- ============================================================
-- THE TIER GATE IS ON THE MODULE, NEVER ON THE CREATOR'S RECORD.
-- ============================================================
-- §12.6: storing, viewing, searching, fetching and exporting a durable
-- creator record is never tier-gated. So open_giveaway,
-- update_giveaway_entry_count, close_giveaway, list_channel_giveaway,
-- start_tournament, set_tournament_progress, conclude_tournament and
-- list_channel_tournament read NO tier and call NO entitlement function.
-- Their only gate is the role gate, and it lives in SQL:
-- app_private.has_channel_role -- the same gate 0131, 0135 and 0140 use.
--
-- A Pro creator can open a giveaway, report entries, start and advance a
-- tournament and read all of it back at any time; what they do not get is
-- the Canvas module painting it on a broadcast.
--
-- 0131's §30.3 MODULE CAP is untouched: 'giveaway_tournament_card' was
-- already one of its twenty catalogue keys, so that check constraint is
-- not altered here. The cap and this entitlement are two independent gates
-- and both stand.
--
-- ============================================================
-- "AGGREGATE STATE ONLY" IS A PROPERTY OF THE QUERY.
-- ============================================================
-- app_private.list_overlay_giveaway_tournament returns exactly
--   (entry_count integer, entry_closes_at timestamptz,
--    tournament_current_round integer, tournament_total_rounds integer,
--    tournament_completed_matches_in_round integer,
--    tournament_matches_in_round integer)
-- and nothing else, ever. No participant identifier, no in-game name, no
-- Discord name, no viewer id, no anonymous identity, no session id, no
-- postal field and no contact detail -- and not merely withheld: NONE OF
-- THOSE THINGS EXISTS in this schema for a future read to start returning,
-- so nothing here can correlate one visit to another.
--
-- The giveaway id and the tournament id are not returned either. They
-- carry no information the card paints, and a session id is on the
-- prohibited list. Six aggregate values is the whole projection, and the
-- SQL test asserts that column set twice -- from pg_get_function_result
-- AND from a table materialised out of a live call -- exactly as 0136,
-- 0139 and 0140 do for theirs.
--
-- §12.7 IS SATISFIED BY CONSTRUCTION: the read returns CURRENT state, at
-- most one row by construction (the two partial unique indexes), never a
-- history. §9.1.1 is untouched -- nothing in this file can put a URL, a
-- script or an iframe anywhere near the Canvas.
--
-- ONE ROW OR ZERO. A row exists when EITHER half is live; the absent half
-- is null. Zero rows is the answer for an unrecognised, foreign, expired
-- or revoked session, for an unentitled channel, and for a channel with
-- neither a giveaway open nor a tournament running. The module renders the
-- same nothing for all of them, which is correct: none of them has
-- anything to tell a viewer.
--
-- ROLLBACK: additive only.
--   drop function app_private.list_overlay_giveaway_tournament(uuid, text);
--   drop function app_private.list_channel_tournament(uuid);
--   drop function app_private.conclude_tournament(uuid, uuid);
--   drop function app_private.set_tournament_progress(uuid, uuid, integer, integer);
--   drop function app_private.start_tournament(uuid, uuid);
--   drop function app_private.list_channel_giveaway(uuid);
--   drop function app_private.close_giveaway(uuid, uuid);
--   drop function app_private.update_giveaway_entry_count(uuid, uuid, integer);
--   drop function app_private.open_giveaway(uuid, timestamptz);
--   drop table public.tournaments;
--   drop table public.giveaways;
-- No existing table, column, constraint, trigger, function, index or row
-- is created, altered or deleted by this migration -- 0140's
-- lobby_sessions is REFERENCED, never altered -- so dropping the eleven
-- objects above leaves the entitlement ladder, the module catalogue, the
-- Lobby schema, the dispatcher and every other overlay read
-- byte-for-byte unaffected. That drop DOES delete giveaway and tournament
-- rows (there is no other way to undo a create table); it is an
-- operator-initiated rollback of the whole capability, not a downgrade,
-- exactly as 0131's, 0135's and 0140's own rollback notes record. No
-- production migration without separate explicit approval.

-- =========================================================================
-- giveaways: one row per giveaway a creator opened. An entry count, the
-- creator's published entry window, a lifecycle, and NOTHING ELSE.
--
-- Deliberately absent, one by one: no entrant or participant row, no entry
-- method, no follow/subscribe check, no supporter-status column, no
-- mechanic, no seeded value, no entrant snapshot, no result, no override
-- log, no consent flag, no claim surface, no postal field, no contact
-- detail, no item description, no custody or fulfilment state, and no
-- money of any kind. See the header for which decision forbids each.
-- =========================================================================
create table public.giveaways (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  created_by_user_id uuid not null references public.app_users(id),
  -- Creator-reported, exactly as 0140's seat and queue counts are, because
  -- the mechanism that would DERIVE it is the entry subsystem and that is
  -- the whole of §17. A count cannot be negative; there is no upper bound
  -- beyond the storage column's own range, because §17 names none.
  entry_count integer not null default 0 check (entry_count >= 0),
  -- §17.1's entry window. opens_at is recorded when the creator opens the
  -- giveaway; closes_at is the instant the CREATOR supplies. Scheduling a
  -- giveaway to open later is a separate §30.3 row and is not built here.
  entry_opens_at timestamptz not null default current_timestamp,
  entry_closes_at timestamptz not null,
  -- A RECORD of when the creator closed it, never a schedule. Null means
  -- open. Closing does not delete (§12.6).
  closed_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  constraint giveaways_window_ordered
    check (entry_closes_at > entry_opens_at),
  constraint giveaways_closed_after_opened
    check (closed_at is null or closed_at >= entry_opens_at)
);

-- §12.7's "at most the current giveaway" as a database guarantee rather
-- than an application convention -- the same shape 0140's
-- lobby_sessions_channel_open_idx uses.
create unique index giveaways_channel_open_idx
  on public.giveaways (channel_id)
  where closed_at is null;

-- Closed giveaways stay durable and readable (§12.6); this index serves
-- channel-scoped lookups without making the history a live surface.
create index giveaways_channel_opened_idx
  on public.giveaways (channel_id, entry_opens_at desc);

alter table public.giveaways enable row level security;
revoke all on public.giveaways from public;
revoke all on public.giveaways from bsa_app;

-- =========================================================================
-- tournaments: one row per tournament a creator started, ON a lobby.
--
-- THE FOREIGN KEY IS THE POINT. §17.2: "built on the Lobby Engine rather
-- than beside it". The bracket's field size is the referenced lobby's
-- seat_count and is NOT stored here -- see the header. The only things
-- this table adds are the two numbers the lobby does not have.
--
-- Deliberately absent: no field-size, seat, confirmed-seat, queue, queue
-- policy, ready-check, seeding, check-in, participant, team, match, score,
-- dispute-note, sponsor or exposure column, and no result of any kind.
-- =========================================================================
create table public.tournaments (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  -- §17.2's dependency, as a database constraint rather than a convention.
  -- Joined BY ID in both reads, never by the lobby's own lifecycle, so
  -- closing the lobby never blanks a running bracket.
  lobby_session_id uuid not null references public.lobby_sessions(id),
  created_by_user_id uuid not null references public.app_users(id),
  -- Outer bounds only: log2(8) = 3 rounds, and 8/2 = 4 matches is the
  -- largest any round can be at §30.3's maximum field of 8. The EXACT
  -- per-tournament bound depends on the referenced lobby's seat_count,
  -- which a check constraint cannot reach, so it lives in
  -- set_tournament_progress instead.
  current_round integer not null default 1 check (current_round between 1 and 3),
  completed_matches_in_round integer not null default 0
    check (completed_matches_in_round between 0 and 4),
  started_at timestamptz not null default current_timestamp,
  -- A RECORD of when the creator concluded it, never a schedule. Null
  -- means running. Concluding does not delete (§12.6), and it produces no
  -- terminal state on the overlay -- see the header.
  concluded_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  constraint tournaments_concluded_after_started
    check (concluded_at is null or concluded_at >= started_at)
);

create unique index tournaments_channel_running_idx
  on public.tournaments (channel_id)
  where concluded_at is null;

create index tournaments_channel_started_idx
  on public.tournaments (channel_id, started_at desc);

create index tournaments_lobby_session_idx
  on public.tournaments (lobby_session_id);

alter table public.tournaments enable row level security;
revoke all on public.tournaments from public;
revoke all on public.tournaments from bsa_app;

-- =========================================================================
-- open_giveaway: owner/admin only, the same role set and the same
-- has_channel_role check 0140's open_lobby_session and 0131's
-- upsert_master_canvas_module already use.
--
-- READS NO TIER AND CALLS NO ENTITLEMENT FUNCTION (§12.6).
--
-- Takes the entry window's CLOSE INSTANT and nothing else. There is no
-- entry method, no mechanic, no item description and no money to supply,
-- because none of them exists -- see the header.
-- =========================================================================
create or replace function app_private.open_giveaway(
  target_channel_id uuid,
  target_entry_closes_at timestamptz
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
    raise exception 'not authorized to manage this channel''s giveaway' using errcode = '42501';
  end if;

  if target_entry_closes_at is null or target_entry_closes_at <= current_timestamp then
    raise exception 'invalid giveaway entry window' using errcode = '22023';
  end if;

  -- Raised explicitly before the insert so the caller gets a readable
  -- message rather than a raw constraint violation. The partial unique
  -- index is still the hard guarantee. A second open giveaway is a
  -- CONFLICT the creator resolves, never a silent supersede.
  select id into open_id
    from public.giveaways
   where channel_id = target_channel_id
     and closed_at is null;

  if open_id is not null then
    raise exception 'a giveaway is already open for this channel' using errcode = '23505';
  end if;

  new_id := gen_random_uuid();
  insert into public.giveaways (
    id, channel_id, created_by_user_id, entry_count,
    entry_opens_at, entry_closes_at, closed_at, created_at, updated_at
  ) values (
    new_id, target_channel_id, app_private.current_user_id(), 0,
    current_timestamp, target_entry_closes_at, null, current_timestamp, current_timestamp
  );

  return new_id;
end
$$;

revoke execute on function app_private.open_giveaway(uuid, timestamptz) from public;
grant execute on function app_private.open_giveaway(uuid, timestamptz) to bsa_app;

-- =========================================================================
-- update_giveaway_entry_count: the creator reports how many entries there
-- are. Owner/admin only, and ADDRESSED rather than ambient -- it takes the
-- giveaway id as well as the channel id, so a stale dashboard tab cannot
-- write a count onto a giveaway opened after that tab loaded. The read
-- that precedes it already returns the id, so this costs the caller
-- nothing. The identical shape 0140's update_lobby_session_counts uses.
--
-- NOT-FOUND AND NOT-AUTHORIZED ARE THE SAME ANSWER (P0002), deliberately.
-- =========================================================================
create or replace function app_private.update_giveaway_entry_count(
  target_channel_id uuid,
  target_giveaway_id uuid,
  target_entry_count integer
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
    raise exception 'giveaway not found' using errcode = 'P0002';
  end if;

  if target_entry_count is null or target_entry_count < 0 then
    raise exception 'invalid giveaway entry count' using errcode = '22023';
  end if;

  update public.giveaways
     set entry_count = target_entry_count,
         updated_at = current_timestamp
   where id = target_giveaway_id
     and channel_id = target_channel_id
     and closed_at is null;

  get diagnostics affected = row_count;
  if affected = 0 then
    raise exception 'giveaway not found' using errcode = 'P0002';
  end if;
end
$$;

revoke execute on function app_private.update_giveaway_entry_count(uuid, uuid, integer) from public;
grant execute on function app_private.update_giveaway_entry_count(uuid, uuid, integer) to bsa_app;

-- =========================================================================
-- close_giveaway: owner/admin only, addressed by giveaway id, and the same
-- one-indistinguishable-P0002 answer for an unknown, already-closed,
-- other-channel or unauthorised giveaway.
--
-- CLOSING DELETES NOTHING and produces nothing. The row stays durable and
-- readable (§12.6), and no result, announcement or terminal state follows
-- -- see the header for the three reasons the card cannot show one.
-- =========================================================================
create or replace function app_private.close_giveaway(
  target_channel_id uuid,
  target_giveaway_id uuid
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
    raise exception 'giveaway not found' using errcode = 'P0002';
  end if;

  update public.giveaways
     set closed_at = current_timestamp,
         updated_at = current_timestamp
   where id = target_giveaway_id
     and channel_id = target_channel_id
     and closed_at is null;

  get diagnostics affected = row_count;
  if affected = 0 then
    raise exception 'giveaway not found' using errcode = 'P0002';
  end if;
end
$$;

revoke execute on function app_private.close_giveaway(uuid, uuid) from public;
grant execute on function app_private.close_giveaway(uuid, uuid) to bsa_app;

-- =========================================================================
-- list_channel_giveaway: the creator/dashboard read of THE CURRENT
-- giveaway. Any current channel member (owner through viewer -- the same
-- role set 0140's list_channel_lobby_session uses) sees it; a non-member
-- sees zero rows.
--
-- READS NO TIER (§12.6). A Free or Pro creator reads their own giveaway
-- record exactly as a Studio creator does; what the tier decides is
-- whether the CANVAS renders it.
-- =========================================================================
create or replace function app_private.list_channel_giveaway(target_channel_id uuid)
returns table (
  giveaway_id uuid, entry_count integer,
  entry_opens_at timestamptz, entry_closes_at timestamptz, closed_at timestamptz,
  created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select giveaway.id, giveaway.entry_count,
         giveaway.entry_opens_at, giveaway.entry_closes_at, giveaway.closed_at,
         giveaway.created_at, giveaway.updated_at
    from public.giveaways giveaway
   where giveaway.channel_id = target_channel_id
     and giveaway.closed_at is null
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
   order by giveaway.entry_opens_at desc
   limit 1
$$;

revoke execute on function app_private.list_channel_giveaway(uuid) from public;
grant execute on function app_private.list_channel_giveaway(uuid) to bsa_app;

-- =========================================================================
-- start_tournament: owner/admin only, on a lobby of the SAME channel that
-- is currently OPEN and whose seat_count is 2, 4 or 8.
--
-- THIS IS WHERE §17.2's "BUILT ON THE LOBBY ENGINE" IS ENFORCED. The
-- lobby's seat_count is READ and validated; it is never copied into this
-- table. The bounds are §30.3's "up to 8" plus the arithmetic of single
-- elimination without byes -- see the header.
--
-- READS NO TIER AND CALLS NO ENTITLEMENT FUNCTION (§12.6).
-- =========================================================================
create or replace function app_private.start_tournament(
  target_channel_id uuid,
  target_lobby_session_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  running_id uuid;
  lobby_seats integer;
  new_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s tournament' using errcode = '42501';
  end if;

  select lobby.seat_count into lobby_seats
    from public.lobby_sessions lobby
   where lobby.id = target_lobby_session_id
     and lobby.channel_id = target_channel_id
     and lobby.closed_at is null;

  if lobby_seats is null then
    raise exception 'lobby session not found' using errcode = 'P0002';
  end if;

  if lobby_seats not in (2, 4, 8) then
    raise exception 'a single-elimination bracket needs a field of 2, 4 or 8 seats' using errcode = '22023';
  end if;

  select id into running_id
    from public.tournaments
   where channel_id = target_channel_id
     and concluded_at is null;

  if running_id is not null then
    raise exception 'a tournament is already running for this channel' using errcode = '23505';
  end if;

  new_id := gen_random_uuid();
  insert into public.tournaments (
    id, channel_id, lobby_session_id, created_by_user_id,
    current_round, completed_matches_in_round,
    started_at, concluded_at, created_at, updated_at
  ) values (
    new_id, target_channel_id, target_lobby_session_id, app_private.current_user_id(),
    1, 0, current_timestamp, null, current_timestamp, current_timestamp
  );

  return new_id;
end
$$;

revoke execute on function app_private.start_tournament(uuid, uuid) from public;
grant execute on function app_private.start_tournament(uuid, uuid) to bsa_app;

-- =========================================================================
-- set_tournament_progress: the creator reports which round the tournament
-- is in and how many of that round's matches are done. Owner/admin only,
-- addressed by tournament id, both values written together because they
-- are read together on one card.
--
-- THE EXACT BOUNDS COME FROM THE REFERENCED LOBBY, not from this table and
-- not from this file's author: the field size is lobby.seat_count, the
-- round ceiling is log2(field) and the match ceiling is field >> round.
-- Both are integer arithmetic on §30.3's own "up to 8".
--
-- NO SCORE, NO RESULT, NO PAIRING AND NO DISPUTE NOTE is written. Those
-- are TRN-04 and need match rows, which do not exist here.
-- =========================================================================
create or replace function app_private.set_tournament_progress(
  target_channel_id uuid,
  target_tournament_id uuid,
  target_current_round integer,
  target_completed_matches_in_round integer
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  lobby_seats integer;
  affected integer;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'tournament not found' using errcode = 'P0002';
  end if;

  if target_current_round is null or target_current_round < 1
     or target_completed_matches_in_round is null or target_completed_matches_in_round < 0 then
    raise exception 'invalid tournament progress' using errcode = '22023';
  end if;

  select lobby.seat_count into lobby_seats
    from public.tournaments tournament
    join public.lobby_sessions lobby on lobby.id = tournament.lobby_session_id
   where tournament.id = target_tournament_id
     and tournament.channel_id = target_channel_id
     and tournament.concluded_at is null;

  if lobby_seats is null then
    raise exception 'tournament not found' using errcode = 'P0002';
  end if;

  -- (field >> round) >= 1 is exactly "round <= log2(field)". Integer shift,
  -- so it is exact and there is no floating-point comparison anywhere.
  if (lobby_seats >> target_current_round) < 1 then
    raise exception 'that round is past the end of this bracket' using errcode = '22023';
  end if;

  if target_completed_matches_in_round > (lobby_seats >> target_current_round) then
    raise exception 'a round cannot complete more matches than it holds' using errcode = '22023';
  end if;

  update public.tournaments
     set current_round = target_current_round,
         completed_matches_in_round = target_completed_matches_in_round,
         updated_at = current_timestamp
   where id = target_tournament_id
     and channel_id = target_channel_id
     and concluded_at is null;

  get diagnostics affected = row_count;
  if affected = 0 then
    raise exception 'tournament not found' using errcode = 'P0002';
  end if;
end
$$;

revoke execute on function app_private.set_tournament_progress(uuid, uuid, integer, integer) from public;
grant execute on function app_private.set_tournament_progress(uuid, uuid, integer, integer) to bsa_app;

-- =========================================================================
-- conclude_tournament: owner/admin only, addressed by tournament id, same
-- one-indistinguishable-P0002 answer.
--
-- CONCLUDING DELETES NOTHING AND ANNOUNCES NOTHING. The row stays durable
-- and readable (§12.6), and the overlay simply stops having anything to
-- paint -- there is deliberately no terminal state, for the three reasons
-- in the header.
-- =========================================================================
create or replace function app_private.conclude_tournament(
  target_channel_id uuid,
  target_tournament_id uuid
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
    raise exception 'tournament not found' using errcode = 'P0002';
  end if;

  update public.tournaments
     set concluded_at = current_timestamp,
         updated_at = current_timestamp
   where id = target_tournament_id
     and channel_id = target_channel_id
     and concluded_at is null;

  get diagnostics affected = row_count;
  if affected = 0 then
    raise exception 'tournament not found' using errcode = 'P0002';
  end if;
end
$$;

revoke execute on function app_private.conclude_tournament(uuid, uuid) from public;
grant execute on function app_private.conclude_tournament(uuid, uuid) to bsa_app;

-- =========================================================================
-- list_channel_tournament: the creator/dashboard read of THE CURRENT
-- tournament. Any current channel member; a non-member sees zero rows.
--
-- READS NO TIER (§12.6).
--
-- field_size, total_rounds and matches_in_round are DERIVED FROM THE
-- REFERENCED LOBBY at read time, not stored -- which is what makes "the
-- tournament references the lobby rather than duplicating it" a fact about
-- the schema rather than a claim in a comment. The lobby is joined BY ID,
-- so a closed lobby does not hide a running tournament from its creator.
-- =========================================================================
create or replace function app_private.list_channel_tournament(target_channel_id uuid)
returns table (
  tournament_id uuid, lobby_session_id uuid, field_size integer,
  current_round integer, total_rounds integer,
  completed_matches_in_round integer, matches_in_round integer,
  started_at timestamptz, concluded_at timestamptz,
  created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select tournament.id, tournament.lobby_session_id, lobby.seat_count,
         tournament.current_round,
         case lobby.seat_count when 2 then 1 when 4 then 2 when 8 then 3 end,
         tournament.completed_matches_in_round,
         (lobby.seat_count >> tournament.current_round),
         tournament.started_at, tournament.concluded_at,
         tournament.created_at, tournament.updated_at
    from public.tournaments tournament
    join public.lobby_sessions lobby on lobby.id = tournament.lobby_session_id
   where tournament.channel_id = target_channel_id
     and tournament.concluded_at is null
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
   order by tournament.started_at desc
   limit 1
$$;

revoke execute on function app_private.list_channel_tournament(uuid) from public;
grant execute on function app_private.list_channel_tournament(uuid) to bsa_app;

-- =========================================================================
-- list_overlay_giveaway_tournament: the AGGREGATE-ONLY overlay read.
--
-- Same overlay_sessions token-fingerprint gate as every other
-- list_overlay_* function (0105 L926 is the canonical shape; 0136, 0139
-- and 0140 are the three most recent); no second auth path is introduced.
-- An unrecognised, foreign, expired or revoked session matches no row, so
-- the read returns ZERO ROWS -- never another channel's state.
--
-- SIX AGGREGATE VALUES. THAT IS THE WHOLE PROJECTION, and it is enforced
-- on the DECLARED RESULT TYPE below rather than by what the renderer
-- chooses to draw -- exactly as 0136, 0139 and 0140 enforce theirs. A
-- participant identifier, an in-game name, a Discord name, a viewer id, an
-- anonymous identity, a session id, a postal field or a contact detail
-- cannot be added without changing this signature, which
-- packages/db/tests/prf02_slice6_giveaway_tournament.sql asserts directly
-- (from pg_get_function_result AND from a table materialised out of a live
-- call). None of them exists in this schema to be added in the first
-- place.
--
-- NO IDENTIFIER OF EITHER RECORD IS RETURNED. Neither carries information
-- the card paints, and a session id is on the prohibited list.
--
-- THE ENTITLEMENT GATE IS HERE AND NOWHERE ELSE, and it is 0140's own
-- app_private.events_pack_entitled, CALLED rather than reimplemented.
--
-- THE TOURNAMENT'S BRACKET SHAPE COMES FROM THE LOBBY ROW, joined BY ID:
-- total_rounds and matches_in_round are computed from
-- lobby_sessions.seat_count at read time and are stored nowhere. That is
-- §17.2's "built on the Lobby Engine rather than beside it", enforced.
--
-- A LEFT JOIN ON EACH HALF, and a row only when at least one is live. §12.7
-- BOUNDED: current state, at most one row by construction (the two partial
-- unique indexes), never a history.
-- =========================================================================
create or replace function app_private.list_overlay_giveaway_tournament(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (
  entry_count integer,
  entry_closes_at timestamptz,
  tournament_current_round integer,
  tournament_total_rounds integer,
  tournament_completed_matches_in_round integer,
  tournament_matches_in_round integer
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select giveaway.entry_count,
         giveaway.entry_closes_at,
         tournament.current_round,
         case lobby.seat_count when 2 then 1 when 4 then 2 when 8 then 3 end,
         tournament.completed_matches_in_round,
         (lobby.seat_count >> tournament.current_round)
    from public.overlay_sessions session
    left join public.giveaways giveaway
      on giveaway.channel_id = session.channel_id and giveaway.closed_at is null
    left join public.tournaments tournament
      on tournament.channel_id = session.channel_id and tournament.concluded_at is null
    left join public.lobby_sessions lobby
      on lobby.id = tournament.lobby_session_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and (giveaway.id is not null or tournament.id is not null)
     and app_private.events_pack_entitled(session.channel_id)
   limit 1
$$;

revoke execute on function app_private.list_overlay_giveaway_tournament(uuid, text) from public;
grant execute on function app_private.list_overlay_giveaway_tournament(uuid, text) to bsa_app;
