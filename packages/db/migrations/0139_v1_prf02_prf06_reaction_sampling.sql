-- PRF-02 slice 6, §6 catalogue module #5 (Reaction Cloud), and the PRF-06
-- obligation it rests on ("Server-side sampling and rate limiting for
-- reactions and chat") for the REACTIONS half only. Chat is untouched:
-- §6 #19 has no first-party data path and §9.1.1 forbids the embed inside
-- the Canvas, so building a chat half here would be building a surface
-- nobody can render.
--
-- Authority: FULL-PRODUCT-DEFINITION.md §6 module #5, §12.7, §19.5, §30.3,
-- HUB-07, PRF-06, and the owner decisions of 2026-09-16 recorded in
-- bharatstudio-requirements/reviews/2026-09-16-prf-02-slice-6-owner-decisions.md
-- (decisions 1 and 2) and written into §6's own module table.
--
-- ============================================================
-- A REACTION IS A SEND OF AN ENTRY THAT ALREADY EXISTS. THAT IS
-- WHY THIS MIGRATION CREATES NO CATALOGUE.
-- ============================================================
-- Owner decision 1: a reaction is a send of an entry from the EXISTING
-- curated sticker catalogue -- first-party entries
-- (public.sticker_catalogue_entries, migration 0110) plus staff-reviewed
-- creator packs (public.creator_sticker_packs, migration 0119, reviewed
-- through 0122/0125). So there is NO reaction catalogue in this file, NO
-- asset column, NO upload path, NO mime type, NO content hash, and NO
-- change of any kind to how packs are reviewed. If a viewer can only send
-- something already approved, the moderation question is already answered
-- and this migration must not re-open it.
--
-- BOTH HALVES OF THAT CATALOGUE ARE SENDABLE, IN ONE TABLE. 0110 and 0119
-- are two tables with two eligibility rules, and 0119 deliberately kept
-- its own selection table independent of 0110's ("Coexistence, not shared
-- mutual exclusion", 0119 L82-86). channel_reaction_sends therefore
-- carries two nullable foreign keys and a num_nonnulls(...) = 1 check:
-- one table because the Reaction Cloud is ONE cloud and a two-table
-- aggregate would have to be unioned in every read anyway, and
-- exactly-one-of because a reaction is one entry and the database, not
-- the application, is where that stays true.
--
-- ============================================================
-- NOT ONE NUMBER IN THIS FILE WAS CHOSEN BY ITS AUTHOR.
-- ============================================================
-- Owner decision 2: rate limiting REUSES the built mechanism. The figure
-- is the creator's own per-channel `rateLimitPerMinute` (creator-
-- configurable, bounded 1-1000 in
-- apps/api/src/domain/channel-config-schema.ts), enforced against a
-- ONE-MINUTE window exactly as migrations 0032 and 0063 already do. Every
-- numeric and structural element of the limiter below is lifted from
-- 0032 L101-140 / 0063 L56-82 rather than re-decided:
--
--   * the value is read with coalesce(rateLimitPerMinute, rateLimitPerMin)
--     -- 0063 L56's legacy alias, kept for the same reason it was kept
--     there (previously stored snapshots);
--   * it is accepted only when it matches '^[0-9]{1,4}$' and is
--     `between 1 and 1000` -- 0032 L109-113's exact guard;
--   * the window is `interval '1 minute'` -- 0032 L125 / 0063 L66;
--   * a window that has elapsed resets the counter to 1, a counter at or
--     above the limit refuses, anything else increments -- 0032's exact
--     three-branch shape;
--   * a value that is absent, malformed or out of bounds means NO LIMIT
--     -- 0032/0063's own fallback, reused rather than replaced with a
--     guessed default.
--
-- THE ONE PLACE A NUMBER COULD HAVE BEEN INVENTED IS THE CANVAS DISPLAY
-- CEILING, AND IT SHIPS UNSET. list_overlay_reaction_cloud takes
-- target_sample_max, and PostgreSQL's `LIMIT NULL` means no limit -- so
-- unset imposes no ceiling beyond this query's own structural bound (at
-- most one row per catalogue entry the channel can reach, itself bounded
-- by the catalogue and by app_private.creator_pack_tier_limit). That is
-- the "configured but unset" pattern this repository already uses for
-- overlayMaxInstanceSubscribers, overlayMaxChannelSubscribers,
-- derivedReadMaxConcurrent, derivedReadPoolMax and
-- derivedReadStatementTimeoutMs (all in apps/api/src/config.ts, all
-- number|undefined, all documented as "unset means today's behaviour,
-- never a value this codebase invents"), and which 0131 L32 names for the
-- module cap. A value below 1 fails CLOSED (zero rows), never open.
--
-- THE READ WINDOW IS THE SAME ONE MINUTE, NOT A SECOND NUMBER. §19.5
-- requires a sample but states no interval. Rather than invent one, the
-- overlay read aggregates over `interval '1 minute'` -- the identical
-- window 0032/0063 already enforce and the one owner decision 2 names.
-- One already-decided interval doing two jobs; a second interval would
-- have been a second invented number.
--
-- ============================================================
-- SAMPLING IS SERVER-SIDE, AND THE PROJECTION IS WHY.
-- ============================================================
-- §19.5: reactions are "sampled and rate-limited server-side BEFORE they
-- reach the canvas", and the cloud shows "a representative sample, never
-- every event". list_overlay_reaction_cloud returns count(*) GROUPED BY
-- catalogue entry. There is no code path on which an individual reaction
-- row -- or its timestamp -- reaches a client: not "we chose not to send
-- them", but "the declared `returns table` has no column for them". The
-- configured ceiling then caps how many AGGREGATE rows leave, inside this
-- security-definer function, before anything crosses the API boundary.
-- The client cannot receive the full stream and drop some, because the
-- full stream is not on the wire at any point.
--
-- §12.7 is satisfied by construction for the same reason: the read is
-- bounded, purpose-built and already aggregated -- never a history.
--
-- ============================================================
-- "NON-IDENTIFYING" IS A PROPERTY OF THE QUERY (§6 #5).
-- ============================================================
-- The overlay projection is exactly
--   (entry_source text, entry_id uuid, display_name text, reaction_count bigint)
-- and packages/db/tests/prf02_slice6_reaction_cloud.sql asserts that set
-- twice over -- from pg_get_function_result AND from a table materialised
-- out of a live call. display_name is catalogue metadata the PUBLIC read
-- path already returns to any viewer (0110 L255
-- list_public_stickers_for_channel, 0119 L239
-- list_public_creator_pack_for_channel, both `returns table (id uuid,
-- display_name text, category text)`) -- it is a sticker's name, not a
-- person's, and this path exposes nothing the tip page did not already.
--
-- No viewer id, no anonymous identity token, no session id, no IP and no
-- timestamp of any precision is returned. It is also not merely withheld:
-- channel_reaction_sends HAS no viewer column, no anonymous-token column,
-- no session column and no IP column, so there is nothing for a future
-- read to start exposing. created_at exists only because an append-only
-- row without a timestamp cannot be windowed; it is never returned, never
-- grouped on and never joined out.
--
-- THE CONSEQUENCE OF A PER-CHANNEL LIMIT, STATED RATHER THAN GLOSSED: one
-- viewer can consume a channel's whole minute. That is the decided design,
-- not an oversight. A per-viewer limit would need a viewer identifier,
-- which §6 #5 forbids on this surface, and a number the creator does not
-- control, which owner decision 2 forbids.
--
-- ============================================================
-- TIER.
-- ============================================================
-- All tiers. §30.3's own tier table reads "Free reactions, supporter wall
-- | yes | yes | yes | yes". The only gate anywhere near this module is the
-- pre-existing server-owned §30.3 MODULE CAP in 0131, which governs how
-- many Canvas modules a tier may activate and is untouched here --
-- 'reaction_cloud' was already one of 0131's twenty catalogue keys, so
-- that check constraint is not altered. Nothing in this file tier-gates
-- storing, viewing, searching, fetching or exporting a durable record.
-- The per-entry tier checks below are the EXISTING catalogue eligibility
-- rules (0110's sticker_tier_rank, 0119's creator_pack_tier_limit) applied
-- unchanged -- they decide which stickers a channel has, which was already
-- decided, not whether reactions exist.
--
-- ============================================================
-- ROLLBACK: additive only.
-- ============================================================
--   drop function app_private.list_overlay_reaction_cloud(uuid, text, integer);
--   drop function app_private.record_channel_reaction(uuid, text, uuid);
--   drop table public.channel_reaction_sends;
--   drop table public.channel_reaction_rate_limits;
-- No existing table, column, constraint, trigger, function, index or row
-- is created, altered or deleted by this migration, so dropping the four
-- objects above leaves the sticker catalogue, the creator packs, the
-- dispatcher and every overlay read byte-for-byte unaffected. No
-- production migration without separate explicit approval.
--
-- MIGRATION NUMBER: 0139, assigned to this task. 0138 belongs to a
-- concurrent agent and is neither written nor renumbered here.

-- =========================================================================
-- channel_reaction_sends: one row per reaction. Exactly one of sticker_id
-- (platform catalogue, 0110) / pack_sticker_id (staff-reviewed creator
-- pack, 0119) is set. NO viewer column of any kind exists here -- see the
-- header.
-- =========================================================================
create table public.channel_reaction_sends (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  sticker_id uuid references public.sticker_catalogue_entries(id),
  pack_sticker_id uuid references public.creator_sticker_packs(id),
  created_at timestamptz not null default current_timestamp,
  constraint channel_reaction_sends_exactly_one_entry
    check (num_nonnulls(sticker_id, pack_sticker_id) = 1)
);

-- Matches the overlay read's exact predicate: this channel's sends inside
-- the one-minute window, in created_at order.
create index channel_reaction_sends_channel_recent_idx
  on public.channel_reaction_sends (channel_id, created_at);

alter table public.channel_reaction_sends enable row level security;
revoke all on public.channel_reaction_sends from public;
revoke all on public.channel_reaction_sends from bsa_app;

-- =========================================================================
-- channel_reaction_rate_limits: the durable per-channel counter the
-- one-minute window is enforced against. The two columns are named after
-- queue_bindings' own rate-limit columns (0032) because they are the same
-- two values doing the same job -- window start plus count -- and a reader
-- who knows one should recognise the other instantly.
-- =========================================================================
create table public.channel_reaction_rate_limits (
  channel_id uuid primary key references public.channels(id),
  rate_limit_window_started_at timestamptz,
  rate_limit_send_count integer not null default 0,
  updated_at timestamptz not null default current_timestamp
);

alter table public.channel_reaction_rate_limits enable row level security;
revoke all on public.channel_reaction_rate_limits from public;
revoke all on public.channel_reaction_rate_limits from bsa_app;

-- =========================================================================
-- record_channel_reaction: the send path.
--
-- Never trusts the caller's entry choice. Re-checks existence, ownership,
-- tier eligibility and the live enabled/disabled state INSIDE this one
-- function against the SAME rules the existing public reads already apply
-- (0110's sticker_tier_rank + channel_sticker_disables; 0119's enabled +
-- status = 'active' + creator_pack_tier_limit rank window), then applies
-- the reused rate limit, then inserts. A rejection is an explicit outcome,
-- never a silent drop.
--
-- Returns a text outcome rather than raising, because 'rate_limited' is an
-- ordinary, expected answer on a high-frequency path -- not an exception --
-- and because the SQL acceptance test can then assert each outcome by
-- name. An unrecognised entry_source still RAISES: that is a programming
-- error, not a viewer's action, and silently choosing a source would be
-- inventing behaviour.
-- =========================================================================
create or replace function app_private.record_channel_reaction(
  target_channel_id uuid,
  target_entry_source text,
  target_entry_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  entitlement_tier text;
  catalogue_entry record;
  pack_entry record;
  is_disabled boolean;
  pack_rank integer;
  rate_limit_value text;
  rate_limit integer;
  limiter record;
begin
  if target_entry_source is null or target_entry_source not in ('catalogue', 'creator_pack') then
    raise exception 'unrecognised reaction entry source: %', target_entry_source using errcode = '22023';
  end if;

  select tier into entitlement_tier
    from public.channel_entitlement_versions
   where channel_id = target_channel_id
   order by version desc
   limit 1;
  if entitlement_tier is null then
    return 'unknown_entry';
  end if;

  if target_entry_source = 'catalogue' then
    select id, min_tier into catalogue_entry
      from public.sticker_catalogue_entries
     where id = target_entry_id;
    if not found then
      return 'unknown_entry';
    end if;
    -- 0110's own eligibility rule, applied unchanged.
    if app_private.sticker_tier_rank(catalogue_entry.min_tier) > app_private.sticker_tier_rank(entitlement_tier) then
      return 'not_available';
    end if;
    select exists (
      select 1 from public.channel_sticker_disables
       where channel_id = target_channel_id and sticker_id = target_entry_id
    ) into is_disabled;
    if is_disabled then
      return 'not_available';
    end if;
  else
    -- 0119's own eligibility rule, applied unchanged: the pack sticker
    -- must belong to THIS channel, be enabled, be past staff review
    -- ('active', never 'pending_review'), and sit inside the tier's rank
    -- window computed the same way list_public_creator_pack_for_channel
    -- computes it.
    select id, channel_id, enabled, status into pack_entry
      from public.creator_sticker_packs
     where id = target_entry_id;
    if not found or pack_entry.channel_id <> target_channel_id then
      return 'unknown_entry';
    end if;
    if not pack_entry.enabled or pack_entry.status <> 'active' then
      return 'not_available';
    end if;
    select rn into pack_rank
      from (
        select pack.id,
               row_number() over (order by pack.created_at, pack.id) as rn
          from public.creator_sticker_packs pack
         where pack.channel_id = target_channel_id
           and pack.enabled
           and pack.status = 'active'
      ) ranked
     where ranked.id = target_entry_id;
    if pack_rank is null or pack_rank > app_private.creator_pack_tier_limit(entitlement_tier) then
      return 'not_available';
    end if;
  end if;

  -- ---------------------------------------------------------------
  -- THE RATE LIMIT. Owner decision 2: the creator's own
  -- rateLimitPerMinute, one-minute window, exactly as 0032/0063.
  -- Parsing, bounds and the three-branch window logic below are lifted
  -- from those migrations, not re-decided here.
  -- ---------------------------------------------------------------
  select coalesce(
           config.values -> 'queue' ->> 'rateLimitPerMinute',
           config.values -> 'queue' ->> 'rateLimitPerMin'
         )
    into rate_limit_value
    from public.channel_configs config
   where config.channel_id = target_channel_id
   order by config.version desc
   limit 1;

  if rate_limit_value ~ '^[0-9]{1,4}$' then
    rate_limit := rate_limit_value::integer;
  end if;

  if rate_limit is not null and rate_limit between 1 and 1000 then
    insert into public.channel_reaction_rate_limits (channel_id, rate_limit_window_started_at, rate_limit_send_count)
    values (target_channel_id, null, 0)
    on conflict (channel_id) do nothing;

    -- Lock the counter row in the same transaction as the insert below so
    -- concurrent API replicas cannot consume the same slot -- the same
    -- reason 0032 locks the binding row.
    select rate_limit_window_started_at, rate_limit_send_count
      into limiter
      from public.channel_reaction_rate_limits
     where channel_id = target_channel_id
     for update;

    if limiter.rate_limit_window_started_at is null
       or limiter.rate_limit_window_started_at + interval '1 minute' <= current_timestamp then
      update public.channel_reaction_rate_limits
         set rate_limit_window_started_at = current_timestamp,
             rate_limit_send_count = 1,
             updated_at = current_timestamp
       where channel_id = target_channel_id;
    elsif limiter.rate_limit_send_count >= rate_limit then
      return 'rate_limited';
    else
      update public.channel_reaction_rate_limits
         set rate_limit_send_count = rate_limit_send_count + 1,
             updated_at = current_timestamp
       where channel_id = target_channel_id;
    end if;
  end if;

  if target_entry_source = 'catalogue' then
    insert into public.channel_reaction_sends (id, channel_id, sticker_id, pack_sticker_id, created_at)
    values (gen_random_uuid(), target_channel_id, target_entry_id, null, current_timestamp);
  else
    insert into public.channel_reaction_sends (id, channel_id, sticker_id, pack_sticker_id, created_at)
    values (gen_random_uuid(), target_channel_id, null, target_entry_id, current_timestamp);
  end if;

  return 'recorded';
end
$$;

revoke execute on function app_private.record_channel_reaction(uuid, text, uuid) from public;
grant execute on function app_private.record_channel_reaction(uuid, text, uuid) to bsa_app;

-- =========================================================================
-- list_overlay_reaction_cloud: the SERVER-SIDE SAMPLED overlay read.
--
-- Same overlay_sessions token-fingerprint gate as every other
-- list_overlay_* function (0105 L926 is the canonical shape); no second
-- auth path is introduced. An unrecognised, foreign, expired or revoked
-- session matches no row in the `session` CTE, so the join produces
-- nothing and the function returns ZERO ROWS -- never another channel's
-- cloud.
--
-- THE SAMPLING IS THE `limit` BELOW, AND IT IS INSIDE THE DATABASE. The
-- aggregate collapses every event into one row per entry before that, so
-- what the ceiling caps is already a projection, not a stream. Ordering is
-- deterministic on all three keys because a sample that reorders itself at
-- a fixed underlying state is not a sample -- without display_name and
-- entry_id the ceiling would slice an arbitrary subset out of a tie and
-- the cloud would flicker between frames.
--
-- `limit null` is no limit (the configured-but-unset case). A ceiling
-- below 1 yields `limit 0` -- fail closed, never open.
-- =========================================================================
create or replace function app_private.list_overlay_reaction_cloud(
  target_overlay_id uuid,
  target_token_fingerprint text,
  target_sample_max integer
)
returns table (entry_source text, entry_id uuid, display_name text, reaction_count bigint)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with authorised_session as (
    select overlay.channel_id
      from public.overlay_sessions overlay
     where overlay.id = target_overlay_id
       and overlay.token_fingerprint = target_token_fingerprint
       and overlay.revoked_at is null
       and overlay.expires_at > current_timestamp
  ),
  clustered as (
    select 'catalogue'::text as entry_source,
           send.sticker_id as entry_id,
           catalogue.display_name as display_name,
           count(*)::bigint as reaction_count
      from public.channel_reaction_sends send
      join authorised_session on authorised_session.channel_id = send.channel_id
      join public.sticker_catalogue_entries catalogue on catalogue.id = send.sticker_id
     where send.sticker_id is not null
       and send.created_at > current_timestamp - interval '1 minute'
     group by send.sticker_id, catalogue.display_name
    union all
    select 'creator_pack'::text,
           send.pack_sticker_id,
           pack.display_name,
           count(*)::bigint
      from public.channel_reaction_sends send
      join authorised_session on authorised_session.channel_id = send.channel_id
      join public.creator_sticker_packs pack on pack.id = send.pack_sticker_id
     where send.pack_sticker_id is not null
       and send.created_at > current_timestamp - interval '1 minute'
     group by send.pack_sticker_id, pack.display_name
  )
  select clustered.entry_source, clustered.entry_id, clustered.display_name, clustered.reaction_count
    from clustered
   order by clustered.reaction_count desc, clustered.display_name asc, clustered.entry_id asc
   limit case when target_sample_max is null then null
              when target_sample_max < 1 then 0
              else target_sample_max end
$$;

revoke execute on function app_private.list_overlay_reaction_cloud(uuid, text, integer) from public;
grant execute on function app_private.list_overlay_reaction_cloud(uuid, text, integer) to bsa_app;
