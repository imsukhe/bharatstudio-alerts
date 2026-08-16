-- L03: Studio-tier Lottie/custom branding upload — v1 scope addendum item.
--
-- Design authority: bharatstudio-requirements/active/launch/
-- 01_MASTER_RELEASE_AUTHORITY.md, "Lottie/custom branding storage
-- mechanism addendum — 2026-08-16". Storage mirrors alert_tts_audio
-- (0067) exactly: zero-grant bytea table, RLS enabled, all access through
-- security-definer functions, the same 2,000,000-byte cap already
-- reviewed for TTS audio. Upload slots are keyed by displayStyle (the
-- existing six-value bracket enum), not an alert-type entity — this
-- schema has none. The Studio-tier gate is computed LIVE from
-- channel_entitlement_versions.tier at both upload and serve time —
-- deliberately not cached as a new entitlement-values key, so a
-- downgrade takes an uploaded animation out of rendering on the very
-- next overlay load with no separate cleanup job.

create table public.channel_lottie_assets (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  display_style text not null check (display_style in (
    'small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration'
  )),
  lottie_bytes bytea not null,
  mime_type text not null check (mime_type = 'application/json'),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (channel_id, display_style),
  check (octet_length(lottie_bytes) between 1 and 2000000)
);

alter table public.channel_lottie_assets enable row level security;
revoke all on public.channel_lottie_assets from public;
revoke all on public.channel_lottie_assets from bsa_app;

-- Mirrors tier_queue_count's exact fail-closed shape (0070): a known
-- tier resolves deterministically, an unrecognised one raises rather
-- than silently defaulting to either true or false.
create or replace function app_private.tier_custom_branding_allowed(target_tier text)
returns boolean
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return false;
    when 'pro' then return false;
    when 'creator' then return false;
    when 'studio' then return true;
    else raise exception 'unrecognised tier for custom branding entitlement: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.tier_custom_branding_allowed(text) from public;
grant execute on function app_private.tier_custom_branding_allowed(text) to bsa_app;

-- Upload/replace. Owner/admin only, Studio-tier only (checked live
-- against the channel's current entitlement version, not a cached
-- flag). Content validation beyond size/JSON-validity — rejecting
-- embedded expressions and external asset references — is deliberately
-- done at the API layer (apps/api/src/domain/lottie-validation.ts)
-- before this function is ever called, because it needs to inspect
-- parsed JSON structure that is easier to walk correctly in TypeScript
-- than in a SQL function; this function is the storage/authorization
-- boundary, not the content-safety boundary.
create or replace function app_private.store_channel_lottie_asset(
  target_channel_id uuid,
  target_display_style text,
  target_lottie_bytes bytea
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_tier text;
  artifact_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s branding' using errcode = '42501';
  end if;

  if target_display_style not in ('small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration')
     or target_lottie_bytes is null
     or octet_length(target_lottie_bytes) not between 1 and 2000000 then
    raise exception 'invalid Lottie asset' using errcode = '22023';
  end if;

  select tier into current_tier
    from public.channel_entitlement_versions
   where channel_id = target_channel_id
   order by version desc
   limit 1;

  if current_tier is null or not app_private.tier_custom_branding_allowed(current_tier) then
    raise exception 'custom branding requires the Studio tier' using errcode = '42501';
  end if;

  insert into public.channel_lottie_assets (id, channel_id, display_style, lottie_bytes, mime_type, created_at, updated_at)
  values (gen_random_uuid(), target_channel_id, target_display_style, target_lottie_bytes, 'application/json', current_timestamp, current_timestamp)
  on conflict (channel_id, display_style) do update
    set lottie_bytes = excluded.lottie_bytes,
        updated_at = current_timestamp
  returning id into artifact_id;

  return artifact_id;
end
$$;

revoke execute on function app_private.store_channel_lottie_asset(uuid, text, bytea) from public;
grant execute on function app_private.store_channel_lottie_asset(uuid, text, bytea) to bsa_app;

create or replace function app_private.delete_channel_lottie_asset(
  target_channel_id uuid,
  target_display_style text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  deleted_count integer;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s branding' using errcode = '42501';
  end if;

  delete from public.channel_lottie_assets
   where channel_id = target_channel_id
     and display_style = target_display_style;
  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end
$$;

revoke execute on function app_private.delete_channel_lottie_asset(uuid, text) from public;
grant execute on function app_private.delete_channel_lottie_asset(uuid, text) to bsa_app;

-- Owner-facing read for the settings/dashboard UI: which slots are
-- filled, how large, when last updated. Never returns the bytes
-- themselves — that only ever happens through the overlay-scoped serve
-- path below, matching alert_tts_audio's separation of the owner-facing
-- write path from the overlay-facing read path.
create or replace function app_private.list_channel_lottie_assets(
  target_channel_id uuid
)
returns table (display_style text, artifact_id uuid, byte_size integer, updated_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select asset.display_style, asset.id, octet_length(asset.lottie_bytes)::integer, asset.updated_at
    from public.channel_lottie_assets asset
   where asset.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
   order by asset.display_style
$$;

revoke execute on function app_private.list_channel_lottie_assets(uuid) from public;
grant execute on function app_private.list_channel_lottie_assets(uuid) to bsa_app;

-- Overlay bootstrap read: the set of (displayStyle -> artifactId) this
-- session's channel currently has available, gated live on the
-- channel's CURRENT tier (not tier-at-upload-time) so a downgrade takes
-- effect on the next overlay load. Mirrors get_overlay_tts_audio's
-- session-scoping (0067): token fingerprint, not-revoked, not-expired.
create or replace function app_private.list_overlay_lottie_assets(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (display_style text, artifact_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select asset.display_style, asset.id
    from public.overlay_sessions session
    join public.channel_entitlement_versions entitlement
      on entitlement.channel_id = session.channel_id
     and entitlement.version = (
       select max(version) from public.channel_entitlement_versions where channel_id = session.channel_id
     )
    join public.channel_lottie_assets asset on asset.channel_id = session.channel_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and app_private.tier_custom_branding_allowed(entitlement.tier)
$$;

-- The byte-serving path an individual overlay-lottie route fetches by
-- artifact id. Same tier-gate and session-scoping as the list above —
-- a session cannot be given a list without the gate and then bypass it
-- by requesting an id directly, since this function re-checks it too.
create or replace function app_private.get_overlay_lottie_asset(
  target_overlay_id uuid,
  target_token_fingerprint text,
  target_artifact_id uuid
)
returns table (lottie_bytes bytea, mime_type text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select asset.lottie_bytes, asset.mime_type
    from public.overlay_sessions session
    join public.channel_entitlement_versions entitlement
      on entitlement.channel_id = session.channel_id
     and entitlement.version = (
       select max(version) from public.channel_entitlement_versions where channel_id = session.channel_id
     )
    join public.channel_lottie_assets asset on asset.channel_id = session.channel_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and asset.id = target_artifact_id
     and app_private.tier_custom_branding_allowed(entitlement.tier)
$$;

revoke execute on function app_private.list_overlay_lottie_assets(uuid, text) from public;
revoke execute on function app_private.get_overlay_lottie_asset(uuid, text, uuid) from public;
grant execute on function app_private.list_overlay_lottie_assets(uuid, text) to bsa_app;
grant execute on function app_private.get_overlay_lottie_asset(uuid, text, uuid) to bsa_app;
