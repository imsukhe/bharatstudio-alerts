-- L24 Companion action catalogue and standalone mode.
--
-- Turns the fixed three-action Companion contract (0041: pause_queue,
-- resume_queue, send_test_alert) into a conditional catalogue. Alerts
-- actions still require a live Alerts entitlement and a connected overlay;
-- new OBS / Mirror / Stream actions are available to every channel
-- regardless of Alerts, gated only by activation (is the target actually
-- live), which the API layer evaluates at the two owned surfaces
-- (companion.ts route logic and, for the layout grid, the DB functions
-- below).
--
-- This migration does not rewrite or invalidate any historical
-- companion_commands or companion_layout_versions row. Both constraint
-- extensions below follow 0041's own precedent: NOT VALID, so existing rows
-- are preserved as append-only evidence and the migration does not require
-- a full-table scan or rewrite.

-- 1. Widen 0041's action allowlist. The three legacy actions are joined by
--    the OBS group (mirrors what BharatStudioCompanionMacOS/OBSWebSocketClient
--    and windows/OBSWebSocketClient.cs already implement as OBS WebSocket v5
--    standard requests: SetCurrentProgramScene, SetSceneItemEnabled,
--    ToggleInputMute, StartStream, StopStream, StartRecord, StopRecord,
--    SaveReplayBuffer, SetCurrentSceneTransition), plus placeholder Mirror
--    and Stream actions (no local execution wired in this task — see
--    companion.ts's own header comment on scope).
-- 0003's original table definition also declared an inline, unnamed CHECK
-- on this column (`action text not null check (action in (...))`), which
-- Postgres auto-named companion_commands_action_check. 0041 only added its
-- own, separately-named, stricter constraint alongside it -- both applied
-- (Postgres ANDs every CHECK on a column), so 0041's three-action allowlist
-- was already the effective one for new rows and this drop widens the
-- correct, binding constraint without touching 0003's file. Also NOT VALID,
-- for the same append-only-evidence reason as 0041.
alter table public.companion_commands
  drop constraint if exists companion_commands_action_check;

alter table public.companion_commands
  drop constraint if exists companion_commands_v1_action_check;

alter table public.companion_commands
  add constraint companion_commands_v1_action_check
  check (action in (
    -- Alerts group (0041, unchanged)
    'pause_queue', 'resume_queue', 'send_test_alert',
    -- OBS group
    'obs_set_scene', 'obs_toggle_source', 'obs_toggle_mute',
    'obs_start_stream', 'obs_stop_stream',
    'obs_start_record', 'obs_stop_record',
    'obs_save_replay_buffer', 'obs_set_transition',
    -- Mirror group
    'mirror_start', 'mirror_stop', 'mirror_screenshot',
    -- Stream group
    'stream_go_live', 'stream_end'
  )) not valid;

comment on constraint companion_commands_v1_action_check on public.companion_commands is
  'v1+L24 accepts the full Companion action catalogue (Alerts/OBS/Mirror/Stream); legacy historical rows remain preserved and the constraint is intentionally not validated against them';

-- 2. Per-action group lookup, used by the layout validator below and by
--    companion.ts's own in-process mirror of the same table (kept in sync
--    manually — see companion.ts's ACTION_GROUPS constant and its header
--    comment).
create or replace function app_private.companion_action_group(target_action text)
returns text
language sql
immutable
set search_path = pg_catalog, public, app_private
as $$
  select case
    when target_action in ('pause_queue', 'resume_queue', 'send_test_alert') then 'alerts'
    when target_action in ('obs_set_scene', 'obs_toggle_source', 'obs_toggle_mute',
                            'obs_start_stream', 'obs_stop_stream', 'obs_start_record',
                            'obs_stop_record', 'obs_save_replay_buffer', 'obs_set_transition') then 'obs'
    when target_action in ('mirror_start', 'mirror_stop', 'mirror_screenshot') then 'mirror'
    when target_action in ('stream_go_live', 'stream_end') then 'stream'
    else null
  end
$$;

revoke execute on function app_private.companion_action_group(text) from public;
grant execute on function app_private.companion_action_group(text) to bsa_app;

-- 3. Entitlement layer, reusing the existing per-tier list pattern
--    (allowedQueueModes, 0080/0083) rather than a ninth entitlement
--    dimension. OBS/Mirror/Stream groups are listed for every tier because
--    they are "available regardless of Alerts" per the master plan; the
--    Alerts group is listed too, but companion.ts and
--    app_private.channel_has_alerts_entitlement() (below) additionally
--    require the channel to actually have a channel_entitlement_versions
--    row at all -- a Companion-only implicit-channel signup has none, so it
--    sees zero Alerts actions even though 'alerts' appears in this list.
--    This is the same create-or-replace-in-place pattern 0083 used to patch
--    0080's function; queueCount, ttsEnabled and the other seven L03
--    dimensions are copied through unchanged.
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
        'approvalRequired', false,
        'companionActionGroups', jsonb_build_array('alerts', 'obs', 'mirror', 'stream')
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
        'approvalRequired', false,
        'companionActionGroups', jsonb_build_array('alerts', 'obs', 'mirror', 'stream')
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
        'approvalRequired', true,
        'companionActionGroups', jsonb_build_array('alerts', 'obs', 'mirror', 'stream')
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
        'approvalRequired', true,
        'companionActionGroups', jsonb_build_array('alerts', 'obs', 'mirror', 'stream')
      );
    else raise exception 'unknown entitlement tier: %', target_tier using errcode = '22023';
  end case;
