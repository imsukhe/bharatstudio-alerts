-- L24 Companion separation: Companion becomes its own entitlement,
-- evaluated independently of the Alerts tier (owner decision 2026-09-07,
-- docs/BharatStudio-MASTER-PLAN.md section 3.7).
--
-- THE BLOCKER (already identified there): app_private.companion_action_limit()
-- (0042) keys 8/16/32/64 on the Alerts tier via a CASE arm, and
-- tier_entitlement_dimensions() (0089) bakes a companionActionGroups array
-- into every entitlement snapshot at tier-assignment time. Both assume
-- Companion is a facet of an Alerts plan and neither can express "Companion,
-- no Alerts" as a live, one-row-change decision. tier_entitlement_dimensions
-- and channel_entitlement_versions are NOT touched by this migration --
-- they are heavily depended on for the other eight L03 dimensions, out of
-- this task's scope, and 0089's per-channel companionActionGroups override
-- (packages/db/tests/l24_companion_action_catalogue.sql channel
-- ...000b13) must keep working exactly as it does today.
--
-- THE FIX: a small, directly-editable table, source_key -> grant, read
-- LIVE (not snapshotted) by get_companion_layout / update_companion_layout
-- on every call. A per-channel explicit companionActionGroups override in
-- channel_entitlement_versions.values (0089's mechanism, preserved
-- verbatim) still wins when present -- this table supplies the DEFAULT for
-- every channel that has none, which after this migration includes every
-- Companion-only channel (no entitlement row: source_key = 'standalone')
-- and every newly-onboarded or re-tiered Alerts channel going forward (see
-- the tier_entitlement_dimensions create-or-replace at the bottom of this
-- file, which stops baking a companionActionGroups key into new entitlement
-- snapshots -- without that half of the fix, every new channel would still
-- carry an explicit per-channel override that outranks this table, and the
-- table could only ever govern action_limit, never the group list, for any
-- real channel). companion_action_limit(text) (0042) is left in place,
-- unmodified, for any other caller; it is simply no longer called by the
-- two functions below, which is how a CASE arm stops being the source of
-- truth without deleting it out from under something else.

create table companion_grant_policies (
  source_key text primary key
    check (source_key in ('alerts:free', 'alerts:pro', 'alerts:creator', 'alerts:studio', 'standalone')),
  granted boolean not null,
  action_limit integer not null check (action_limit in (8, 16, 32, 64)),
  action_groups jsonb not null check (jsonb_typeof(action_groups) = 'array'),
  updated_at timestamptz not null default current_timestamp
);

comment on table companion_grant_policies is
  'DATA, not code: the Alerts-plan -> Companion-grant mapping. One UPDATE per source_key changes what every channel resolving to that key sees on its very next request -- no migration, no deploy, no per-channel backfill. Read live by app_private.companion_grant_policy(); a per-channel channel_entitlement_versions.values.companionActionGroups override (0089) still takes precedence when present.';
