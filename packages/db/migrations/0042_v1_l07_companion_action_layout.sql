-- L07 Companion action-layout contract.
--
-- Layouts are append-only snapshots. A layout limit applies only to a new
-- Companion configuration; it never gates or mutates payments, queues,
-- accepted alerts, outbox rows, or delivery state.

create table companion_layout_versions (
  channel_id uuid not null references channels(id),
  version bigint not null check (version > 0),
  page_size integer not null check (page_size in (4, 8, 16)),
  slots jsonb not null check (jsonb_typeof(slots) = 'array'),
  created_by uuid not null references app_users(id),
  created_at timestamptz not null,
  primary key (channel_id, version)
);

alter table companion_layout_versions enable row level security;

create policy companion_layout_member_select
  on companion_layout_versions for select to bsa_app
  using (app_private.can_access_channel(channel_id));

-- Layout writes go through the validation function below. Direct table writes
-- are not granted to the request role, preserving one validation boundary.
revoke all on public.companion_layout_versions from public;
revoke insert, update, delete on public.companion_layout_versions from bsa_app;
grant select on public.companion_layout_versions to bsa_app;

create or replace function app_private.companion_action_limit(target_tier text)
returns integer
language sql
immutable
set search_path = pg_catalog, public, app_private
as $$
  select case target_tier
    when 'pro' then 16
    when 'creator' then 32
    when 'studio' then 64
    else 8
  end
$$;

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
  item jsonb;
  slot_index integer;
  page_number integer;
  action_name text;
  label_text text;
  target_text text;
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
  max_allowed := app_private.companion_action_limit(current_tier);
  if target_page_size > max_allowed then
    raise exception 'Companion page size exceeds tier allocation' using errcode = '22023';
  end if;
  if jsonb_array_length(target_slots) > max_allowed then
    raise exception 'Companion action-slot entitlement exceeded' using errcode = '22023';
  end if;
  max_page := ceil(max_allowed::numeric / target_page_size)::integer;

  for item in select value from jsonb_array_elements(target_slots) loop
    if jsonb_typeof(item) <> 'object'
       or item - array['slotIndex', 'page', 'label', 'action', 'targetId'] <> '{}'::jsonb
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
    if slot_index > max_allowed or page_number > max_page then
      raise exception 'Companion slot is outside the tier/page allocation' using errcode = '22023';
    end if;
    if length(label_text) < 1 or length(label_text) > 80 then
      raise exception 'Companion slot label length is invalid' using errcode = '22023';
    end if;
    if action_name not in ('pause_queue', 'resume_queue', 'send_test_alert') then
      raise exception 'Unsupported Companion action' using errcode = '22023';
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

revoke execute on function app_private.companion_action_limit(text) from public;
revoke execute on function app_private.get_companion_layout(uuid) from public;
revoke execute on function app_private.update_companion_layout(uuid, uuid, bigint, integer, jsonb) from public;
grant execute on function app_private.get_companion_layout(uuid) to bsa_app;
grant execute on function app_private.update_companion_layout(uuid, uuid, bigint, integer, jsonb) to bsa_app;