end
$$;

-- Refresh every channel's latest published entitlement version in place, as
-- 0083 did, so companionActionGroups reaches live channels immediately.
update public.channel_entitlement_versions target
   set values = target.values || jsonb_build_object(
     'companionActionGroups', jsonb_build_array('alerts', 'obs', 'mirror', 'stream')
   )
 where target.version = (
   select max(v2.version) from public.channel_entitlement_versions v2
    where v2.channel_id = target.channel_id
 );

-- 4. Does this channel have any Alerts entitlement at all? A Companion-only
--    implicit-channel signup (task 5 of L24 -- implicit channel
--    provisioning -- is not implemented by this migration; it belongs to
--    the signup path, out of this repo-scope's owned files) has no
--    channel_entitlement_versions row, so this returns false and
--    companion.ts's entitlement gate removes the whole 'alerts' group for
--    that channel regardless of the tier default list above.
create or replace function app_private.channel_has_alerts_entitlement(target_channel_id uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, public, app_private
as $$
  select exists (
    select 1 from public.channel_entitlement_versions
     where channel_id = target_channel_id
  )
$$;

revoke execute on function app_private.channel_has_alerts_entitlement(uuid) from public;
grant execute on function app_private.channel_has_alerts_entitlement(uuid) to bsa_app;

-- 5. Target-type discriminator for companion_layout_versions slots
--    (0042). OBS-group slots carry a free-text target name (scene, source,
--    input or transition name) instead of a queue UUID; that free text gets
--    the same bounds treatment (1-200 chars) every other 0042 field
--    received, via a new optional 'targetLabel' slot key. Mirror/Stream
--    slots need neither a queue UUID nor a targetLabel. This is a
--    create-or-replace of 0042's own functions -- 0042's file is untouched,
--    its append-only companion_layout_versions rows are untouched, and its
--    grants (0042 already granted execute to bsa_app on both function
--    names) carry over unchanged across create-or-replace.
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
  max_allowed := app_private.companion_action_limit(current_tier);
  if target_page_size > max_allowed then
    raise exception 'Companion page size exceeds tier allocation' using errcode = '22023';
  end if;
  if jsonb_array_length(target_slots) > max_allowed then
    raise exception 'Companion action-slot entitlement exceeded' using errcode = '22023';
  end if;
  max_page := ceil(max_allowed::numeric / target_page_size)::integer;
  -- Default is the FULL catalogue, not the no-alerts default: a legacy
  -- entitlement row written before this migration (or a test fixture that
  -- predates the companionActionGroups key) must not silently lose the
  -- Alerts group it always had. The Companion-only case (no entitlement row
  -- at all) is a *different* signal, handled separately by has_alerts below
  -- regardless of what this default resolves to.
  select coalesce(
    (select entitlement.values -> 'companionActionGroups' from public.channel_entitlement_versions entitlement
      where entitlement.channel_id = target_channel_id
      order by entitlement.version desc limit 1),
    jsonb_build_array('alerts', 'obs', 'mirror', 'stream')
  ) into allowed_groups;

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
    -- Free-at-zero-payment-account and Companion-only-no-entitlement-row
    -- are different states; only the latter loses the Alerts group.
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

-- get_companion_layout is read-only and unchanged in validation terms (it
-- never validated slot shape), but is create-or-replaced here purely to
-- keep its definition adjacent to the function it shares this contract
-- with; its query and return shape are byte-for-byte identical to 0042's.
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
         app_private.companion_action_limit(entitlement.tier),
         coalesce(latest.page_size, least(16, app_private.companion_action_limit(entitlement.tier))),
         coalesce(latest.slots, '[]'::jsonb),
         latest.created_at
    from entitlement
    left join latest on true
   where app_private.can_access_channel(target_channel_id)
$$;

-- CREATE OR REPLACE preserves existing grants when the signature is
-- unchanged, but these are restated explicitly (idempotent, matching 0042's
-- own statements byte-for-byte) so this migration's intent is not left to
-- an implicit Postgres behavior.
revoke execute on function app_private.get_companion_layout(uuid) from public;
revoke execute on function app_private.update_companion_layout(uuid, uuid, bigint, integer, jsonb) from public;
grant execute on function app_private.get_companion_layout(uuid) to bsa_app;
grant execute on function app_private.update_companion_layout(uuid, uuid, bigint, integer, jsonb) to bsa_app;
