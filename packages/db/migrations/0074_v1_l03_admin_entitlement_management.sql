-- L03: admin entitlement management — "an operable surface to view/update
-- the entitlement registry values introduced under L03/L04, with audit
-- history" ("v1 scope addendum — 2026-08-16").
--
-- Scope decision, made explicitly rather than guessed: this codebase does
-- not have (and the "Entitlement values addendum — 2026-08-16" deliberately
-- did not create) a tier-wide editable registry table — tier_queue_count()
-- is a fixed, code-owned function, matching the same care taken with
-- recurring_price_paise (both are CHECK-constrained/hardcoded specifically
-- so an accidental edit cannot silently change what every creator on a
-- tier is charged or entitled to). "Update the entitlement registry" is
-- therefore scoped here to per-channel support overrides — an admin
-- publishing a one-off entitlement exception for a specific channel (e.g. a
-- support case granting extra queueCount) — not a bulk tier-value editor.
-- Every override is versioned exactly like a normal plan publish and fully
-- audited; it never touches tier_queue_count() or any other channel's
-- entitlement.

alter table public.channel_entitlement_versions
  drop constraint if exists channel_entitlement_versions_source_check;

alter table public.channel_entitlement_versions
  add constraint channel_entitlement_versions_source_check
  check (source in ('individual_plan', 'admin_override'));

-- Cross-channel read: current entitlement + channel handle, admin-only.
create or replace function app_private.get_channel_entitlement_admin(
  target_channel_id uuid
)
returns table (
  channel_id uuid,
  channel_handle text,
  version bigint,
  tier text,
  source text,
  entitlement_values jsonb,
  effective_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform admin required' using errcode = '42501';
  end if;

  return query
    select entitlement.channel_id, channel.handle, entitlement.version, entitlement.tier,
           entitlement.source, entitlement.values, entitlement.effective_at
      from public.channel_entitlement_versions entitlement
      join public.channels channel on channel.id = entitlement.channel_id
     where entitlement.channel_id = target_channel_id
     order by entitlement.version desc
     limit 1;
end
$$;

-- Full version history for one channel, admin-only — the "audit history"
-- half of this feature reuses the entitlement table's own natural
-- versioning rather than a separate log, since every version row already
-- carries what changed and when.
create or replace function app_private.list_channel_entitlement_history(
  target_channel_id uuid,
  target_limit integer
)
returns table (
  version bigint,
  tier text,
  source text,
  entitlement_values jsonb,
  effective_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform admin required' using errcode = '42501';
  end if;

  return query
    select entitlement.version, entitlement.tier, entitlement.source, entitlement.values,
           entitlement.effective_at, entitlement.created_at
      from public.channel_entitlement_versions entitlement
     where entitlement.channel_id = target_channel_id
     order by entitlement.version desc
     limit greatest(least(coalesce(target_limit, 50), 200), 1);
end
$$;

-- Publishes a one-off support override for a single channel. Unlike
-- publish_active_individual_entitlement (driven only by a confirmed
-- subscription webhook) this is admin-initiated and explicitly audited —
-- both an audit_events row and the entitlement version itself (source=
-- 'admin_override') record who changed what and why. Deliberately narrow:
-- only queueCount is overridable in v1, matching the same scope boundary
-- the "Entitlement values addendum" already drew (every other
-- configFeatures dimension remains unset/unapproved).
create or replace function app_private.admin_override_channel_entitlement(
  target_channel_id uuid,
  target_admin_user_id uuid,
  target_queue_count integer,
  target_reason text
)
returns table (channel_id uuid, channel_handle text, version bigint, tier text, entitlement_values jsonb)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  latest public.channel_entitlement_versions%rowtype;
  next_version bigint;
  target_handle text;
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform admin required' using errcode = '42501';
  end if;
  if target_admin_user_id <> app_private.current_user_id() then
    raise exception 'actor mismatch' using errcode = '42501';
  end if;
  if target_queue_count is null or target_queue_count < 1 or target_queue_count > 1000 then
    raise exception 'queue count override must be between 1 and 1000' using errcode = '22023';
  end if;
  if target_reason is null or char_length(trim(target_reason)) = 0 then
    raise exception 'an override reason is required' using errcode = '22023';
  end if;

  select channel.handle into target_handle from public.channels channel where channel.id = target_channel_id for update;
  if not found then
    raise exception 'channel not found for entitlement override' using errcode = '23503';
  end if;

  select entitlement.* into latest
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id
   order by entitlement.version desc
   limit 1;

  select coalesce(max(entitlement.version), 0) + 1
    into next_version
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id;

  insert into public.channel_entitlement_versions (
    channel_id, version, tier, source, values, effective_at, created_at
  ) values (
    target_channel_id, next_version, coalesce(latest.tier, 'free'), 'admin_override',
    coalesce(latest.values, '{}'::jsonb) || jsonb_build_object('queueCount', target_queue_count, 'adminOverrideReason', target_reason),
    current_timestamp, current_timestamp
  );

  insert into public.audit_events (id, channel_id, actor_user_id, action, target_type, target_id, metadata, created_at)
  values (
    gen_random_uuid(), target_channel_id, target_admin_user_id, 'admin.entitlement.override', 'channel_entitlement_versions', target_channel_id::text,
    jsonb_build_object('version', next_version, 'queueCount', target_queue_count, 'reason', target_reason), current_timestamp
  );

  return query
    select target_channel_id, target_handle, next_version, coalesce(latest.tier, 'free'),
           coalesce(latest.values, '{}'::jsonb) || jsonb_build_object('queueCount', target_queue_count, 'adminOverrideReason', target_reason);
end
$$;

revoke execute on function app_private.get_channel_entitlement_admin(uuid) from public;
revoke execute on function app_private.list_channel_entitlement_history(uuid, integer) from public;
revoke execute on function app_private.admin_override_channel_entitlement(uuid, uuid, integer, text) from public;
grant execute on function app_private.get_channel_entitlement_admin(uuid) to bsa_app;
grant execute on function app_private.list_channel_entitlement_history(uuid, integer) to bsa_app;
grant execute on function app_private.admin_override_channel_entitlement(uuid, uuid, integer, text) to bsa_app;
