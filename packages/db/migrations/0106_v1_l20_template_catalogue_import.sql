-- L20: Alert Studio template-catalogue import pipeline (packages/db owner:
-- L20 lane; see bharatstudio-requirements/tasks/L20-alert-studio-depth.md
-- and BharatStudio-MASTER-PLAN.md Part 6/7 decision 3, 2026-09-02). The
-- 600-design catalogue already exists (contracts/template-catalogue.json,
-- catalogueId "visuals-v6") and is imported, not rebuilt. This migration
-- is the catalogue table plus the import/read functions the pipeline in
-- scripts/template-import/** and apps/api/src/routes/templates.ts call.
--
-- Storage shape and content-safety split mirror 0077 (Lottie branding
-- upload) exactly on purpose — "no second asset-scanning pipeline":
-- a bytea column with the same 2,000,000-byte cap, a security-definer
-- function as the storage/authorization boundary, and the structural
-- content-safety walk (embedded expressions, external refs, inline
-- script) done in TypeScript before this function is ever called — see
-- apps/api/src/domain/template-import-validation.ts, which wraps the
-- existing apps/api/src/domain/lottie-validation.ts validator rather than
-- duplicating it, because the render document format this migration
-- accepts is the same Lottie-shaped JSON (`v` + `layers`) that 0077
-- already validates and this codebase already knows how to render.
--
-- IDENTITY KEY: external_key, e.g. "BSA-001" — the catalogue's own
-- design_id (contracts/template-catalogue.json's designIdPattern
-- "BSA-{001..600}"). This is the one field the source catalogue commits
-- to keeping stable across every future edit of a design's artwork,
-- category or tier availability, so it is the only correct de-duplication
-- key: a re-import of "BSA-041" must always land on the same catalogue
-- row no matter how many times its content_sha256 changes, and two
-- different designs must never collide even if their metadata (name,
-- category) happens to match at some point. A content hash alone cannot
-- serve as the identity key — an intentional re-render of the same design
-- (an art pass) is a legitimate content change to an existing row, not a
-- new template; deriving identity from bytes would fork it instead.

create table public.alert_template_catalogue_entries (
  id uuid primary key,
  external_key text not null check (char_length(external_key) between 1 and 64),
  display_name text not null check (char_length(display_name) between 1 and 120),
  category text not null check (char_length(category) between 1 and 60),
  min_tier text not null check (min_tier in ('free', 'pro', 'creator', 'studio')),
  render_bytes bytea not null,
  mime_type text not null check (mime_type = 'application/json'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (external_key),
  check (octet_length(render_bytes) between 1 and 2000000)
);

alter table public.alert_template_catalogue_entries enable row level security;
revoke all on public.alert_template_catalogue_entries from public;
revoke all on public.alert_template_catalogue_entries from bsa_app;

-- Same fail-closed shape as tier_custom_branding_allowed (0077) and
-- tier_goal_count_limit (0102): a known tier resolves deterministically,
-- an unrecognised one raises rather than silently defaulting.
create or replace function app_private.template_tier_rank(target_tier text)
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
    else raise exception 'unrecognised tier for template entitlement: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.template_tier_rank(text) from public;
grant execute on function app_private.template_tier_rank(text) to bsa_app;

-- Import boundary. Upsert-by-external_key, keyed on the identity above.
-- Called once per manifest entry by scripts/template-import/**, which has
-- already run content-safety validation (see comment above) — this
-- function re-validates size/shape/tier itself rather than trusting the
-- caller, exactly as store_channel_lottie_asset does not trust the API
-- layer's own checks. Returns which of created/updated/skipped happened
-- so the pipeline can report an accurate summary; a "skipped" outcome
-- performs no write at all (updated_at does not move) so re-running an
-- unchanged manifest is a true no-op, not just a no-visible-effect upsert.
create or replace function app_private.import_template_catalogue_entry(
  target_external_key text,
  target_display_name text,
  target_category text,
  target_min_tier text,
  target_render_bytes bytea
)
returns table (outcome text, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_hash text;
  existing record;
  new_id uuid;
begin
  if target_external_key is null or char_length(target_external_key) not between 1 and 64 then
    raise exception 'invalid template external_key' using errcode = '22023';
  end if;
  if target_display_name is null or char_length(target_display_name) not between 1 and 120 then
    raise exception 'invalid template display_name' using errcode = '22023';
  end if;
  if target_category is null or char_length(target_category) not between 1 and 60 then
    raise exception 'invalid template category' using errcode = '22023';
  end if;
  -- resolves or raises on an unrecognised tier — no separate branch needed.
  perform app_private.template_tier_rank(target_min_tier);
  if target_render_bytes is null or octet_length(target_render_bytes) not between 1 and 2000000 then
    raise exception 'invalid template render document' using errcode = '22023';
  end if;

  new_hash := encode(sha256(target_render_bytes), 'hex');

  select id, content_sha256, display_name, category, min_tier
    into existing
    from public.alert_template_catalogue_entries
   where external_key = target_external_key;

  if not found then
    new_id := gen_random_uuid();
    insert into public.alert_template_catalogue_entries
      (id, external_key, display_name, category, min_tier, render_bytes, mime_type, content_sha256, imported_at, updated_at)
    values
      (new_id, target_external_key, target_display_name, target_category, target_min_tier, target_render_bytes, 'application/json', new_hash, current_timestamp, current_timestamp);
    return query select 'created'::text, new_id;
    return;
  end if;

  if existing.content_sha256 = new_hash
     and existing.display_name = target_display_name
     and existing.category = target_category
     and existing.min_tier = target_min_tier then
    return query select 'skipped'::text, existing.id;
    return;
  end if;

  update public.alert_template_catalogue_entries
     set display_name = target_display_name,
         category = target_category,
         min_tier = target_min_tier,
         render_bytes = target_render_bytes,
         content_sha256 = new_hash,
         updated_at = current_timestamp
   where id = existing.id;

  return query select 'updated'::text, existing.id;
end
$$;

revoke execute on function app_private.import_template_catalogue_entry(text, text, text, text, bytea) from public;
grant execute on function app_private.import_template_catalogue_entry(text, text, text, text, bytea) to bsa_app;

-- Creator-facing read: templates available to a channel, live-gated on
-- its CURRENT tier (never merged into channel_entitlement_versions.values
-- — same "not a ninth public entitlement dimension" rule as lottieEnabled
-- (0077) and tier_goal_count_limit (0102)). Metadata only, no render
-- bytes — mirrors list_channel_lottie_assets' separation of the
-- owner-facing list from the byte-serving path.
create or replace function app_private.list_templates_for_channel(
  target_channel_id uuid
)
returns table (id uuid, external_key text, display_name text, category text, min_tier text, byte_size integer, updated_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select entry.id, entry.external_key, entry.display_name, entry.category, entry.min_tier,
         octet_length(entry.render_bytes)::integer, entry.updated_at
    from public.alert_template_catalogue_entries entry
    join public.channel_entitlement_versions entitlement
      on entitlement.channel_id = target_channel_id
     and entitlement.version = (
       select max(version) from public.channel_entitlement_versions where channel_id = target_channel_id
     )
   where app_private.can_access_channel(target_channel_id)
     and app_private.template_tier_rank(entry.min_tier) <= app_private.template_tier_rank(entitlement.tier)
   order by entry.category, entry.external_key
$$;

revoke execute on function app_private.list_templates_for_channel(uuid) from public;
grant execute on function app_private.list_templates_for_channel(uuid) to bsa_app;