comment on column companion_grant_policies.source_key is
  '''alerts:<tier>'' for a channel with a live channel_entitlement_versions row (app_private.channel_has_alerts_entitlement), ''standalone'' for a channel with none (a Companion-only signup).';
comment on column companion_grant_policies.granted is
  'Whether this source grants Companion at all. Flipping to false is the "unbundle Companion from this plan" switch: app_private.update_companion_layout treats it as an empty action_groups set unless a per-channel override says otherwise.';

alter table companion_grant_policies enable row level security;
-- No policies: this is small, low-cardinality operational config, not
-- per-channel data. Nobody selects it directly -- it is read only from
-- inside the two SECURITY DEFINER functions below (companion_layout_
-- versions, 0042, follows the same no-direct-grant pattern for the same
-- reason). An UPDATE to flip a policy is an operator/migration-role
-- action, exactly like 0089's own bulk backfill UPDATE was.
revoke all on public.companion_grant_policies from public;
revoke all on public.companion_grant_policies from bsa_app;

-- Seed: byte-for-byte today's behavior.
--   alerts:<tier> action_limit matches 0042's companion_action_limit() CASE
--   (8/16/32/64) and action_groups matches 0089's tier_entitlement_
--   dimensions() companionActionGroups default (all four groups) for every
--   tier -- nobody loses anything on the day this ships (see test proof).
--   standalone (no entitlement row) matches companion.ts's existing
--   NO_ALERTS_ENTITLED_GROUPS constant (obs/mirror/stream, no alerts) with
--   an 8-slot limit -- the same limit a Companion-only channel gets today
--   only as an accident of current_tier defaulting to 'free' when no
--   entitlement row exists (0042's own coalesce(..., 'free')). This
--   migration makes that limit an intentional, named, editable row instead
--   of a coincidence of the free-tier default.
insert into companion_grant_policies (source_key, granted, action_limit, action_groups) values
  ('alerts:free',    true, 8,  '["alerts", "obs", "mirror", "stream"]'::jsonb),
  ('alerts:pro',     true, 16, '["alerts", "obs", "mirror", "stream"]'::jsonb),
  ('alerts:creator', true, 32, '["alerts", "obs", "mirror", "stream"]'::jsonb),
  ('alerts:studio',  true, 64, '["alerts", "obs", "mirror", "stream"]'::jsonb),
  ('standalone',     true, 8,  '["obs", "mirror", "stream"]'::jsonb);

-- Live lookup: which policy row applies to this channel right now. Every
-- channel with a channel_entitlement_versions row resolves to its Alerts
-- tier's key; every channel with none (Companion-only) resolves to
-- 'standalone'. This is the one place "which Alerts plan maps to what
-- Companion grant" is decided, and it decides it by reading a row, not by
-- branching on the tier string.
create or replace function app_private.companion_grant_policy(target_channel_id uuid)
returns table (
  source_key text,
  granted boolean,
  action_limit integer,
  action_groups jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with resolved as (
    select coalesce(
      (select 'alerts:' || entitlement.tier
         from public.channel_entitlement_versions entitlement
        where entitlement.channel_id = target_channel_id
        order by entitlement.version desc limit 1),
      'standalone'
    ) as key
  )
  select policy.source_key, policy.granted, policy.action_limit, policy.action_groups
    from resolved
    join public.companion_grant_policies policy on policy.source_key = resolved.key
   where app_private.can_access_channel(target_channel_id)
$$;

revoke execute on function app_private.companion_grant_policy(uuid) from public;
grant execute on function app_private.companion_grant_policy(uuid) to bsa_app;

-- get_companion_layout: max_slots now comes from the live policy's
-- action_limit instead of companion_action_limit(tier). Return shape is
-- byte-for-byte identical to 0042/0089's (same column names, same order),
-- so no TypeScript-side change is needed.
create or replace function app_private.get_companion_layout(target_channel_id uuid)
returns table (
  channel_id uuid,
  version bigint,
  tier text,
  max_slots integer,
  page_size integer,
  slots jsonb,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with entitlement as (
    select coalesce(
      (select tier from public.channel_entitlement_versions
        where channel_id = target_channel_id
        order by version desc limit 1),
      'free'
    ) as tier
  ), policy as (
    select action_limit from app_private.companion_grant_policy(target_channel_id)
  ), latest as (
    select layout.version, layout.page_size, layout.slots, layout.created_at
      from public.companion_layout_versions layout
     where layout.channel_id = target_channel_id
     order by layout.version desc
     limit 1
  )
  select target_channel_id,
         coalesce(latest.version, 0),
         entitlement.tier,
         coalesce((select action_limit from policy), app_private.companion_action_limit(entitlement.tier)),
         coalesce(latest.page_size, least(16, coalesce((select action_limit from policy), app_private.companion_action_limit(entitlement.tier)))),
         coalesce(latest.slots, '[]'::jsonb),
         latest.created_at
    from entitlement
    left join latest on true
   where app_private.can_access_channel(target_channel_id)
$$;

-- update_companion_layout: max_allowed and the *default* allowed_groups
-- now come from the live policy. A per-channel explicit
-- channel_entitlement_versions.values.companionActionGroups (0089) is
-- still read first and, when present, still wins -- unchanged from
-- 0089's own behavior, and required by
-- packages/db/tests/l24_companion_action_catalogue.sql's channel
-- ...000b13 case (Creator tier explicitly restricted to ['obs']).
create or replace function app_private.update_companion_layout(
  target_channel_id uuid,
  target_user_id uuid,
  expected_version bigint,
  target_page_size integer,
  target_slots jsonb
)
returns table (
  channel_id uuid,
  version bigint,
  tier text,
  max_slots integer,
  page_size integer,
  slots jsonb,
  created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_version bigint;
  next_version bigint;
  current_tier text;
  max_allowed integer;
  has_alerts boolean;
  policy_granted boolean;
  policy_action_limit integer;
  policy_action_groups jsonb;
  allowed_groups jsonb;
  item jsonb;
  slot_index integer;
  page_number integer;
  action_name text;
  action_group text;
  label_text text;
  target_text text;
  target_label text;
  max_page integer;
  inserted_at timestamptz;
begin
  if target_user_id <> app_private.current_user_id() then
    raise exception 'actor mismatch' using errcode = '42501';
  end if;
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator']::text[]) then
    raise exception 'channel access denied' using errcode = '42501';
  end if;
  if target_page_size not in (4, 8, 16) then
    raise exception 'unsupported Companion page size' using errcode = '22023';
  end if;
  if jsonb_typeof(target_slots) <> 'array' then
    raise exception 'Companion slots must be an array' using errcode = '22023';
  end if;

  -- Serialize version creation per channel without relying on a session
  -- advisory lock, so transaction-pooled connections remain safe.
  perform pg_advisory_xact_lock(hashtextextended(target_channel_id::text, 0));
  select coalesce(max(layout.version), 0)
    into current_version
    from public.companion_layout_versions layout
   where layout.channel_id = target_channel_id;
  if current_version <> expected_version then
    raise exception 'Companion layout version conflict' using errcode = '40001';
  end if;

  select coalesce(
    (select entitlement.tier from public.channel_entitlement_versions entitlement
      where entitlement.channel_id = target_channel_id
      order by entitlement.version desc limit 1),
    'free'
  ) into current_tier;
  has_alerts := app_private.channel_has_alerts_entitlement(target_channel_id);

  select policy.granted, policy.action_limit, policy.action_groups
    into policy_granted, policy_action_limit, policy_action_groups
    from app_private.companion_grant_policy(target_channel_id) policy;
  -- companion_grant_policy always resolves (every tier plus 'standalone'
  -- is seeded and the source_key CHECK keeps tier out of sync impossible),
  -- but fail closed rather than crash if a row is ever missing.
  if policy_granted is null then
    policy_granted := false;
    policy_action_limit := 8;
    policy_action_groups := '[]'::jsonb;
  end if;

  max_allowed := policy_action_limit;
  if target_page_size > max_allowed then
    raise exception 'Companion page size exceeds tier allocation' using errcode = '22023';
  end if;
  if jsonb_array_length(target_slots) > max_allowed then
    raise exception 'Companion action-slot entitlement exceeded' using errcode = '22023';
  end if;
  max_page := ceil(max_allowed::numeric / target_page_size)::integer;

  -- Precedence: an explicit per-channel override always wins (0089,
  -- unchanged). Otherwise, the live policy's default groups apply, or the
  -- empty set if this source is not currently granted Companion at all.
  select
    (select entitlement.values -> 'companionActionGroups' from public.channel_entitlement_versions entitlement
      where entitlement.channel_id = target_channel_id
      order by entitlement.version desc limit 1)
    into allowed_groups;
  if allowed_groups is null then
    allowed_groups := case when policy_granted then policy_action_groups else '[]'::jsonb end;
  end if;

  for item in select value from jsonb_array_elements(target_slots) loop
    if jsonb_typeof(item) <> 'object'
       or item - array['slotIndex', 'page', 'label', 'action', 'targetId', 'targetLabel'] <> '{}'::jsonb
       or not (item ? 'slotIndex' and item ? 'page' and item ? 'label' and item ? 'action' and item ? 'targetId') then
      raise exception 'Invalid Companion action slot shape' using errcode = '22023';
    end if;
    if (item->>'slotIndex') !~ '^[1-9][0-9]*$'
       or (item->>'page') !~ '^[1-9][0-9]*$' then
      raise exception 'Companion slot indexes must be positive integers' using errcode = '22023';
    end if;
    slot_index := (item->>'slotIndex')::integer;
    page_number := (item->>'page')::integer;
    label_text := item->>'label';
    action_name := item->>'action';
    target_text := item->>'targetId';
    target_label := item->>'targetLabel';
    if slot_index > max_allowed or page_number > max_page then
      raise exception 'Companion slot is outside the tier/page allocation' using errcode = '22023';
    end if;
    if length(label_text) < 1 or length(label_text) > 80 then
      raise exception 'Companion slot label length is invalid' using errcode = '22023';
    end if;

    action_group := app_private.companion_action_group(action_name);
    if action_group is null then
      raise exception 'Unsupported Companion action' using errcode = '22023';
    end if;
    -- Entitlement layer: may this action's group exist for this channel at
    -- all. 'alerts' additionally requires a real Alerts entitlement row --
    -- a source with no channel_entitlement_versions row is 'standalone'
    -- and can never carry 'alerts' regardless of what a stale override
    -- claims.
    if not (allowed_groups ? action_group) or (action_group = 'alerts' and not has_alerts) then
      raise exception 'Companion action group is not entitled for this channel' using errcode = '22023';
    end if;

    if action_group = 'alerts' then
      if target_label is not null then
        raise exception 'Alerts action slots do not take a targetLabel' using errcode = '22023';
      end if;
      if target_text !~ '^[0-9a-fA-F-]{36}$' then
        raise exception 'Companion action target must be a queue UUID' using errcode = '22023';
      end if;
      perform target_text::uuid;
      if not exists (
        select 1 from public.alert_queues queue
         where queue.id = target_text::uuid
           and queue.channel_id = target_channel_id
           and queue.closed_at is null
      ) then
        raise exception 'Companion action target queue is not active in channel' using errcode = '22023';
      end if;
    elsif action_group = 'obs' then
      if target_label is null or length(target_label) < 1 or length(target_label) > 200 then
        raise exception 'OBS action slots require a bounded targetLabel (scene/source/input/transition name)' using errcode = '22023';
      end if;
      if target_label !~ '^[\x20-\x7E]{1,200}$' then
        raise exception 'OBS targetLabel must be printable text' using errcode = '22023';
      end if;
    else
      -- mirror / stream: no queue UUID, no required targetLabel; an
      -- optional targetLabel (if present) still gets the same bounds.
      if target_label is not null and (length(target_label) < 1 or length(target_label) > 200) then
        raise exception 'Companion targetLabel length is invalid' using errcode = '22023';
      end if;
    end if;
  end loop;

  if exists (
    select 1
      from jsonb_array_elements(target_slots) with ordinality first_item(value, item_no)
      join jsonb_array_elements(target_slots) with ordinality second_item(value, item_no)
        on (first_item.value->>'slotIndex') = (second_item.value->>'slotIndex')
       and first_item.item_no < second_item.item_no
  ) then
    raise exception 'Companion slot indexes must be unique' using errcode = '22023';
  end if;

  next_version := current_version + 1;
  insert into public.companion_layout_versions (channel_id, version, page_size, slots, created_by, created_at)
  values (target_channel_id, next_version, target_page_size, target_slots, target_user_id, current_timestamp)
  returning companion_layout_versions.created_at into inserted_at;

  return query select target_channel_id, next_version, current_tier, max_allowed,
                      target_page_size, target_slots, inserted_at;
end
$$;

revoke execute on function app_private.get_companion_layout(uuid) from public;
revoke execute on function app_private.update_companion_layout(uuid, uuid, bigint, integer, jsonb) from public;
grant execute on function app_private.get_companion_layout(uuid) to bsa_app;
grant execute on function app_private.update_companion_layout(uuid, uuid, bigint, integer, jsonb) to bsa_app;

-- tier_entitlement_dimensions (0080, replaced in place by 0083 then 0089,
-- replaced in place again here): stop baking 'companionActionGroups' into
-- every freshly-created or re-tiered entitlement snapshot. This is the
-- other half of the blocker quoted in the master plan -- as long as this
-- function keeps writing the key into channel_entitlement_versions.values,
-- every new entitlement version carries an explicit per-channel override
-- that (correctly, per 0089's own precedence rule, preserved above)
-- outranks the live companion_grant_policies table, so the table could
-- never actually govern a real channel going forward, only its action
-- limit. Every other key (queueCount, ttsEnabled, allowedQueueModes,
-- maxVisibleItems, maxCharLimit, maxDisplayMs, quietMode,
-- approvalRequired) is copied through byte-for-byte unchanged -- only the
-- Companion key is removed, and only from here.
--
-- SAFE FOR EXISTING ROWS: this does not touch a single existing
-- channel_entitlement_versions row (no bulk UPDATE, unlike 0089's own
-- backfill) -- an already-persisted row keeps whatever companionActionGroups
-- it already has, byte-for-byte, and 0089's override precedence continues
-- to honor it. Only a *new* entitlement version, from here on, is written
-- without the key -- and update_companion_layout / get_companion_layout
-- fall through to companion_grant_policy for exactly that case, at the
-- same default values the key used to carry. Net observable behavior for
-- every tier is unchanged; only the source a future change would edit
-- moves from "next migration's CASE arm" to "today's UPDATE".
create or replace function app_private.tier_entitlement_dimensions(target_tier text)
returns jsonb
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then
      return jsonb_build_object(
        'queueCount', 1,
        'ttsEnabled', false,
        'allowedQueueModes', jsonb_build_array('fifo'),
        'maxVisibleItems', 3,
        'maxCharLimit', 100,
        'maxDisplayMs', 6000,
        'quietMode', false,
        'approvalRequired', false
      );
    when 'pro' then
      return jsonb_build_object(
        'queueCount', 2,
        'ttsEnabled', true,
        'allowedQueueModes', jsonb_build_array('fifo', 'stacked', 'pills', 'aggregated'),
        'maxVisibleItems', 5,
        'maxCharLimit', 150,
        'maxDisplayMs', 8000,
        'quietMode', true,
        'approvalRequired', false
      );
    when 'creator' then
      return jsonb_build_object(
        'queueCount', 3,
        'ttsEnabled', true,
        'allowedQueueModes', jsonb_build_array('fifo', 'stacked', 'pills', 'aggregated', 'priority'),
        'maxVisibleItems', 8,
        'maxCharLimit', 300,
        'maxDisplayMs', 12000,
        'quietMode', true,
        'approvalRequired', true
      );
    when 'studio' then
      return jsonb_build_object(
        'queueCount', 5,
        'ttsEnabled', true,
        'allowedQueueModes', jsonb_build_array('fifo', 'stacked', 'pills', 'aggregated', 'priority'),
        'maxVisibleItems', 12,
        'maxCharLimit', 500,
        'maxDisplayMs', 20000,
        'quietMode', true,
        'approvalRequired', true
      );
    else raise exception 'unknown entitlement tier: %', target_tier using errcode = '22023';
  end case;
end
$$;
