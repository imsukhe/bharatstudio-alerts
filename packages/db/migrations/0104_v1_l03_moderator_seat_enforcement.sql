-- MASTER-PLAN §3.14: moderator seats (0/0/2/5 free/pro/creator/studio) have
-- been advertised on the pricing page and in §3.6's marketing table, but
-- nothing in the schema or API enforced them — 'moderator' has only ever
-- been a channel_memberships.role value with no seat accounting anywhere.
-- A Free channel could add unlimited moderators. Owner decision 2026-09-07:
-- build the enforcement.
--
-- SHAPE: app_private.tier_moderator_seat_limit() copies
-- app_private.tier_queue_count()'s exact shape (0070/0080) — same
-- case/immutable/22023-on-unknown-tier pattern — a second, independent
-- source of truth for a second per-tier limit, not a new convention.
--
-- ENFORCEMENT POINT: every existing write into channel_memberships (0003,
-- 0025, 0070, 0080 — all inside app_private.create_channel) only ever
-- inserts the creating user as 'owner'. There is no existing write path
-- anywhere in apps/api or packages/db/migrations that grants or changes a
-- *moderator* seat (verified by grep; the only other inserts are test
-- fixtures under scripts/fixtures and packages/db/tests). This migration
-- adds that write path, app_private.set_channel_membership_role(), and it
-- is the ONLY one. It is SECURITY DEFINER, same pattern as
-- app_private.change_channel_handle (0087): channel_memberships already
-- carries an RLS policy (channel_memberships_admin_write, 0002) that lets
-- an owner/admin write the table directly as bsa_app, so the seat check
-- must live inside a definer function that is the sole sanctioned entry
-- point, not bolted onto the route — a route-only check would not stop a
-- direct table write under that existing policy. apps/api's route
-- (routes/channels.ts) only calls this function and translates its
-- exceptions to HTTP status codes; it does not reimplement the check.
--
-- OVER-LIMIT STRATEGY — grandfather existing channels, block only NEW
-- moderator additions: unlike 0080's queueCount retier, no channel has ever
-- had a moderator seat check applied before this migration, so there is no
-- channel that "used to be compliant and just went over" the way a tier
-- downgrade can do to queueCount — only channels that were already over an
-- advertised-but-unenforced limit, in some cases long before this
-- migration existed. Deleting or demoting an existing moderator to force a
-- channel into compliance is explicitly disallowed by the owner decision,
-- so this migration touches zero existing channel_memberships rows and
-- runs no backfill loop (contrast 0080's `do $$ ... $$` re-pause block,
-- which had rows it was safe to pause). Enforcement instead applies only at
-- the moment a NEW moderator grant is attempted:
-- set_channel_membership_role() counts a channel's *current* active
-- moderators and compares against its *current* tier's limit before
-- allowing an insert/role-change INTO 'moderator'. An already over-limit
-- channel keeps failing that comparison (active count >= limit) until it
-- is back at or under its seat limit through its own removals — so it is
-- blocked from adding more without anyone being silently removed. A
-- channel already at or under its limit is unaffected. Re-affirming an
-- existing active moderator's role, or changing a non-moderator to some
-- other non-moderator role, never triggers the check (it only fires when
-- the target role is 'moderator' and the member is not already an active
-- moderator) — so no existing membership row can ever fail a future no-op
-- re-save because of this migration. This also means a tier downgrade
-- never removes anyone: nothing here hooks
-- publish_active_individual_entitlement / publish_free_entitlement (0080),
-- so an over-limit channel simply cannot add more moderators until it
-- drops back under its new tier's limit — the same "flag and block new
-- growth" outcome the plan's own alternative option describes, chosen over
-- silent grandfather-forever because it gives the creator a real incentive
-- and path to compliance without ever taking anyone's access away.
--
-- Only 'moderator' counts against the seat limit. 'owner', 'admin' and
-- 'operator' are distinct channel_memberships.role values (0001_v1_baseline
-- role check: owner/admin/operator/moderator/viewer) with their own
-- unrelated authorization meaning (app_private.has_channel_role, 0002) and
-- are never counted here.

