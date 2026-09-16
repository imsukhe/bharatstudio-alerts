-- PRF-02 slice 5, §6 catalogue module #9: Stream Mission Card. This is the
-- first catalogue module since slice 1 that needed schema of its own: the
-- slice 5 scope review (bharatstudio-requirements/reviews/
-- 2026-09-16-prf-02-slice-5-scope-review.md) established that every module
-- whose data was already reachable over the Canvas's single overlay
-- session had already been built, and classified #9 NEEDS-SCHEMA --
-- "grep for 'mission' across the schema and API returns only
-- permission/admission false positives."
--
-- FOUR OWNER DECISIONS BIND THIS FILE (FULL-PRODUCT-DEFINITION.md §6,
-- module table row 9, dated 2026-09-16). They are not relitigated here,
-- only implemented:
--
--   1. Module #9 may be built now. This overrides §34's Phase 3 placement
--      for module #9 ONLY and authorises nothing else from Phase 3.
--   2. Objective text is 1 to 120 characters, REUSING the already-decided
--      challenge-title bound -- 0109_v1_l17_paid_challenges.sql line 67,
--      `check (char_length(title) between 1 and 120)`. The same numbers
--      appear below because they are the same decision, not a new one.
--      There is NO separate title field: a mission has exactly one
--      creator-authored text column.
--   3. THE MISSION IS SESSION-BOUNDED, NOT CLOCK-BOUNDED. There is no
--      duration column, no timer value, no expiry interval and no
--      ends_at/expires_at/deadline column anywhere in this file. A mission
--      runs until the creator ends it (end_stream_mission stamps
--      ended_at) or until the overlay session rendering it ends -- and
--      that second half needed NO new mechanism, because
--      list_overlay_stream_mission is gated by the pre-existing
--      overlay_sessions row (`revoked_at is null and expires_at >
--      current_timestamp`) exactly as every other list_overlay_* function
--      already is. `ended_at` is a record of when the creator ended it,
--      never a schedule for when it will end.
--   4. All tiers, like every other built canvas module. §30.3's module cap
--      (0131) already governs how many modules a tier may ACTIVATE, and
--      'stream_mission_card' was already one of 0131's twenty catalogue
--      keys -- so 0131 is NOT edited by this migration and NO second tier
--      gate exists here. Nothing below reads a tier. §12.6: storing,
--      viewing and exporting a durable creator record is never
--      tier-gated; only rendering it on the Canvas counts against the cap.
--
-- AT MOST ONE RUNNING MISSION PER CHANNEL, ENFORCED BY THE DATABASE.
-- §12.7 requires the overlay read to return "at most the current mission,
-- never a history". 0131/0132 answered genuinely-unstated ordering
-- questions with an "order by the one timestamp that already exists"
-- tiebreak; this question is NOT unstated -- §12.7 answers it -- so it is
-- enforced with a partial unique index (stream_missions_channel_running_
-- idx) instead of tie-broken in a query. list_overlay_stream_mission still
-- carries `limit 1`, matching list_overlay_challenge's own shape (0109
-- L344-368), but it can never have two rows to choose between.
--
-- STARTING A SECOND MISSION IS A CONFLICT, NOT A SILENT SUPERSEDE.
-- start_stream_mission raises 23505 with a readable message rather than
-- quietly stamping ended_at on the running mission. Auto-superseding would
-- invent a lifecycle rule no authority states and would destroy a
-- creator's running mission on what may have been a mis-click. Ending,
-- then starting, is two explicit acts.
--
-- NO VIEWER, PAYMENT OR PERSONAL-DATA CLASS. The table stores channel_id,
-- created_by_user_id (the same existing internal app_users reference
-- public.challenges already carries, and never exposed to any overlay),
-- one creator-authored objective, and timestamps. No amount, no donor, no
-- message, no provider field. The overlay projection is narrower still --
-- mission_id, objective, started_at -- and returns no identity of any kind.
--
-- ROLLBACK: additive only. Undone by a NEW forward migration dropping the
-- four functions and the table -- never by editing or deleting this file.
-- That rollback DOES delete mission rows (there is no other way to undo a
-- create table); it is an operator-initiated rollback of the whole
-- capability, not a downgrade, and §12.6's "never destroys configuration"
-- binds the downgrade path, exactly as 0131's own rollback note records.
-- No production migration without separate explicit approval.

create table public.stream_missions (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  created_by_user_id uuid not null references public.app_users(id),
  -- Decision 2 above: the SAME bound as public.challenges.title (0109
  -- line 67), because it is the same decision, reused -- not a new number.
  objective text not null check (char_length(objective) between 1 and 120),
  started_at timestamptz not null default current_timestamp,
  -- Decision 3 above: a RECORD of when the creator ended the mission, not
  -- a schedule for when it will end. Null means running. There is no
  -- other temporal column on this table and there must never be one.
  ended_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  check (ended_at is null or ended_at >= started_at)
);

-- §12.7's "at most the current mission" as a database guarantee, not an
-- application convention. See the file header.
create unique index stream_missions_channel_running_idx
  on public.stream_missions (channel_id)
  where ended_at is null;

-- Ended missions stay durable and readable (§12.6); this index serves the
-- channel-scoped lookups without making the history itself a live surface.
create index stream_missions_channel_started_idx
  on public.stream_missions (channel_id, started_at desc);

alter table public.stream_missions enable row level security;
revoke all on public.stream_missions from public;
revoke all on public.stream_missions from bsa_app;

