-- L22c gap-fill: the platform-staff review surface for Studio creator-pack
-- stickers left open by 0119 (see 0119's header and its
-- review_creator_pack_sticker comment: "There is no HTTP route calling
-- that function yet ... no platform-staff role/route exists anywhere in
-- this codebase to gate it at the API layer").
--
-- WHAT ALREADY EXISTED: app_private.is_platform_admin() (0073) is a real,
-- backed platform-staff check — a boolean column on app_users
-- (is_platform_admin), scoped to the account (not to any channel), used
-- today by the admin DLQ (0073), admin entitlement override (0074) and
-- ingest-failure (0099) surfaces. It is exactly the "platform-staff role
-- distinct from channel roles" this task asks for. This migration reuses
-- it as-is — it does NOT add a second staff table/column/concept. Every
-- function below gates on app_private.is_platform_admin(), the identical
-- primitive apps/api/src/routes/admin.ts's existing routes already trust.
--
-- THE BOUNDARY: is_platform_admin() is entirely independent of
-- app_private.has_channel_role() (owner/admin/operator/moderator/viewer
-- are channel-scoped; see 0110/master plan Part 11.5). A channel
-- owner/admin has no is_platform_admin row flip from any channel action —
-- there is no code path anywhere that sets it from a channel role — so a
-- channel owner reaching a function below still fails the same
-- is_platform_admin() check as any other non-staff caller. Proven in
-- packages/db/tests/l22c_staff_creator_pack_review.sql.
--
-- CROSS-CREATOR READ SCOPE, DELIBERATELY NARROW: the two staff read
-- functions below select ONLY from public.creator_sticker_packs
-- (channel_id, display_name, category, asset bytes/mime/size,
-- creator_attested, status, timestamps) — there is no join to
-- payment_order_intents, channel_creator_pack_selections, or any
-- supporter/tipper/viewer identity table anywhere in this file. A staff
-- reviewer can see which channel uploaded a pending sticker (necessary —
-- review is per-channel-tier) and the sticker asset itself, and nothing
-- about who tipped with it. This is the same content boundary 0073's
-- list_admin_dlq and 0099's ingest-failure reader already draw ("an admin
-- needs to know WHAT is stuck and WHERE, not read [viewer] content").
--
-- AUDIT: every review decision is recorded in a new, append-only table —
-- reviewer, timestamp, decision, and (mandatory on rejection) the reason —
-- so a decision is reconstructable later without trusting apps/api's own
-- request logs. staff_review_creator_pack_sticker is the only writer; it
-- wraps 0119's own app_private.review_creator_pack_sticker (which this
-- migration does not and cannot edit) rather than reimplementing its
-- status-flip logic, then inserts the audit row in the same transaction.

create table public.staff_creator_pack_review_audit (
  id uuid primary key,
  pack_sticker_id uuid not null references public.creator_sticker_packs(id),
  reviewer_id uuid not null references public.app_users(id),
  decision text not null check (decision in ('approved', 'rejected')),
  reason text check (reason is null or char_length(reason) between 1 and 1000),
  reviewed_at timestamptz not null default current_timestamp,
  check (decision = 'approved' or reason is not null)
);

create index staff_creator_pack_review_audit_pack_idx
  on public.staff_creator_pack_review_audit (pack_sticker_id, reviewed_at);

alter table public.staff_creator_pack_review_audit enable row level security;
revoke all on public.staff_creator_pack_review_audit from public;
revoke all on public.staff_creator_pack_review_audit from bsa_app;

