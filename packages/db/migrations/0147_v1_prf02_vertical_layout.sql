-- PRF-02 slice 7, §6 module #14: Vertical Stream Layout.
--
-- AUTHORITY. bharatstudio-requirements/active/tasks/
-- PRF-02-slice-7-vertical-layout.md, including its "CORRECTION,
-- 2026-09-17" section, which supersedes that task record's own original
-- prediction of "no new module, no migration, no API route and no
-- contract change". Re-examining (the task's own stop-condition fired)
-- produced a different answer, recorded there and implemented here.
--
-- MIGRATION NUMBER: 0147, assigned to this task. Nothing is renumbered
-- and no other number is written here.
--
-- ============================================================
-- 1. A LAYOUT IS NOT A MODULE.
-- ============================================================
-- 'vertical_stream_layout' already exists in migration 0131's
-- master_canvas_modules key catalogue, written when §6 had twenty
-- modules. Reusing it would need no migration at all -- and would be
-- wrong. §30.3's cap counts "Master Canvas modules active" (Free 2 /
-- Pro 5 / Creator 12 / Studio all), so a Pro creator with five slots
-- would spend one on *being vertical* and keep four for content. A
-- layout arranges the others; it is not one of them. So the vertical
-- layout is modelled here as a per-channel CANVAS SETTING -- a single
-- column on public.channels, the exact shape 0138's safe_mode_enabled
-- already established for "one bit of current state, no content, no
-- lifecycle, no history" (0138's own header explains why that shape
-- beats a new table for a fact this small) -- NOT a row in
-- master_canvas_modules, and it consumes no §30.3 cap slot. It is never
-- registered as a canvas module and app_private.list_overlay_master_
-- canvas_modules (0131) is untouched by this file.
--
-- ============================================================
-- 2. THE PRO+ GATE IS SERVER-SIDE, CALLED FROM INSIDE THE OVERLAY READ.
-- ============================================================
-- §30.3 places the vertical layout at Pro+. 00_LAUNCH_SCOPE_AUTHORITY.md
-- already rejects a browser-only gate for exactly this shape of
-- decision: "Database projections and RLS enforce this boundary; UI
-- hiding alone is insufficient." An overlay browser source is the least
-- trusted surface in the product, so the tier decision cannot live
-- there.
--
-- app_private.vertical_canvas_layout_entitled(channel_id) reuses
-- app_private.current_channel_tier (migration 0086_v1_l15_youtube_
-- connectors.sql:139, generic and pre-existing) rather than inventing a
-- tier lookup, and follows the exact shape migration 0143's
-- app_private.soundboard_module_entitled established for this same
-- Pro+ tier (its own app_private.soundboard_tier_rank helper, reused
-- here as app_private.canvas_layout_tier_rank -- a new, identically-
-- shaped function rather than a shared one, because every existing
-- *_tier_rank helper in this schema is already scoped one-per-feature,
-- not a shared utility). The check is called FROM INSIDE
-- app_private.list_overlay_canvas_layout below, so an unentitled
-- (sub-Pro) channel's perfectly valid overlay token receives the
-- 'horizontal' layout in its one returned row, never an error and never
-- zero rows for that reason alone.
--
-- STORING THE PREFERENCE IS NEVER TIER-GATED (§12.6, the same posture
-- 0143/0144/0145/0146 all took for their own creator-facing writes): a
-- Free creator can configure 'vertical' and see it recorded; only
-- whether the CANVAS RENDERS it is gated, and that gate lives in
-- exactly one place, list_overlay_canvas_layout, exactly like every
-- other Pro+ render gate in this schema.
--
-- ============================================================
-- 3. FOUR DEAD KEYS RETIRED FROM 0131'S CHECK CONSTRAINT.
-- ============================================================
-- 0131's check constraint on master_canvas_modules.module_key still
-- admits four keys no module implements: 'now_playing', 'chat',
-- 'stream_health_widget' and 'vertical_stream_layout'. Today's owner
-- decisions made the first three PERMANENTLY dead -- AUD-11 stands
-- (now_playing), chat was never a canvas module (§9.1.1/§4.2.1, the
-- 2026-09-17 #19 decision this task's own task record quotes), and
-- stream health moved to the dashboard -- and the fourth is this task's
-- own layout, which section 1 above establishes is not a module at all.
-- Left alone, a creator could enable 'now_playing', spend a §30.3 cap
-- slot on it, and render nothing forever: configuration reachable to no
-- effect.
--
-- WHAT THIS DELETES: any existing public.master_canvas_modules row
-- whose module_key is one of the four retired keys, for every channel,
-- unconditionally -- logged by RAISE NOTICE with the exact count and
-- (channel_id, module_key) pairs removed, so the delete is never silent,
-- before the tightened constraint makes re-inserting one impossible.
-- Per AGENTS.md, no shared/production database is migrated by this
-- change without separate explicit approval; in every environment this
-- migration is meant to run against (fresh schemas, the SQL test
-- suite's per-file template databases), the expected count is zero, and
-- the NOTICE fires only if that expectation is ever wrong.
--
-- ROLLBACK: additive/corrective only, no production migration without
-- separate explicit approval.
--   alter table public.master_canvas_modules
--     drop constraint if exists master_canvas_modules_module_key_check;
--   alter table public.master_canvas_modules
--     add constraint master_canvas_modules_module_key_check check (module_key in (
--       'support_theater', 'community_goal_ladder', 'tug_of_war_vote', 'boss_fight',
--       'reaction_cloud', 'safe_soundboard_alert', 'supporter_ticker', 'challenge_board',
--       'stream_mission_card', 'qr_smart_card', 'sponsor_card', 'moderator_status_card',
--       'milestone_celebration', 'vertical_stream_layout', 'stream_health_widget',
--       'lobby_status', 'giveaway_tournament_card', 'now_playing', 'chat', 'media_meme_queue'
--     ));
--   (the four retired keys' deleted rows are not recoverable -- the
--   delete above is destructive; this rollback restores the SCHEMA
--   shape only, not any deleted row.)
--   alter table public.channels drop column if exists canvas_layout;
--   drop function app_private.list_overlay_canvas_layout(uuid, text);
--   drop function app_private.get_channel_canvas_layout(uuid);
--   drop function app_private.set_channel_canvas_layout(uuid, uuid, text);
--   drop function app_private.vertical_canvas_layout_entitled(uuid);
--   drop function app_private.canvas_layout_tier_rank(text);
--
-- ============================================================
-- 4. WHAT THE LAYOUT CONTAINS -- NOT ENFORCED HERE, RECORDED HERE.
-- ============================================================
-- Compact goal, QR Smart Card and Reaction Cloud, in one fixed 9:16
-- arrangement. No chat, and no placeholder, empty slot or reserved
-- region standing in for chat (owner decision 2026-09-17, closing §6
-- #19 as not a canvas module -- see this task's own task record). This
-- migration ships no new overlay data for any of the three: the layout
-- setting this file adds only tells the client runtime WHICH arrangement
-- to paint already-fetched module data into
-- (apps/web/app/overlay/canvas/[overlayId]/page.tsx) -- §12.7's "a
-- narrower viewport must not cause any module to fetch more, subscribe
-- more, or retain more than it already does" is a client-side property
-- with nothing for this migration to enforce beyond not adding a fetch,
-- which it does not.

-- ---------------------------------------------------------------------
-- Retire the four dead keys. Delete first (logged, never silent), then
-- tighten the constraint so none of the four can be reinserted.
-- ---------------------------------------------------------------------
do $$
declare
  deleted_count integer;
  deleted_detail text;
begin
  select count(*), string_agg(format('(channel_id=%s module_key=%s)', channel_id, module_key), ', ' order by channel_id)
    into deleted_count, deleted_detail
    from public.master_canvas_modules
   where module_key in ('now_playing', 'chat', 'stream_health_widget', 'vertical_stream_layout');

  delete from public.master_canvas_modules
   where module_key in ('now_playing', 'chat', 'stream_health_widget', 'vertical_stream_layout');

  if deleted_count > 0 then
    raise notice 'migration 0147: retiring 4 dead master_canvas_modules keys (now_playing, chat, stream_health_widget, vertical_stream_layout) deleted % row(s): %', deleted_count, deleted_detail;
  else
    raise notice 'migration 0147: retiring 4 dead master_canvas_modules keys -- 0 existing rows affected';
  end if;
end
$$;

alter table public.master_canvas_modules
  drop constraint if exists master_canvas_modules_module_key_check;

alter table public.master_canvas_modules
  add constraint master_canvas_modules_module_key_check check (module_key in (
    'support_theater', 'community_goal_ladder', 'tug_of_war_vote', 'boss_fight',
    'reaction_cloud', 'safe_soundboard_alert', 'supporter_ticker', 'challenge_board',
    'stream_mission_card', 'qr_smart_card', 'sponsor_card', 'moderator_status_card',
    'milestone_celebration', 'lobby_status', 'giveaway_tournament_card', 'media_meme_queue'
  ));

-- ---------------------------------------------------------------------
-- The state. One bit, same shape as 0138's channels.safe_mode_enabled.
-- Additive and defaulted, so every existing channel reads 'horizontal'
-- and renders exactly as it did before this migration existed.
-- ---------------------------------------------------------------------
alter table public.channels
  add column if not exists canvas_layout text not null default 'horizontal'
    check (canvas_layout in ('horizontal', 'vertical'));

comment on column public.channels.canvas_layout is
  'PRF-02 §6 module #14 (Vertical Stream Layout): a creator switch, NOT a master_canvas_modules row and NOT §30.3-cap-counted. Configuring ''vertical'' is available at every tier (§12.6); whether the Canvas actually RENDERS vertical is gated Pro+ inside app_private.list_overlay_canvas_layout only.';

-- ---------------------------------------------------------------------
-- Tier rank, mirroring app_private.soundboard_tier_rank (migration 0143)
-- exactly -- a new, identically-shaped helper rather than a shared one,
-- matching every other *_tier_rank function in this schema (each is
-- already scoped one-per-feature).
-- ---------------------------------------------------------------------
create or replace function app_private.canvas_layout_tier_rank(target_tier text)
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
    else raise exception 'unrecognised tier for canvas layout entitlement: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.canvas_layout_tier_rank(text) from public;
grant execute on function app_private.canvas_layout_tier_rank(text) to bsa_app;

-- §30.3: vertical layout is Pro+. Reuses app_private.current_channel_tier
-- (0086_v1_l15_youtube_connectors.sql:139) rather than inventing a tier
-- lookup, and mirrors app_private.soundboard_module_entitled (0143)
-- exactly -- called FROM INSIDE the overlay read below, never from the
-- client.
create or replace function app_private.vertical_canvas_layout_entitled(target_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select app_private.canvas_layout_tier_rank(app_private.current_channel_tier(target_channel_id))
      >= app_private.canvas_layout_tier_rank('pro')
$$;

revoke execute on function app_private.vertical_canvas_layout_entitled(uuid) from public;
grant execute on function app_private.vertical_canvas_layout_entitled(uuid) to bsa_app;

-- ---------------------------------------------------------------------
-- Owner/admin write. Never tier-gated (§12.6) -- see section 2 above.
-- Mirrors app_private.set_channel_safe_mode (0138) exactly: role check,
-- validate, update, return the new value.
-- ---------------------------------------------------------------------
create or replace function app_private.set_channel_canvas_layout(
  target_channel_id uuid,
  target_user_id uuid,
  target_layout text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  result text;
begin
  if target_user_id is null
     or target_user_id <> app_private.current_user_id()
     or not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s canvas layout' using errcode = '42501';
  end if;

  -- Validated AFTER the authorization check, deliberately: a null/invalid
  -- value from a non-owner/admin must still answer 42501 (not-authorized
  -- is checked first, matching upsert_qr_smart_card's own precedence).
  if target_layout is null or target_layout not in ('horizontal', 'vertical') then
    raise exception 'invalid canvas layout' using errcode = '22023';
  end if;

  perform 1 from public.channels channel
   where channel.id = target_channel_id and channel.closed_at is null;
  if not found then
    raise exception 'channel not found' using errcode = '42501';
  end if;

  update public.channels
     set canvas_layout = target_layout, updated_at = current_timestamp
   where id = target_channel_id
  returning canvas_layout into result;

  return result;
end
$$;

revoke execute on function app_private.set_channel_canvas_layout(uuid, uuid, text) from public;
grant execute on function app_private.set_channel_canvas_layout(uuid, uuid, text) to bsa_app;

-- ---------------------------------------------------------------------
-- Creator/dashboard-facing read. Same member role set
-- list_channel_qr_smart_card and list_channel_master_canvas_modules use
-- (owner through viewer); a non-member sees zero rows. Carries the
-- CONFIGURED layout AND whether vertical is currently entitled, so the
-- creator-facing UI can show "Pro required" without a second tier
-- query -- never a second, independently-wrong copy of the gate itself,
-- which stays solely in list_overlay_canvas_layout below.
-- ---------------------------------------------------------------------
create or replace function app_private.get_channel_canvas_layout(target_channel_id uuid)
returns table (layout text, vertical_entitled boolean)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select channel.canvas_layout, app_private.vertical_canvas_layout_entitled(channel.id)
    from public.channels channel
   where channel.id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
$$;

revoke execute on function app_private.get_channel_canvas_layout(uuid) from public;
grant execute on function app_private.get_channel_canvas_layout(uuid) to bsa_app;

-- ---------------------------------------------------------------------
-- Overlay/browser-source-facing read. Same token-fingerprint gate every
-- other overlay read in this schema uses. ALWAYS returns exactly one row
-- for a valid, unexpired, unrevoked session -- unlike a module read,
-- the Canvas always needs SOME layout to paint, so there is no "nothing
-- to show" state here. The Pro+ gate is evaluated INSIDE this function,
-- not as a second copy in TypeScript: a sub-Pro channel that configured
-- 'vertical' still gets a row back, with layout = 'horizontal' --
-- section 2's whole point. A revoked/expired/wrong-fingerprint/foreign
-- session returns zero rows, exactly like every other overlay read.
-- ---------------------------------------------------------------------
create or replace function app_private.list_overlay_canvas_layout(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (layout text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select case
           when channel.canvas_layout = 'vertical'
                and app_private.vertical_canvas_layout_entitled(channel.id)
             then 'vertical'
           else 'horizontal'
         end
    from public.overlay_sessions session
    join public.channels channel on channel.id = session.channel_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
$$;

revoke execute on function app_private.list_overlay_canvas_layout(uuid, text) from public;
grant execute on function app_private.list_overlay_canvas_layout(uuid, text) to bsa_app;