-- Owner/admin only, the same role set and the same has_channel_role check
-- 0109's create_challenge and 0131's upsert_master_canvas_module already
-- use. Reads no tier and calls no cap function (decision 4).
create or replace function app_private.start_stream_mission(
  target_channel_id uuid,
  target_objective text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  running_id uuid;
  new_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s stream mission' using errcode = '42501';
  end if;

  if target_objective is null or char_length(target_objective) not between 1 and 120 then
    raise exception 'invalid stream mission objective' using errcode = '22023';
  end if;

  -- Raised explicitly, before the insert, so the caller gets a readable
  -- message rather than a raw constraint violation. The partial unique
  -- index above is still the hard guarantee -- this is the courteous path,
  -- not the enforcing one.
  select id into running_id
    from public.stream_missions
   where channel_id = target_channel_id
     and ended_at is null;

  if running_id is not null then
    raise exception 'a stream mission is already running for this channel' using errcode = '23505';
  end if;

  new_id := gen_random_uuid();
  insert into public.stream_missions (id, channel_id, created_by_user_id, objective, started_at, ended_at, created_at, updated_at)
  values (new_id, target_channel_id, app_private.current_user_id(), target_objective, current_timestamp, null, current_timestamp, current_timestamp);

  return new_id;
end
$$;

revoke execute on function app_private.start_stream_mission(uuid, text) from public;
grant execute on function app_private.start_stream_mission(uuid, text) to bsa_app;

-- Owner/admin only. Addressed, not ambient: it takes the mission id as
-- well as the channel id, so a stale dashboard tab cannot end a mission
-- started after that tab loaded. The read that precedes it already returns
-- the id, so this costs the caller nothing.
--
-- NOT-FOUND AND NOT-AUTHORIZED ARE THE SAME ANSWER (P0002), deliberately
-- -- the same non-leaking mapping routes/master-canvas.ts already applies
-- when it turns a `forbidden` outcome into a 404 rather than a 403.
create or replace function app_private.end_stream_mission(
  target_channel_id uuid,
  target_mission_id uuid
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
    raise exception 'stream mission not found' using errcode = 'P0002';
  end if;

  update public.stream_missions
     set ended_at = current_timestamp,
         updated_at = current_timestamp
   where id = target_mission_id
     and channel_id = target_channel_id
     and ended_at is null;

  get diagnostics affected = row_count;
  if affected = 0 then
    raise exception 'stream mission not found' using errcode = 'P0002';
  end if;
end
$$;

revoke execute on function app_private.end_stream_mission(uuid, uuid) from public;
grant execute on function app_private.end_stream_mission(uuid, uuid) to bsa_app;

-- Creator/dashboard-facing read of THE CURRENT mission. Any current
-- channel member (owner through viewer -- the same role set
-- list_channel_goals and list_channel_master_canvas_modules already use)
-- sees it; a non-member sees zero rows. Reads no tier: §12.6 forbids
-- tier-gating the read of a durable creator record, and nothing here does.
--
-- "Current", not "history", matches §12.7 and this slice's stated scope --
-- ended missions remain durable rows (and remain exportable by any future
-- export job), but no history SURFACE is built by this slice and none is
-- claimed.
create or replace function app_private.list_channel_stream_mission(target_channel_id uuid)
returns table (
  mission_id uuid, objective text, started_at timestamptz, ended_at timestamptz,
  created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select mission.id, mission.objective, mission.started_at, mission.ended_at,
         mission.created_at, mission.updated_at
    from public.stream_missions mission
   where mission.channel_id = target_channel_id
     and mission.ended_at is null
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
   order by mission.started_at desc
   limit 1
$$;

revoke execute on function app_private.list_channel_stream_mission(uuid) from public;
grant execute on function app_private.list_channel_stream_mission(uuid) to bsa_app;

-- Overlay/browser-source-facing read. Same token-fingerprint gate as
-- list_overlay_goal (0102), list_overlay_challenge (0109),
-- list_overlay_master_canvas_modules (0131) and
-- list_overlay_tug_of_war_vote (0132) -- one shared overlay_sessions
-- model, no second auth path.
--
-- §12.7 BOUNDED: at most the current mission, never a history. The
-- `ended_at is null` predicate plus the partial unique index above means
-- this returns zero or one row by construction; `limit 1` is belt to that
-- braces, matching list_overlay_challenge's own shape.
--
-- THE PROJECTION IS DELIBERATELY THREE COLUMNS. created_by_user_id is
-- never returned (no identity reaches an overlay); created_at/updated_at
-- are internal bookkeeping the card does not paint; and ended_at is
-- `null` by definition for every row this function can return, so
-- returning it would carry no information while putting an end-shaped
-- field into a projection that -- per owner decision 3 -- must not have
-- one. packages/db/tests/prf02_slice5_stream_mission.sql asserts this
-- exact OUT column list against information_schema.parameters, so a
-- future widening is a failing test rather than a silent change.
create or replace function app_private.list_overlay_stream_mission(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (mission_id uuid, objective text, started_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select mission.id, mission.objective, mission.started_at
    from public.overlay_sessions session
    join public.stream_missions mission on mission.channel_id = session.channel_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and mission.ended_at is null
   order by mission.started_at desc
   limit 1
$$;

revoke execute on function app_private.list_overlay_stream_mission(uuid, text) from public;
grant execute on function app_private.list_overlay_stream_mission(uuid, text) to bsa_app;
