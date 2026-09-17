-- PRF-02 / PRF-06, §6 catalogue module #5 (Reaction Cloud): the reaction
-- rate limit moves from the CHANNEL to the SENDER.
--
-- Authority: FULL-PRODUCT-DEFINITION.md §6 module #5, §12.7, §19.5, HUB-07,
-- and the owner's direction of 2026-09-17, recorded in
-- bharatstudio-requirements/reviews/2026-09-17-prf-02-reaction-sender-rate-limit-decisions.md
--
-- THIS IS A FORWARD MIGRATION. 0139 is applied and is NOT edited.
--
-- ============================================================
-- WHAT WAS WRONG, IN THE OWNER'S OWN WORDS.
-- ============================================================
--   "all these should not be limited at channel level bcs then we are
--    limiting money for them these should be limited at sender/user level
--    to avoid misuse or attacks, so plan a safe number for user - for
--    creator dont limit it too much that with higher viewer etc they dont
--    face issue."
--
-- 0139 counted reactions PER CHANNEL against the creator's own
-- `rateLimitPerMinute`. Two separate faults:
--
--   1. A CHANNEL-LEVEL CAP THROTTLES THE CREATOR. A popular stream exhausts
--      the channel budget and then refuses LEGITIMATE viewers -- the more
--      successful the creator, the worse the surface behaves. Backwards.
--   2. `rateLimitPerMinute` IS THE CREATOR'S ALERT-SOURCE SETTING
--      (queue.rateLimitPerMinute, enforced for queue dispatch by 0032 and
--      0063). Borrowing it gave one creator-facing number a second,
--      unrelated meaning, so a creator tuning their alert queue would
--      silently retune their Reaction Cloud.
--
-- ============================================================
-- THE CHANNEL CAP IS REMOVED, NOT LOWERED AND NOT MADE OPTIONAL.
-- ============================================================
-- public.channel_reaction_rate_limits is dropped and the three-argument
-- record_channel_reaction is dropped. The replacement reads NO channel
-- configuration at all: neither `rateLimitPerMinute` nor its legacy
-- `rateLimitPerMin` alias appears anywhere in it, and
-- packages/db/tests/prf02_slice6_reaction_cloud.sql asserts their ABSENCE
-- from the shipped definition. A creator's reaction throughput now scales
-- with their audience and no channel budget can cap it. That is the point
-- of this migration, so it is proven by a test that fails if the cap comes
-- back -- not by this comment.
--
-- ============================================================
-- THE NUMBER IS 60 PER MINUTE PER SENDER, AND IT IS DELEGATED, NOT INVENTED.
-- ============================================================
-- The owner delegated the figure explicitly ("plan a safe number for
-- user"). Its ANCHOR is POST /v1/public/channels/:handle/paid-votes -- the
-- closest public-write sibling, on the same unauthenticated tip-page
-- surface -- which already carries
-- `config: { rateLimit: { max: 60, timeWindow: '1 minute' } }` in
-- apps/api/src/routes/public.ts. Same kind of request, same kind of caller,
-- same figure rather than a new one.
--
-- One send per second SUSTAINED ACROSS A FULL MINUTE is far above genuine
-- human tapping -- a viewer hammering a button in bursts stays well inside
-- it -- while scripted flooding needs orders of magnitude more than one per
-- second to matter, and is refused. It does not re-create the problem
-- above, because it is the SENDER's ceiling: ten thousand viewers can still
-- send 600,000 reactions a minute to one channel.
--
-- ============================================================
-- THE KEY IS THE EXISTING ANONYMOUS BROWSER IDENTITY. IT IS NOT AN IP.
-- ============================================================
-- Indian mobile carriers use CGNAT heavily: thousands of unrelated viewers
-- share one address, so an IP-keyed reaction limit would refuse genuine
-- viewers AS A GROUP -- the same "throttles the creator's audience" failure
-- the owner just rejected, only invisible. So the key comes from the
-- identity mechanism that already exists:
--
--   * the route hands in the SHA-256 fingerprint of the `__Host-bsa-anonymous`
--     browser token, obtained by the IDENTICAL three steps the two public
--     checkout POSTs already perform (read the cookie, mint one with
--     randomBytes(32).toString('base64url') and set the same cookie header
--     when absent, SHA-256 it). The RAW TOKEN NEVER ENTERS THIS DATABASE --
--     0124's own property, preserved rather than re-implemented;
--   * resolve_reaction_sender_key maps that fingerprint through
--     anonymous_browser_identities -> viewer_identities (0084, used by
--     0124). A browser whose identity has been CLAIMED INTO AN ACCOUNT
--     (viewer_identities.merged_into_account_id) keys on the ACCOUNT's
--     identity, so a signed-in viewer's several browsers share one budget
--     instead of multiplying it. That is "use the signed-in viewer identity
--     when there is one", expressed inside the schema that already exists.
--
-- NO IDENTITY ROW IS EVER MINTED BY A REACTION. resolve_reaction_sender_key
-- only READS. A fingerprint it does not recognise falls back to the opaque
-- key 'token:' || <sha-256 hex>, which creates nothing. This is a
-- DELIBERATE departure from app_private.resolve_anonymous_payment_identity
-- (0124), which does insert: letting a free interaction mint durable 30-day
-- identity rows would expand the identity table's population for a surface
-- §6 #5 requires to be non-identifying. Reactions consume the identity
-- graph and never grow it.
--
-- ============================================================
-- PRIVACY: ADMISSION CONTROL ONLY.
-- ============================================================
-- The sender key decides whether to accept a send and does NOTHING else. It
-- is never returned by any read, never written to the reaction row, never
-- logged and never used as a metric label.
--
-- THE REACTION ROW IS UNTOUCHED BY THIS MIGRATION.
-- public.channel_reaction_sends is not altered here: still no viewer
-- column, no anonymous-token column, no session column, no IP column. 0139's
-- D7 property ("not merely withheld -- there is nothing for a future read to
-- expose") survives this change completely.
--
-- THE OVERLAY PROJECTION IS UNTOUCHED BY THIS MIGRATION.
-- app_private.list_overlay_reaction_cloud still declares exactly
--   returns table (entry_source text, entry_id uuid, display_name text, reaction_count bigint)
-- and is not redefined here. The acceptance file asserts that set twice over,
-- from pg_get_function_result AND from a table materialised out of a live
-- call -- after this migration, not merely before it.
--
-- THE LIMITER TABLE HOLDS THREE COLUMNS AND NOTHING ELSE: sender_key, the
-- window start, and the count. THERE IS DELIBERATELY NO channel_id. A row
-- keyed (channel_id, sender_key) would state "this browser interacted with
-- this creator inside this minute" -- a small but real record of WHERE a
-- viewer was. Keyed on the sender alone, a row can say only "this sender has
-- sent N times in the current window" and cannot answer which creator, which
-- sticker, or which of anything. Keying on the sender alone is also the
-- stricter anti-abuse reading and the literal one: the owner said
-- "sender/user level", unqualified by channel.
--
-- HOW LONG THE STATE PERSISTS, AND WHY THAT IS THE MINIMUM. A row's content
-- never outlives its one-minute window: on the sender's next send an elapsed
-- window is overwritten IN PLACE (window start becomes now, count becomes 1),
-- so nothing from the previous window survives. For a sender who never
-- returns, the row is removed by the bounded sweep every send performs. A
-- fixed-window limiter cannot answer "is this the 61st send inside this
-- minute?" without holding, for the length of that window, one counter per
-- sender who sent inside it -- one minute is exactly the window the decision
-- names and one integer is exactly the state it needs. Anything less cannot
-- answer the question; anything more (a per-send row, a longer window, a
-- last-seen timestamp) would retain data the limit does not use. §12.7 is
-- satisfied for the same reason: the state is bounded by senders active in
-- the last minute, never by history.
--
-- The count is CLAMPED at 61 so it cannot accumulate into a measure of how
-- hard someone tried. 61 is simply "over the limit"; it is not a second
-- number and not a second policy.
--
-- ============================================================
-- A SEND WITH NO RESOLVABLE SENDER IS REFUSED, NEVER SILENTLY ACCEPTED.
-- ============================================================
-- record_channel_reaction returns 'sender_unidentified' BEFORE any
-- catalogue-eligibility check runs, so an unidentified caller cannot even
-- probe which stickers a channel has. The route answers 400
-- reaction_sender_unidentified, retryable false.
--
-- It does NOT fall back to the global per-IP limit. A fallback would make
-- the one path with no per-sender ceiling the path an attacker controls --
-- dropping a cookie would become the cheapest route to the weaker limit, so
-- the fallback would BE the attack. One rule, applied to everyone.
--
-- KNOWN RESIDUAL, STATED RATHER THAN GLOSSED: a client that DISCARDS the
-- cookie presents a new fingerprint per request and so evades the per-sender
-- limit. What remains against it is the PRE-EXISTING global
-- @fastify/rate-limit registration in apps/api/src/app.ts (120/minute,
-- IP-keyed), which this work neither adds nor changes. That backstop is
-- IP-keyed and is therefore itself subject to the CGNAT concern above -- but
-- it predates this change, applies to every route, and re-keying it is not
-- in this scope. The evasion buys nothing durable: because the resolver
-- never inserts, a cookie-discarding flooder cannot grow
-- anonymous_browser_identities, and each discarded identity's limiter row is
-- swept within a minute.
--
-- ============================================================
-- RETENTION IS STILL UNDECIDED, AND THIS MIGRATION MAKES IT MATTER MORE.
-- ============================================================
-- Removing the channel cap means reaction WRITE VOLUME NOW SCALES WITH
-- AUDIENCE SIZE: the mechanism that used to bound total inserts per channel
-- per minute is gone by design, so a popular stream writes far more rows to
-- channel_reaction_sends than before. NO RETENTION PERIOD IS INVENTED HERE.
-- Retention in this product is a trust, privacy and legal policy, never a
-- technical default -- someone must decide whether a reaction is ephemeral
-- telemetry or a durable creator record (§12.6) before any retention or
-- deletion job can exist. Named open question, owned by the owner.
--
-- ============================================================
-- ROLLBACK.
-- ============================================================
--   drop function app_private.record_channel_reaction(uuid, text, uuid, text);
--   drop function app_private.resolve_reaction_sender_key(text);
--   drop table public.reaction_sender_rate_limits;
-- then re-apply 0139's own channel_reaction_rate_limits table and its
-- three-argument record_channel_reaction definition. The only data lost
-- either way is in-flight one-minute counters, which are not a record of
-- anything. No existing table, column, constraint, trigger or row outside
-- the four objects named here is created, altered or deleted.
-- No production migration without separate explicit approval.
--
-- MIGRATION NUMBER: 0141, assigned to this task.

-- =========================================================================
-- Remove the per-channel cap. Dropped rather than left in place: a dead
-- counter table nobody writes is a trap for the next reader, and leaving the
-- three-argument function would leave a callable path that still applies the
-- cap the owner removed.
-- =========================================================================
drop function if exists app_private.record_channel_reaction(uuid, text, uuid);
drop table if exists public.channel_reaction_rate_limits;

-- =========================================================================
-- reaction_sender_rate_limits: one row per sender ACTIVE IN THE LAST MINUTE.
-- Three columns, no channel, no entry, no per-send timestamp -- see the
-- header for why each absence is deliberate.
-- =========================================================================
create table public.reaction_sender_rate_limits (
  sender_key text primary key,
  window_started_at timestamptz not null,
  send_count integer not null
);

-- The sweep's exact predicate.
create index reaction_sender_rate_limits_window_idx
  on public.reaction_sender_rate_limits (window_started_at);

alter table public.reaction_sender_rate_limits enable row level security;
revoke all on public.reaction_sender_rate_limits from public;
revoke all on public.reaction_sender_rate_limits from bsa_app;

-- =========================================================================
-- resolve_reaction_sender_key: fingerprint -> opaque admission-control key.
--
-- READ-ONLY BY CONSTRUCTION -- it is `language sql stable`, so it cannot
-- insert even if a future editor tried. That is the enforcement of "a
-- reaction never mints an identity row", not a comment about it.
--
-- Three branches, in priority order:
--   1. the browser's identity has been CLAIMED INTO AN ACCOUNT -> key on the
--      ACCOUNT's viewer_identities row, so a signed-in viewer's browsers
--      share one budget;
--   2. the browser's identity EXISTS and is unexpired -> key on it;
--   3. otherwise -> key on the opaque fingerprint itself, creating nothing.
--
-- A malformed or absent fingerprint returns NULL, and the caller refuses.
-- =========================================================================
create or replace function app_private.resolve_reaction_sender_key(target_token_hash text)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select case
    when target_token_hash is null or target_token_hash !~ '^[0-9a-f]{64}$' then null
    else coalesce(
      (select 'identity:' || account_identity.id::text
         from public.anonymous_browser_identities abi
         join public.viewer_identities anonymous_identity
           on anonymous_identity.anonymous_identity_id = abi.id
         join public.viewer_identities account_identity
           on account_identity.viewer_account_id = anonymous_identity.merged_into_account_id
        where abi.token_hash = target_token_hash
          and abi.expires_at > current_timestamp
        limit 1),
      (select 'identity:' || anonymous_identity.id::text
         from public.anonymous_browser_identities abi
         join public.viewer_identities anonymous_identity
           on anonymous_identity.anonymous_identity_id = abi.id
        where abi.token_hash = target_token_hash
          and abi.expires_at > current_timestamp
        limit 1),
      'token:' || target_token_hash
    )
  end
$$;

revoke execute on function app_private.resolve_reaction_sender_key(text) from public;
grant execute on function app_private.resolve_reaction_sender_key(text) to bsa_app;

-- =========================================================================
-- record_channel_reaction: the send path, rate-limited PER SENDER.
--
-- Everything 0139 decided about ENTRY ELIGIBILITY is carried over verbatim:
-- existence, channel ownership, tier eligibility, the creator's live
-- enabled/disabled set and staff-review state are re-checked inside this one
-- function against the SAME rules the existing public reads apply (0110's
-- sticker_tier_rank + channel_sticker_disables; 0119's enabled +
-- status = 'active' + creator_pack_tier_limit rank window). No eligibility
-- rule is added, removed or loosened by this migration -- only the rate limit
-- changed.
--
-- ORDER MATTERS: the sender is resolved and the budget spent BEFORE any
-- catalogue lookup. Admission control comes first, so an unidentified or
-- over-budget caller cannot use this function to probe a channel's sticker
-- set.
-- =========================================================================
create or replace function app_private.record_channel_reaction(
  target_channel_id uuid,
  target_entry_source text,
  target_entry_id uuid,
  target_sender_token_hash text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  resolved_sender_key text;
  window_count integer;
  entitlement_tier text;
  catalogue_entry record;
  pack_entry record;
  is_disabled boolean;
  pack_rank integer;
begin
  if target_entry_source is null or target_entry_source not in ('catalogue', 'creator_pack') then
    raise exception 'unrecognised reaction entry source: %', target_entry_source using errcode = '22023';
  end if;

  -- ---------------------------------------------------------------
  -- ADMISSION CONTROL, FIRST.
  -- ---------------------------------------------------------------
  resolved_sender_key := app_private.resolve_reaction_sender_key(target_sender_token_hash);
  if resolved_sender_key is null then
    return 'sender_unidentified';
  end if;

  -- Bounded sweep: retire windows that have elapsed, so the table converges
  -- on senders active in the last minute rather than accumulating a row per
  -- fingerprint ever seen. Capped per call via ctid so a send never pays for
  -- a full-table delete; the index above makes the scan a range read.
  delete from public.reaction_sender_rate_limits
   where ctid in (
     select swept.ctid
       from public.reaction_sender_rate_limits swept
      where swept.window_started_at <= current_timestamp - interval '1 minute'
      limit 200
   );

  -- One statement, so two concurrent sends by the same sender serialise on
  -- the row lock the upsert takes and cannot both consume the same slot.
  -- An elapsed window is overwritten in place -- the previous window's count
  -- does not survive into the new one.
  insert into public.reaction_sender_rate_limits (sender_key, window_started_at, send_count)
  values (resolved_sender_key, current_timestamp, 1)
  on conflict (sender_key) do update
     set window_started_at = case
           when reaction_sender_rate_limits.window_started_at + interval '1 minute' <= current_timestamp
             then current_timestamp
           else reaction_sender_rate_limits.window_started_at
         end,
         send_count = case
           when reaction_sender_rate_limits.window_started_at + interval '1 minute' <= current_timestamp
             then 1
           -- Clamped at 61 so the stored number is "at the limit" or "over
           -- it" and never a record of how hard someone tried.
           else least(reaction_sender_rate_limits.send_count + 1, 61)
         end
  returning send_count into window_count;

  -- 60 sends per minute per sender. Owner-delegated ("plan a safe number for
  -- user"), anchored to POST /v1/public/channels/:handle/paid-votes, which
  -- already uses max 60 per 1 minute on the same public surface.
  if window_count > 60 then
    return 'rate_limited';
  end if;

  -- ---------------------------------------------------------------
  -- ENTRY ELIGIBILITY -- 0139's rules, carried over unchanged.
  -- ---------------------------------------------------------------
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
    -- 0119's own eligibility rule, applied unchanged: the pack sticker must
    -- belong to THIS channel, be enabled, be past staff review ('active',
    -- never 'pending_review'), and sit inside the tier's rank window computed
    -- the same way list_public_creator_pack_for_channel computes it.
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

  -- The insert carries NO sender value. The key above was admission control
  -- and is discarded here; there is no column on this table for it to reach.
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

revoke execute on function app_private.record_channel_reaction(uuid, text, uuid, text) from public;
grant execute on function app_private.record_channel_reaction(uuid, text, uuid, text) to bsa_app;
