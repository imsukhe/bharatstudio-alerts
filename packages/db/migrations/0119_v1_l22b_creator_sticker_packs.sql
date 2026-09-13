-- L22 gap-fill: creator-approved sticker packs (see
-- bharatstudio-requirements/tasks/L22-stickers-and-safe-media.md, the
-- "Creator pack" row of the master plan's L22 tier table, and the
-- 2026-09-08 reconciliation note on migration 0110, which explicitly left
-- creator packs, tier pack quotas, scan-plus-attest and Studio review
-- open). This migration adds ONLY that gap. It does not touch
-- sticker_catalogue_entries, channel_sticker_disables,
-- channel_sticker_selections, or any function 0110 defined — every object
-- here is new and additive, per the task's rollback rule.
--
-- THE BOUNDARY THIS MIGRATION EXISTS TO ENFORCE (unchanged from 0110): a
-- creator pack sticker is CREATOR-supplied, never VIEWER-supplied. The
-- upload path below is reachable only by a channel's own owner/admin
-- (app_private.has_channel_role), exactly like set_channel_sticker_enabled
-- (0110) and store_channel_lottie_asset (0077). There is still no table,
-- column, or function anywhere that accepts an asset from an
-- unauthenticated viewer or a non-owner/admin channel member.
--
-- REUSE, NOT A SECOND PIPELINE: storage shape (bytea + 2,000,000-byte cap,
-- same as 0077/0106/0110) and the size/shape re-check inside this
-- migration's own functions mirror 0110 exactly. Content-safety
-- (expr/script/external-ref rejection) still happens in TypeScript before
-- import_creator_pack_sticker is ever called — see
-- apps/api/src/domain/sticker-creator-pack-validation.ts, which routes
-- through the new apps/api/src/domain/asset-scan-pipeline.ts shared
-- entry point (itself a named wrapper around the one structural walker,
-- template-import-validation.ts's validateTemplateManifestEntry ->
-- lottie-validation.ts) rather than a fourth structural walker.
--
-- TIER QUOTAS: the master plan's L22 table gives only qualitative labels
-- ("Pro small, Creator limited, Studio larger; none at Free"), no exact
-- counts. In the absence of a specified number this migration picks a
-- concrete, strictly-increasing ladder (0 / 10 / 25 / 50) inside
-- app_private.creator_pack_tier_limit, in the same fail-closed shape as
-- app_private.tier_moderator_seat_limit (0104, which DOES have plan
-- numbers: 0/0/2/5). These specific counts (10/25/50) are an
-- implementation choice, not a plan citation — flagged as such for
-- product sign-off, exactly like the "OWNER unassigned" definition gate
-- this task file already carries.
--
-- MODERATION LADDER (master plan L22 row: "Moderation | Catalogue |
-- Catalogue | Scan + attest | Review workflow"): Free/Pro have no
-- moderation column of their own here because Free has no creator pack at
-- all (limit 0) and Pro's pack, like the platform catalogue, only ever
-- gets the structural scan (no attestation prompt). Creator tier requires
-- the caller to pass creator_attested = true (the creator affirmatively
-- claims the rights to upload this asset) or the upload is rejected.
-- Studio additionally lands every new pack entry in status =
-- 'pending_review' rather than 'active' — invisible to every viewer/
-- creator listing function below until
-- app_private.review_creator_pack_sticker flips it, which is the review
-- workflow's DB primitive. There is no HTTP route calling that function
-- yet (no platform-staff role/route exists anywhere in this codebase to
-- gate it at the API layer) — see apps/api/src/routes/stickers.ts's
-- header comment and this task's "Remaining open" note for what a
-- platform-admin tool still needs.
create table public.creator_sticker_packs (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  display_name text not null check (char_length(display_name) between 1 and 120),
  category text not null check (char_length(category) between 1 and 60),
  asset_bytes bytea not null,
  mime_type text not null check (mime_type = 'application/json'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  creator_attested boolean not null default false,
  status text not null check (status in ('active', 'pending_review')),
  enabled boolean not null default true,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  check (octet_length(asset_bytes) between 1 and 2000000)
);

create index creator_sticker_packs_channel_order_idx
  on public.creator_sticker_packs (channel_id, created_at, id);

alter table public.creator_sticker_packs enable row level security;
revoke all on public.creator_sticker_packs from public;
revoke all on public.creator_sticker_packs from bsa_app;

-- A viewer's creator-pack sticker choice attached to one already-existing
-- tip order (same shape and same read-only relationship to
-- payment_order_intents as channel_sticker_selections, 0110). Kept as its
-- own table, independent of channel_sticker_selections, because 0110's
-- table and functions cannot be edited by this migration — see header.
-- Coexistence, not shared mutual exclusion: a tip may carry a catalogue
-- selection, a creator-pack selection, both independently, or neither;
-- nothing here disables or shadows 0110's own one-per-order uniqueness.
create table public.channel_creator_pack_selections (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  order_id uuid not null references public.payment_order_intents(id),
  pack_sticker_id uuid not null references public.creator_sticker_packs(id),
  created_at timestamptz not null default current_timestamp,
  unique (order_id)
);

alter table public.channel_creator_pack_selections enable row level security;
revoke all on public.channel_creator_pack_selections from public;
revoke all on public.channel_creator_pack_selections from bsa_app;

-- Fail-closed tier -> pack-size-limit ladder. See header for why these
-- three numbers (10/25/50) are an implementation choice, not a plan
-- citation; the shape (unrecognised tier raises) matches
-- sticker_tier_rank (0110) and tier_moderator_seat_limit (0104) exactly.
create or replace function app_private.creator_pack_tier_limit(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 0;
    when 'pro' then return 10;
    when 'creator' then return 25;
    when 'studio' then return 50;
    else raise exception 'unrecognised tier for creator-pack entitlement: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.creator_pack_tier_limit(text) from public;
grant execute on function app_private.creator_pack_tier_limit(text) to bsa_app;

-- Upload boundary. Owner/admin only. Content-safety validation has
-- already run in TypeScript (see header) before this is ever called; this
-- function re-validates size/shape/tier/quota/attestation itself rather
-- than trusting the caller, same defense-in-depth as
-- import_sticker_catalogue_entry (0110). Enforces the tier's pack-size
-- limit as a hard boundary (the next-item-over-limit case is rejected,
-- not silently truncated) and the Creator-tier attestation requirement.
-- A Studio upload is stored but starts non-visible (status =
-- 'pending_review') until reviewed.
create or replace function app_private.import_creator_pack_sticker(
  target_channel_id uuid,
  target_display_name text,
  target_category text,
  target_asset_bytes bytea,
  target_creator_attested boolean
)
returns table (outcome text, entry_id uuid, status text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_tier text;
  pack_limit integer;
  current_count integer;
  new_hash text;
  new_id uuid;
  new_status text;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s creator pack' using errcode = '42501';
  end if;

  if target_display_name is null or char_length(target_display_name) not between 1 and 120 then
    raise exception 'invalid creator-pack display_name' using errcode = '22023';
  end if;
  if target_category is null or char_length(target_category) not between 1 and 60 then
    raise exception 'invalid creator-pack category' using errcode = '22023';
  end if;
  if target_asset_bytes is null or octet_length(target_asset_bytes) not between 1 and 2000000 then
    raise exception 'invalid creator-pack asset' using errcode = '22023';
  end if;

  select tier into current_tier
    from public.channel_entitlement_versions
   where channel_id = target_channel_id
   order by version desc
   limit 1;
  if current_tier is null then
    raise exception 'unknown channel entitlement' using errcode = '22023';
  end if;

  pack_limit := app_private.creator_pack_tier_limit(current_tier);
  if pack_limit = 0 then
    raise exception 'creator packs are not available at this channel''s tier' using errcode = '42501';
  end if;

  if current_tier in ('creator', 'studio') and coalesce(target_creator_attested, false) is not true then
    raise exception 'creator attestation is required to upload a pack sticker at this tier' using errcode = '42501';
  end if;

  select count(*) into current_count
    from public.creator_sticker_packs
   where channel_id = target_channel_id;
  if current_count >= pack_limit then
    raise exception 'creator pack limit reached for this channel''s tier' using errcode = '42501';
  end if;

  new_hash := encode(sha256(target_asset_bytes), 'hex');
  new_status := case when current_tier = 'studio' then 'pending_review' else 'active' end;
  new_id := gen_random_uuid();

  insert into public.creator_sticker_packs
    (id, channel_id, display_name, category, asset_bytes, mime_type, content_sha256, creator_attested, status, enabled, created_at, updated_at)
  values
    (new_id, target_channel_id, target_display_name, target_category, target_asset_bytes, 'application/json', new_hash, coalesce(target_creator_attested, false), new_status, true, current_timestamp, current_timestamp);

  return query select 'created'::text, new_id, new_status;
end
$$;

revoke execute on function app_private.import_creator_pack_sticker(uuid, text, text, bytea, boolean) from public;
grant execute on function app_private.import_creator_pack_sticker(uuid, text, text, bytea, boolean) to bsa_app;

-- Creator-facing read: metadata only (no bytes), every pack entry this
-- channel owns regardless of status, so an owner can see a
-- 'pending_review' Studio upload sitting in review. Mirrors
-- list_stickers_for_channel's owner-facing shape.
create or replace function app_private.list_creator_pack_for_channel(
  target_channel_id uuid
)
returns table (id uuid, display_name text, category text, byte_size integer, enabled boolean, status text, creator_attested boolean, updated_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select pack.id, pack.display_name, pack.category, octet_length(pack.asset_bytes)::integer,
         pack.enabled, pack.status, pack.creator_attested, pack.updated_at
    from public.creator_sticker_packs pack
   where app_private.can_access_channel(target_channel_id)
     and pack.channel_id = target_channel_id
   order by pack.created_at, pack.id
$$;

revoke execute on function app_private.list_creator_pack_for_channel(uuid) from public;
grant execute on function app_private.list_creator_pack_for_channel(uuid) to bsa_app;

-- Viewer-facing public read: enabled + reviewed ('active') entries only,
-- AND ranked to the channel's CURRENT tier limit (oldest-first) so a tier
-- downgrade after upload shrinks live eligibility immediately without
-- deleting any row — same live-gate philosophy as 0110's
-- list_public_stickers_for_channel, applied to a quota instead of a
-- boolean disable.
create or replace function app_private.list_public_creator_pack_for_channel(
  target_channel_id uuid
)
returns table (id uuid, display_name text, category text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with entitlement as (
    select tier from public.channel_entitlement_versions
     where channel_id = target_channel_id
     order by version desc
     limit 1
  ),
  ranked as (
    select pack.id, pack.display_name, pack.category,
           row_number() over (order by pack.created_at, pack.id) as rn
      from public.creator_sticker_packs pack
     where pack.channel_id = target_channel_id
       and pack.enabled
       and pack.status = 'active'
  )
  select ranked.id, ranked.display_name, ranked.category
    from ranked, entitlement
   where ranked.rn <= app_private.creator_pack_tier_limit(entitlement.tier)
   order by ranked.display_name
$$;

revoke execute on function app_private.list_public_creator_pack_for_channel(uuid) from public;
grant execute on function app_private.list_public_creator_pack_for_channel(uuid) to bsa_app;

-- Creator enable/disable. Owner/admin only. A single update, live on the
-- very next list_public_creator_pack_for_channel/
-- attach_creator_pack_sticker_to_tip call.
create or replace function app_private.set_creator_pack_sticker_enabled(
  target_channel_id uuid,
  target_pack_sticker_id uuid,
  target_enabled boolean
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  updated_count integer;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s creator pack' using errcode = '42501';
  end if;

  update public.creator_sticker_packs
     set enabled = target_enabled, updated_at = current_timestamp
   where id = target_pack_sticker_id and channel_id = target_channel_id;
  get diagnostics updated_count = row_count;
  if updated_count = 0 then
    raise exception 'unknown creator-pack sticker' using errcode = '22023';
  end if;

  return target_enabled;
end
$$;

revoke execute on function app_private.set_creator_pack_sticker_enabled(uuid, uuid, boolean) from public;
grant execute on function app_private.set_creator_pack_sticker_enabled(uuid, uuid, boolean) to bsa_app;

-- Platform-side review primitive for the Studio "review workflow" row.
-- No HTTP route calls this today (see apps/api/src/routes/stickers.ts and
-- this task's "Remaining open" note) — there is no platform-staff
-- role/route anywhere in this codebase yet to gate it at the API layer.
-- It exists so the DB-level invariant (a Studio upload cannot become
-- viewer-visible without this call) is real and testable now, independent
-- of when that admin surface is built.
create or replace function app_private.review_creator_pack_sticker(
  target_pack_sticker_id uuid,
  target_approved boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_status text;
  updated_count integer;
begin
  new_status := case when target_approved then 'active' else 'pending_review' end;
  update public.creator_sticker_packs
     set status = new_status, updated_at = current_timestamp
   where id = target_pack_sticker_id and status = 'pending_review';
  get diagnostics updated_count = row_count;
  if updated_count = 0 then
    raise exception 'no pending-review creator-pack sticker with that id' using errcode = '22023';
  end if;
  return new_status;
end
$$;

revoke execute on function app_private.review_creator_pack_sticker(uuid, boolean) from public;
grant execute on function app_private.review_creator_pack_sticker(uuid, boolean) to bsa_app;

-- Attach a creator-pack sticker to an already-existing, already-paid tip
-- order. Never trusts the client's choice: re-checks existence, enabled,
-- reviewed status, and live tier-quota eligibility inside this one
-- function — same shape as attach_sticker_to_tip (0110), independent
-- table, so a catalogue sticker and a creator-pack sticker never shadow
-- one another on the same order.
create or replace function app_private.attach_creator_pack_sticker_to_tip(
  target_channel_id uuid,
  target_order_id uuid,
  target_pack_sticker_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  intent record;
  pack record;
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

  select id, channel_id, enabled, status into pack
    from public.creator_sticker_packs
   where id = target_pack_sticker_id;
  if not found or pack.channel_id <> target_channel_id then
    raise exception 'unknown creator-pack sticker' using errcode = '22023';
  end if;
  if not pack.enabled or pack.status <> 'active' then
    raise exception 'creator-pack sticker is not available for this channel' using errcode = '42501';
  end if;

  if not exists (
    select 1 from app_private.list_public_creator_pack_for_channel(target_channel_id) eligible
     where eligible.id = target_pack_sticker_id
  ) then
    raise exception 'creator-pack sticker is not available for this channel' using errcode = '42501';
  end if;

  if exists (select 1 from public.channel_creator_pack_selections where order_id = target_order_id) then
    raise exception 'a creator-pack sticker is already attached to this tip' using errcode = '22023';
  end if;

  new_id := gen_random_uuid();
  insert into public.channel_creator_pack_selections (id, channel_id, order_id, pack_sticker_id, created_at)
  values (new_id, target_channel_id, target_order_id, target_pack_sticker_id, current_timestamp);

  return new_id;
end
$$;

revoke execute on function app_private.attach_creator_pack_sticker_to_tip(uuid, uuid, uuid) from public;
grant execute on function app_private.attach_creator_pack_sticker_to_tip(uuid, uuid, uuid) to bsa_app;
