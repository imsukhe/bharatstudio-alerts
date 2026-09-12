-- L22: Curated sticker catalogue and safe media (see
-- bharatstudio-requirements/tasks/L22-stickers-and-safe-media.md and master
-- plan Part 6 L16 interaction-type row 3 / Part 7 L22 tier table).
--
-- THE CONSTRAINT THIS MIGRATION EXISTS TO ENFORCE: master plan 10.7 cut
-- "arbitrary viewer media upload" ("moderation and legal exposure with no
-- offsetting revenue") and the L20 capability table forbids "Arbitrary
-- HTML/CSS/JS" at every tier. A sticker is therefore either
-- BharatStudio-approved (this catalogue) or creator-approved (a creator
-- turning ON/OFF an entry already in this catalogue) — a viewer never
-- supplies the asset. There is no viewer-upload table, column, or function
-- anywhere in this migration.
--
-- REUSE, NOT A SECOND PIPELINE: storage shape (bytea + 2,000,000-byte cap +
-- security-definer boundary) and the identity/import shape (upsert-by-
-- external_key, content-hash skip) mirror 0106's
-- alert_template_catalogue_entries exactly, which itself mirrors 0077's
-- Lottie branding upload — "no second asset-scanning pipeline". Content
-- safety (rejecting embedded expressions, external non-data: refs,
-- javascript:/<script) is validated in TypeScript before
-- import_sticker_catalogue_entry is ever called — see
-- apps/api/src/domain/sticker-import-validation.ts, which wraps
-- apps/api/src/domain/template-import-validation.ts (itself a wrapper
-- around lottie-validation.ts) rather than writing a third structural
-- walker. This function re-validates size/shape/tier server-side anyway,
-- same defense-in-depth as 0077/0106.
--
-- ENTITLEMENT: sticker-library tier availability is gated LIVE off
-- channel_entitlement_versions.tier via app_private.sticker_tier_rank,
-- exactly the fail-closed per-feature rank function shape used by
-- template_tier_rank (0106) and tier_goal_count_limit (0102) — this is
-- NOT a ninth public entitlement dimension (the eight are closed, decision
-- 2); it is a hidden per-tier flag like lottieEnabled.
--
-- CREATOR CONTROL: channel_sticker_disables is presence-based — a row
-- means "this creator turned this catalogue entry off for their channel".
-- No row means enabled (subject to tier eligibility). Toggling is a single
-- insert/delete, so it is visible on the very next list/attach call — no
-- cache, no cleanup job, matching 0077/0106's live-gate philosophy.
--
-- TIP ATTRIBUTION BOUNDARY: the only path that creates a real Razorpay
-- order (apps/api/src/routes/public.ts's
-- POST /v1/public/channels/:handle/tips/orders) is owned by another lane
-- and out of bounds here — same wall 0105 documented for support-vote
-- payment tagging. That order-creation response and
-- GET /v1/public/tip-orders/:orderId/status already expose
-- payment_order_intents.id ("orderId") to the viewer as an unguessable
-- capability (0044). So a sticker selection is attached to that existing,
-- already-public intent id once its own status reaches 'paid' — this
-- migration only ever READS payment_order_intents (a read-only join, the
-- same category of dependency 0102/0105 use against payments/refunds), it
-- never writes to it, and it does not touch routes/public.ts.
--
-- ROLLBACK: every object here is new and additive. Nothing alters
-- payments, refunds, alert_events, payment_order_intents, channels, or any
-- existing migration (0090-0109 included). Disabling the sticker
-- interaction type removes it from the interaction menu without touching
-- tip/TTS-tip/other L16 interaction types. No production migration without
-- separate explicit approval, per the task's Definition gate.

-- =========================================================================
-- sticker_catalogue_entries: BharatStudio-approved catalogue. Identity key
-- is external_key (mirrors 0106's design_id rationale exactly) — the one
-- field a re-import commits to keeping stable.
-- =========================================================================
create table public.sticker_catalogue_entries (
  id uuid primary key,
  external_key text not null check (char_length(external_key) between 1 and 64),
  display_name text not null check (char_length(display_name) between 1 and 120),
  category text not null check (char_length(category) between 1 and 60),
  min_tier text not null check (min_tier in ('free', 'pro', 'creator', 'studio')),
  asset_bytes bytea not null,
  mime_type text not null check (mime_type = 'application/json'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (external_key),
  check (octet_length(asset_bytes) between 1 and 2000000)
);

alter table public.sticker_catalogue_entries enable row level security;
revoke all on public.sticker_catalogue_entries from public;
revoke all on public.sticker_catalogue_entries from bsa_app;

-- =========================================================================
-- channel_sticker_disables: presence = creator turned this entry off for
-- their own channel. No row = enabled (subject to tier eligibility).
-- =========================================================================
create table public.channel_sticker_disables (
  channel_id uuid not null references public.channels(id),
  sticker_id uuid not null references public.sticker_catalogue_entries(id),
  disabled_at timestamptz not null default current_timestamp,
  primary key (channel_id, sticker_id)
);

alter table public.channel_sticker_disables enable row level security;
revoke all on public.channel_sticker_disables from public;
revoke all on public.channel_sticker_disables from bsa_app;

-- =========================================================================
-- channel_sticker_selections: a viewer's sticker choice attached to one
-- already-existing tip order (see header). One sticker per order.
-- =========================================================================
create table public.channel_sticker_selections (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  order_id uuid not null references public.payment_order_intents(id),
  sticker_id uuid not null references public.sticker_catalogue_entries(id),
  created_at timestamptz not null default current_timestamp,
  unique (order_id)
);

alter table public.channel_sticker_selections enable row level security;
revoke all on public.channel_sticker_selections from public;
revoke all on public.channel_sticker_selections from bsa_app;

-- Same fail-closed shape as template_tier_rank (0106) and
-- tier_custom_branding_allowed (0077): a known tier resolves
-- deterministically, an unrecognised one raises rather than silently
-- defaulting.
create or replace function app_private.sticker_tier_rank(target_tier text)
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
    else raise exception 'unrecognised tier for sticker entitlement: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.sticker_tier_rank(text) from public;
grant execute on function app_private.sticker_tier_rank(text) to bsa_app;

-- Import/seed boundary. Upsert-by-external_key. Content-safety validation
-- (expr/script/external-ref rejection) has already run in TypeScript (see
-- header) before this is ever called; this function re-validates
-- size/shape/tier itself rather than trusting the caller, exactly as
-- import_template_catalogue_entry (0106) and store_channel_lottie_asset
-- (0077) do not trust their own API layers either.
create or replace function app_private.import_sticker_catalogue_entry(
  target_external_key text,
  target_display_name text,
  target_category text,
  target_min_tier text,
  target_asset_bytes bytea
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
    raise exception 'invalid sticker external_key' using errcode = '22023';
  end if;
  if target_display_name is null or char_length(target_display_name) not between 1 and 120 then
    raise exception 'invalid sticker display_name' using errcode = '22023';
  end if;
  if target_category is null or char_length(target_category) not between 1 and 60 then
    raise exception 'invalid sticker category' using errcode = '22023';
  end if;
  perform app_private.sticker_tier_rank(target_min_tier);
  if target_asset_bytes is null or octet_length(target_asset_bytes) not between 1 and 2000000 then
    raise exception 'invalid sticker asset' using errcode = '22023';
  end if;

  new_hash := encode(sha256(target_asset_bytes), 'hex');

  select id, content_sha256, display_name, category, min_tier
    into existing
    from public.sticker_catalogue_entries
   where external_key = target_external_key;

  if not found then
    new_id := gen_random_uuid();
    insert into public.sticker_catalogue_entries
      (id, external_key, display_name, category, min_tier, asset_bytes, mime_type, content_sha256, imported_at, updated_at)
    values
      (new_id, target_external_key, target_display_name, target_category, target_min_tier, target_asset_bytes, 'application/json', new_hash, current_timestamp, current_timestamp);
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

  update public.sticker_catalogue_entries
     set display_name = target_display_name,
         category = target_category,
         min_tier = target_min_tier,
         asset_bytes = target_asset_bytes,
         content_sha256 = new_hash,
         updated_at = current_timestamp
   where id = existing.id;

  return query select 'updated'::text, existing.id;
end
$$;

revoke execute on function app_private.import_sticker_catalogue_entry(text, text, text, text, bytea) from public;
grant execute on function app_private.import_sticker_catalogue_entry(text, text, text, text, bytea) to bsa_app;

-- Creator-facing read: every catalogue entry at or below the channel's
-- CURRENT tier, plus whether this channel has disabled it. Metadata only,
-- no asset bytes — mirrors list_templates_for_channel/
-- list_channel_lottie_assets' separation of owner-facing list from
-- byte-serving.
create or replace function app_private.list_stickers_for_channel(
  target_channel_id uuid
)
returns table (id uuid, external_key text, display_name text, category text, min_tier text, byte_size integer, enabled boolean, updated_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select entry.id, entry.external_key, entry.display_name, entry.category, entry.min_tier,
         octet_length(entry.asset_bytes)::integer, (disable.sticker_id is null), entry.updated_at
    from public.sticker_catalogue_entries entry
    join public.channel_entitlement_versions entitlement
      on entitlement.channel_id = target_channel_id
     and entitlement.version = (
       select max(version) from public.channel_entitlement_versions where channel_id = target_channel_id
     )
    left join public.channel_sticker_disables disable
      on disable.channel_id = target_channel_id and disable.sticker_id = entry.id
   where app_private.can_access_channel(target_channel_id)
     and app_private.sticker_tier_rank(entry.min_tier) <= app_private.sticker_tier_rank(entitlement.tier)
   order by entry.category, entry.external_key
$$;

revoke execute on function app_private.list_stickers_for_channel(uuid) from public;
grant execute on function app_private.list_stickers_for_channel(uuid) to bsa_app;

-- Viewer-facing public read: same tier filter, minus disabled entries,
-- no auth/role check (the tip page is unauthenticated) — matches the
-- no-sensitive-fields shape of get_public_payment_status (0044) /
-- PublicChannel: no bytes, no internal ids beyond the catalogue's own.
create or replace function app_private.list_public_stickers_for_channel(
  target_channel_id uuid
)
returns table (id uuid, display_name text, category text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select entry.id, entry.display_name, entry.category
    from public.sticker_catalogue_entries entry
    join public.channel_entitlement_versions entitlement
      on entitlement.channel_id = target_channel_id
     and entitlement.version = (
       select max(version) from public.channel_entitlement_versions where channel_id = target_channel_id
     )
    left join public.channel_sticker_disables disable
      on disable.channel_id = target_channel_id and disable.sticker_id = entry.id
   where app_private.sticker_tier_rank(entry.min_tier) <= app_private.sticker_tier_rank(entitlement.tier)
     and disable.sticker_id is null
   order by entry.category, entry.display_name
$$;

revoke execute on function app_private.list_public_stickers_for_channel(uuid) from public;
grant execute on function app_private.list_public_stickers_for_channel(uuid) to bsa_app;

-- Creator enable/disable. Owner/admin only. A single insert/delete, so the
-- effect is live on the very next list_stickers_for_channel/
-- list_public_stickers_for_channel/attach_sticker_to_tip call — no cache,
-- no separate propagation step.
create or replace function app_private.set_channel_sticker_enabled(
  target_channel_id uuid,
  target_sticker_id uuid,
  target_enabled boolean
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s stickers' using errcode = '42501';
  end if;

  if not exists (select 1 from public.sticker_catalogue_entries where id = target_sticker_id) then
    raise exception 'unknown sticker' using errcode = '22023';
  end if;

  if target_enabled then
    delete from public.channel_sticker_disables
     where channel_id = target_channel_id and sticker_id = target_sticker_id;
  else
    insert into public.channel_sticker_disables (channel_id, sticker_id, disabled_at)
    values (target_channel_id, target_sticker_id, current_timestamp)
    on conflict (channel_id, sticker_id) do nothing;
  end if;

  return target_enabled;
end
$$;

revoke execute on function app_private.set_channel_sticker_enabled(uuid, uuid, boolean) from public;
grant execute on function app_private.set_channel_sticker_enabled(uuid, uuid, boolean) to bsa_app;

-- Attach a sticker to an already-existing, already-paid tip order. Never
-- trusts the client's sticker choice: re-checks existence, tier
-- eligibility and the live disabled set inside this one function, and
-- rejects (does not silently drop) anything that fails. See header for why
-- this reads payment_order_intents rather than creating a payment.
create or replace function app_private.attach_sticker_to_tip(
  target_channel_id uuid,
  target_order_id uuid,
  target_sticker_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  intent record;
  entitlement_tier text;
  is_disabled boolean;
  sticker record;
  new_id uuid;
begin
  select id, channel_id, status
    into intent
    from public.payment_order_intents
   where id = target_order_id;

  if not found or intent.channel_id <> target_channel_id then
    raise exception 'unknown tip order' using errcode = '22023';
  end if;
  if intent.status <> 'paid' then
    raise exception 'tip order is not yet paid' using errcode = '42501';
  end if;

  select id, min_tier into sticker
    from public.sticker_catalogue_entries
   where id = target_sticker_id;
  if not found then
    raise exception 'unknown sticker' using errcode = '22023';
  end if;

  select tier into entitlement_tier
    from public.channel_entitlement_versions
   where channel_id = target_channel_id
   order by version desc
   limit 1;
  if entitlement_tier is null or app_private.sticker_tier_rank(sticker.min_tier) > app_private.sticker_tier_rank(entitlement_tier) then
    raise exception 'sticker not available at this channel''s tier' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.channel_sticker_disables
     where channel_id = target_channel_id and sticker_id = target_sticker_id
  ) into is_disabled;
  if is_disabled then
    raise exception 'sticker is disabled for this channel' using errcode = '42501';
  end if;

  if exists (select 1 from public.channel_sticker_selections where order_id = target_order_id) then
    raise exception 'a sticker is already attached to this tip' using errcode = '22023';
  end if;

  new_id := gen_random_uuid();
  insert into public.channel_sticker_selections (id, channel_id, order_id, sticker_id, created_at)
  values (new_id, target_channel_id, target_order_id, target_sticker_id, current_timestamp);

  return new_id;
end
$$;

revoke execute on function app_private.attach_sticker_to_tip(uuid, uuid, uuid) from public;
grant execute on function app_private.attach_sticker_to_tip(uuid, uuid, uuid) to bsa_app;