create or replace function app_private.tier_moderator_seat_limit(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 0;
    when 'pro' then return 0;
    when 'creator' then return 2;
    when 'studio' then return 5;
    else raise exception 'unknown entitlement tier: %', target_tier using errcode = '22023';
  end case;
end
$$;

-- Grants or changes one channel_memberships row. Only a transition INTO
-- 'moderator' for a member who is not already an active moderator is
-- seat-checked (see migration header); every other role transition is
-- otherwise unrestricted here. Authorization (who may call this at all) is
-- app_private.has_channel_role(..., ['owner','admin']) — the same
-- authorization channel_memberships_admin_write (0002) already expresses
-- as an RLS policy, re-asserted here because this function runs as
-- security definer and therefore bypasses that policy.
create or replace function app_private.set_channel_membership_role(
  target_channel_id uuid,
  target_member_user_id uuid,
  target_role text
)
returns table (
  membership_channel_id uuid, membership_user_id uuid, membership_role text, membership_created_at timestamptz, membership_revoked_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_tier text;
  seat_limit integer;
  active_moderator_count integer;
  existing_role text;
begin
  if target_role not in ('owner', 'admin', 'operator', 'moderator', 'viewer') then
    raise exception 'invalid channel role: %', target_role using errcode = '22023';
  end if;

  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'insufficient role to manage channel memberships' using errcode = '42501';
  end if;

  -- Serialize concurrent membership writes for this channel so two
  -- simultaneous moderator grants can never both observe the same
  -- pre-insert count and jointly exceed the seat limit (same per-channel
  -- row-lock pattern as apps/api/src/db/channel-store.ts createQueue).
  perform 1 from public.channels where id = target_channel_id for update;
  if not found then
    raise exception 'channel not found for membership change' using errcode = '23503';
  end if;

  select membership.role into existing_role
    from public.channel_memberships membership
   where membership.channel_id = target_channel_id
     and membership.user_id = target_member_user_id
     and membership.revoked_at is null;

  if target_role = 'moderator' and coalesce(existing_role, '') <> 'moderator' then
    select entitlement.tier into current_tier
      from public.channel_entitlement_versions entitlement
     where entitlement.channel_id = target_channel_id
     order by entitlement.version desc
     limit 1;

    seat_limit := app_private.tier_moderator_seat_limit(coalesce(current_tier, 'free'));

    select count(*) into active_moderator_count
      from public.channel_memberships membership
     where membership.channel_id = target_channel_id
       and membership.role = 'moderator'
       and membership.revoked_at is null;

    if active_moderator_count >= seat_limit then
      raise exception 'moderator seat limit reached for channel tier' using errcode = '23514';
    end if;
  end if;

  insert into public.channel_memberships (channel_id, user_id, role, created_at)
  values (target_channel_id, target_member_user_id, target_role, current_timestamp)
  on conflict (channel_id, user_id) do update
    set role = excluded.role,
        revoked_at = null;

  return query
    select membership.channel_id, membership.user_id, membership.role, membership.created_at, membership.revoked_at
      from public.channel_memberships membership
     where membership.channel_id = target_channel_id
       and membership.user_id = target_member_user_id;
end
$$;

-- (Above: RETURNS TABLE columns are named membership_* rather than
-- channel_id/user_id/role/... because those bare names would otherwise
-- shadow, as PL/pgSQL OUT-parameter variables, the identical column names
-- used both in the INSERT's column list and its ON CONFLICT (channel_id,
-- user_id) target a few lines up — that shadowing made the conflict target
-- ambiguous. apps/api/src/db/seat-store.ts selects and aliases these back
-- to channel_id/user_id/role/created_at/revoked_at.

revoke execute on function app_private.tier_moderator_seat_limit(text) from public;
revoke execute on function app_private.set_channel_membership_role(uuid, uuid, text) from public;
grant execute on function app_private.tier_moderator_seat_limit(text) to bsa_app;
grant execute on function app_private.set_channel_membership_role(uuid, uuid, text) to bsa_app;
