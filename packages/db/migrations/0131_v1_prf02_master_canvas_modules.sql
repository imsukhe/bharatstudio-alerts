-- PRF-02: Master Canvas as the runtime. This migration carries only the
-- SERVER-OWNED half of PRF-02 -- the module cap (FULL-PRODUCT-DEFINITION.md
-- §30.3: "Master Canvas modules active -- Free 2 / Pro 5 / Creator 12 /
-- Studio all") and the durable per-channel module configuration it gates.
-- The runtime itself (single connection, single rAF loop, per-module error
-- boundaries, bounded DOM/recycling) is client-side and carries no schema.
--
-- CATALOGUE: the 20-module catalogue from §6, as stable snake_case keys.
-- Only two of them (supporter_ticker, community_goal_ladder) have a
-- renderer in this slice -- the other 18 are configurable and cap-counted
-- from day one (so the cap is real for every future module, not just the
-- two built now) but are inert until a later slice ports their renderer.
--
-- CAP, LIVE-ONLY: app_private.tier_master_canvas_module_cap() mirrors
-- 0102's tier_goal_count_limit() exactly -- computed live against the
-- channel's current tier, never merged into channel_entitlement_versions.
-- Studio's cap is "all", represented as NULL (no ceiling), matching how
-- this schema already represents "no cap" for amountMaxPaise etc.
--
-- DURABLE CONFIGURATION, NEVER DESTROYED (§12.6, this task's §3): a module
-- row is created once and only ever toggled (`enabled`) or left alone by a
-- tier change. There is no delete path anywhere in this file. A downgrade
-- that pushes a module over the new, lower cap does not touch its row --
-- app_private.list_channel_master_canvas_modules() computes `active`/
-- `inactive_reason` live, every read, from current tier + creation-order
-- rank, exactly like support_goal_reached() computes 'reached' live rather
-- than storing it. The module stays viewable, editable (still toggleable)
-- and exportable (still a normal row a creator's data export can read).
--
-- ORDER: no authority states a module priority/position field, so
-- creation-time order is the tiebreak (oldest configured module keeps its
-- active slot on a downgrade) -- the same "configured but unset" posture
-- RT-02/RT-10 use for a value nothing states, applied here as "order by
-- the one timestamp that already exists" rather than inventing a rank
-- column with no stated meaning.

create table public.master_canvas_modules (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  module_key text not null check (module_key in (
    'support_theater', 'community_goal_ladder', 'tug_of_war_vote', 'boss_fight',
    'reaction_cloud', 'safe_soundboard_alert', 'supporter_ticker', 'challenge_board',
    'stream_mission_card', 'qr_smart_card', 'sponsor_card', 'moderator_status_card',
    'milestone_celebration', 'vertical_stream_layout', 'stream_health_widget',
    'lobby_status', 'giveaway_tournament_card', 'now_playing', 'chat', 'media_meme_queue'
  )),
  enabled boolean not null default true,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (channel_id, module_key)
);

create index master_canvas_modules_channel_idx on public.master_canvas_modules (channel_id);

alter table public.master_canvas_modules enable row level security;
revoke all on public.master_canvas_modules from public;
revoke all on public.master_canvas_modules from bsa_app;

-- §30.3's stated ladder. Unrecognised tier fails closed (raises), same
-- posture as tier_goal_count_limit -- an unresolvable cap must never be
-- silently read as "unlimited".
create or replace function app_private.tier_master_canvas_module_cap(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 2;
    when 'pro' then return 5;
    when 'creator' then return 12;
    when 'studio' then return null; -- "all" -- no ceiling
    else raise exception 'unrecognised tier for master canvas module entitlement: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.tier_master_canvas_module_cap(text) from public;
grant execute on function app_private.tier_master_canvas_module_cap(text) to bsa_app;

-- Owner/admin only. Creates a module row the first time a module key is
-- configured for a channel; every call after that only ever flips
-- `enabled` on the existing row -- there is no second insert and no
-- delete, so a module's history (created_at, and therefore its cap
-- priority) survives every future toggle.
create or replace function app_private.upsert_master_canvas_module(
  target_channel_id uuid,
  target_module_key text,
  target_enabled boolean
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  result_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s master canvas modules' using errcode = '42501';
  end if;

  if target_module_key is null or target_enabled is null then
    raise exception 'invalid master canvas module' using errcode = '22023';
  end if;

  insert into public.master_canvas_modules (id, channel_id, module_key, enabled, created_at, updated_at)
  values (gen_random_uuid(), target_channel_id, target_module_key, target_enabled, current_timestamp, current_timestamp)
  on conflict (channel_id, module_key) do update
    set enabled = excluded.enabled, updated_at = current_timestamp
  returning id into result_id;

  return result_id;
end
$$;

revoke execute on function app_private.upsert_master_canvas_module(uuid, text, boolean) from public;
grant execute on function app_private.upsert_master_canvas_module(uuid, text, boolean) to bsa_app;

-- Creator-facing read: any current channel member (owner through viewer,
-- same role set list_channel_goals already uses) sees every configured
-- module, its live `active` state, and -- when it is not active -- exactly
-- why: 'disabled' (the creator turned it off) or 'tier_module_cap' (§30.3's
-- ladder, computed live). A non-member sees zero rows.
create or replace function app_private.list_channel_master_canvas_modules(target_channel_id uuid)
returns table (
  module_key text, enabled boolean, active boolean, inactive_reason text,
  rank_order integer, created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with tiered as (
    select tier from public.channel_entitlement_versions
     where channel_id = target_channel_id
     order by version desc
     limit 1
  ),
  ranked as (
    -- row_number() is a pure window function -- FILTER only applies to
    -- aggregates -- so "rank only among enabled rows" is expressed as a
    -- partition instead: every row gets a rank within its own enabled/
    -- disabled partition, and only the enabled partition's rank is ever
    -- read (below).
    select module.module_key, module.enabled, module.created_at, module.updated_at,
           row_number() over (partition by module.enabled order by module.created_at asc) as rnk
      from public.master_canvas_modules module
     where module.channel_id = target_channel_id
  )
  select ranked.module_key, ranked.enabled,
         ranked.enabled and (
           (select app_private.tier_master_canvas_module_cap(tiered.tier) from tiered) is null
           or ranked.rnk <= (select app_private.tier_master_canvas_module_cap(tiered.tier) from tiered)
         ) as active,
         case
           when not ranked.enabled then 'disabled'
           when (select app_private.tier_master_canvas_module_cap(tiered.tier) from tiered) is not null
                and ranked.rnk > (select app_private.tier_master_canvas_module_cap(tiered.tier) from tiered) then 'tier_module_cap'
           else null
         end as inactive_reason,
         ranked.rnk::integer, ranked.created_at, ranked.updated_at
    from ranked
   where app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
   order by ranked.created_at asc
$$;

revoke execute on function app_private.list_channel_master_canvas_modules(uuid) from public;
grant execute on function app_private.list_channel_master_canvas_modules(uuid) to bsa_app;

-- Overlay-facing read (browser source): same token-fingerprint gate as
-- list_overlay_supporter_ticker/list_overlay_recent_tips. Returns ONLY
-- the module keys that are active right now -- the runtime uses this list
-- to decide which of its known renderers to mount; it never learns about
-- a disabled or over-cap module's existence, config or reason (that detail
-- is creator-facing only, via list_channel_master_canvas_modules above).
create or replace function app_private.list_overlay_master_canvas_modules(target_overlay_id uuid, target_token_fingerprint text)
returns table (module_key text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with session_channel as (
    select session.channel_id
      from public.overlay_sessions session
     where session.id = target_overlay_id
       and session.token_fingerprint = target_token_fingerprint
       and session.revoked_at is null
       and session.expires_at > current_timestamp
  ),
  tiered as (
    select entitlement.tier
      from public.channel_entitlement_versions entitlement
      join session_channel on session_channel.channel_id = entitlement.channel_id
     order by entitlement.version desc
     limit 1
  ),
  ranked as (
    -- Already filtered to enabled=true below, so every row reaching
    -- row_number() here shares one partition -- no FILTER needed (see the
    -- creator-facing function above for why FILTER itself is invalid on a
    -- pure window function like row_number()).
    select module.module_key,
           row_number() over (order by module.created_at asc) as rnk
      from public.master_canvas_modules module
      join session_channel on session_channel.channel_id = module.channel_id
     where module.enabled
  )
  select ranked.module_key
    from ranked
   where (select app_private.tier_master_canvas_module_cap(tiered.tier) from tiered) is null
      or ranked.rnk <= (select app_private.tier_master_canvas_module_cap(tiered.tier) from tiered)
   order by ranked.module_key
$$;

revoke execute on function app_private.list_overlay_master_canvas_modules(uuid, text) from public;
grant execute on function app_private.list_overlay_master_canvas_modules(uuid, text) to bsa_app;
