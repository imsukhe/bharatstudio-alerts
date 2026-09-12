-- L03 acceptance: 0083's queue mode ladder correction. Asserts the
-- published allowedQueueModes per tier, that 'approval' is never present
-- as a mode anywhere, that 'pills' is present from Pro up, and that
-- approvalRequired is untouched from 0080. Synthetic identifiers only.

\set ON_ERROR_STOP on

-- Function-level: exact corrected list per tier, straight from the single
-- source of truth.
do $$
declare
  free_modes jsonb;
  pro_modes jsonb;
  creator_modes jsonb;
  studio_modes jsonb;
begin
  free_modes := app_private.tier_entitlement_dimensions('free') -> 'allowedQueueModes';
  pro_modes := app_private.tier_entitlement_dimensions('pro') -> 'allowedQueueModes';
  creator_modes := app_private.tier_entitlement_dimensions('creator') -> 'allowedQueueModes';
  studio_modes := app_private.tier_entitlement_dimensions('studio') -> 'allowedQueueModes';

  if free_modes <> '["fifo"]'::jsonb then
    raise exception 'free allowedQueueModes wrong: %', free_modes;
  end if;
  if pro_modes <> '["fifo", "stacked", "pills", "aggregated"]'::jsonb then
    raise exception 'pro allowedQueueModes wrong: %', pro_modes;
  end if;
  if creator_modes <> '["fifo", "stacked", "pills", "aggregated", "priority"]'::jsonb then
    raise exception 'creator allowedQueueModes wrong: %', creator_modes;
  end if;
  if studio_modes <> '["fifo", "stacked", "pills", "aggregated", "priority"]'::jsonb then
    raise exception 'studio allowedQueueModes wrong: %', studio_modes;
  end if;

  -- creator and studio are deliberately identical mode lists (studio's
  -- extra power is approvalRequired + other dimensions, not more modes).
  if creator_modes <> studio_modes then
    raise exception 'creator and studio allowedQueueModes should be identical: creator=%, studio=%', creator_modes, studio_modes;
  end if;

  -- 'approval' must never appear as a mode, for any tier.
  if free_modes ? 'approval' or pro_modes ? 'approval'
     or creator_modes ? 'approval' or studio_modes ? 'approval' then
    raise exception 'approval must not appear as a queue mode in any tier''s allowedQueueModes';
  end if;

  -- 'pills' must be present from Pro up, and absent at Free.
  if free_modes ? 'pills' then
    raise exception 'free must not have pills';
  end if;
  if not (pro_modes ? 'pills' and creator_modes ? 'pills' and studio_modes ? 'pills') then
    raise exception 'pills must be present at pro, creator and studio';
  end if;

  -- approvalRequired must be exactly as 0080 set it, untouched by 0083.
  if (app_private.tier_entitlement_dimensions('free') ->> 'approvalRequired')::boolean is distinct from false
     or (app_private.tier_entitlement_dimensions('pro') ->> 'approvalRequired')::boolean is distinct from false
     or (app_private.tier_entitlement_dimensions('creator') ->> 'approvalRequired')::boolean is distinct from true
     or (app_private.tier_entitlement_dimensions('studio') ->> 'approvalRequired')::boolean is distinct from true then
    raise exception 'approvalRequired must be untouched: free=false, pro=false, creator=true, studio=true';
  end if;
end
$$;

-- Channel-level: a real published entitlement row (via create_channel,
-- then re-published at each paid tier the same way 0080's own test
-- exercises the publish path) reflects the corrected list, and never
-- carries 'approval' as a mode.
insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001301', 'google-l03-queue-mode-ladder', 'Synthetic Queue Mode Ladder Owner', current_timestamp, current_timestamp);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001301', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000001311',
  '00000000-0000-4000-8000-000000001301', 'queue_mode_ladder_test', 'Queue Mode Ladder Test'
);
commit;

do $$
declare
  published jsonb;
begin
  select values into published
    from channel_entitlement_versions
   where channel_id = '00000000-0000-4000-8000-000000001311'
   order by version desc limit 1;
  if (published -> 'allowedQueueModes') <> '["fifo"]'::jsonb then
    raise exception 'new free channel did not get the corrected free allowedQueueModes: %', published;
  end if;
end
$$;

select app_private.publish_active_individual_entitlement(
  '00000000-0000-4000-8000-000000001311', 'studio', 'sub_l03_queue_mode_ladder', 'monthly', 49900,
  current_timestamp
);

do $$
declare
  published jsonb;
begin
  select values into published
    from channel_entitlement_versions
   where channel_id = '00000000-0000-4000-8000-000000001311'
   order by version desc limit 1;
  if (published -> 'allowedQueueModes') <> '["fifo", "stacked", "pills", "aggregated", "priority"]'::jsonb then
    raise exception 'studio channel did not get the corrected studio allowedQueueModes: %', published;
  end if;
  if (published -> 'allowedQueueModes') ? 'approval' then
    raise exception 'published studio allowedQueueModes must not contain approval: %', published;
  end if;
  if (published ->> 'approvalRequired')::boolean is distinct from true then
    raise exception 'studio approvalRequired must remain true: %', published;
  end if;
end
$$;

-- Global assertion: no channel_entitlement_versions row, at any version,
-- anywhere in the table, has 'approval' in allowedQueueModes.
do $$
declare
  offending_count integer;
begin
  select count(*) into offending_count
    from channel_entitlement_versions
   where values -> 'allowedQueueModes' ? 'approval';
  if offending_count <> 0 then
    raise exception 'found % entitlement version row(s) with approval as a queue mode', offending_count;
  end if;
end
$$;