-- List every pending-review creator-pack sticker, oldest first. Staff
-- only. Metadata + size, never the asset bytes (kept out of the list
-- shape the same way list_creator_pack_for_channel omits bytes) — a
-- reviewer opens one entry to see the asset itself.
create or replace function app_private.staff_list_pending_creator_pack_stickers(
  target_limit integer default 50
)
returns table (
  id uuid, channel_id uuid, display_name text, category text,
  byte_size integer, creator_attested boolean, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;
  if target_limit is null or target_limit not between 1 and 200 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;

  return query
    select pack.id, pack.channel_id, pack.display_name, pack.category,
           octet_length(pack.asset_bytes)::integer, pack.creator_attested, pack.created_at
      from public.creator_sticker_packs pack
     where pack.status = 'pending_review'
     order by pack.created_at, pack.id
     limit target_limit;
end
$$;

revoke execute on function app_private.staff_list_pending_creator_pack_stickers(integer) from public;
grant execute on function app_private.staff_list_pending_creator_pack_stickers(integer) to bsa_app;

-- Inspect one pending (or already-decided) creator-pack sticker, asset
-- bytes included, for review. Staff only. Still no join beyond
-- creator_sticker_packs itself — no supporter/tipper identity is
-- reachable from this function.
create or replace function app_private.staff_get_creator_pack_sticker_for_review(
  target_pack_sticker_id uuid
)
returns table (
  id uuid, channel_id uuid, display_name text, category text,
  asset_bytes bytea, mime_type text, byte_size integer,
  creator_attested boolean, status text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;

  return query
    select pack.id, pack.channel_id, pack.display_name, pack.category,
           pack.asset_bytes, pack.mime_type, octet_length(pack.asset_bytes)::integer,
           pack.creator_attested, pack.status, pack.created_at
      from public.creator_sticker_packs pack
     where pack.id = target_pack_sticker_id;
end
$$;

revoke execute on function app_private.staff_get_creator_pack_sticker_for_review(uuid) from public;
grant execute on function app_private.staff_get_creator_pack_sticker_for_review(uuid) to bsa_app;

-- Approve or reject a pending creator-pack sticker. Staff only. A
-- rejection with no reason is refused before anything is written — "not
-- a decision anyone can act on later" per this task. Delegates the
-- actual status flip to 0119's app_private.review_creator_pack_sticker
-- (unedited, reused as-is) and records the audit row in the same
-- transaction, so the two can never drift apart.
create or replace function app_private.staff_review_creator_pack_sticker(
  target_pack_sticker_id uuid,
  target_approved boolean,
  target_reason text default null
)
returns table (id uuid, status text, decision text, reviewer_id uuid, reviewed_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_reviewer uuid;
  new_status text;
  new_decision text;
  audit_id uuid;
  audit_time timestamptz;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;

  if target_approved is null then
    raise exception 'a review decision (approve or reject) is required' using errcode = '22023';
  end if;

  if not target_approved and (target_reason is null or char_length(target_reason) < 1) then
    raise exception 'a rejection reason is required' using errcode = '22023';
  end if;

  current_reviewer := app_private.current_user_id();
  new_decision := case when target_approved then 'approved' else 'rejected' end;

  select app_private.review_creator_pack_sticker(target_pack_sticker_id, target_approved) into new_status;

  audit_id := gen_random_uuid();
  audit_time := current_timestamp;

  insert into public.staff_creator_pack_review_audit
    (id, pack_sticker_id, reviewer_id, decision, reason, reviewed_at)
  values
    (audit_id, target_pack_sticker_id, current_reviewer, new_decision, target_reason, audit_time);

  return query select target_pack_sticker_id, new_status, new_decision, current_reviewer, audit_time;
end
$$;

revoke execute on function app_private.staff_review_creator_pack_sticker(uuid, boolean, text) from public;
grant execute on function app_private.staff_review_creator_pack_sticker(uuid, boolean, text) to bsa_app;

-- Audit read: every decision recorded for one sticker, newest first.
-- Staff only — this is an internal accountability trail, not a
-- creator-facing surface.
create or replace function app_private.staff_list_creator_pack_review_audit(
  target_pack_sticker_id uuid
)
returns table (id uuid, reviewer_id uuid, decision text, reason text, reviewed_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access is required' using errcode = '42501';
  end if;

  return query
    select audit.id, audit.reviewer_id, audit.decision, audit.reason, audit.reviewed_at
      from public.staff_creator_pack_review_audit audit
     where audit.pack_sticker_id = target_pack_sticker_id
     order by audit.reviewed_at desc, audit.id desc;
end
$$;

revoke execute on function app_private.staff_list_creator_pack_review_audit(uuid) from public;
grant execute on function app_private.staff_list_creator_pack_review_audit(uuid) to bsa_app;
