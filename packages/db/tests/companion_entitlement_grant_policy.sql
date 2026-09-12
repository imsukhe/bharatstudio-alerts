-- L24 Companion entitlement separation (0100).
-- Executed in the isolated PostgreSQL harness after migrations 0001-0100.
--
-- Proves:
--   1. Backwards compatibility: every Alerts tier's companion_grant_policy
--      matches today's pre-0100 numbers exactly (8/16/32/64, all four
--      groups) -- nobody loses anything on the day this ships.
--   2. A Companion-only channel (no Alerts entitlement row at all) is
--      granted Companion (obs/mirror/stream) and zero Alerts actions,
--      sourced from the 'standalone' policy row, not from an accidental
--      free-tier coincidence.
--   3. Flipping the Alerts-plan -> Companion grant is a plain UPDATE to
--      companion_grant_policies, with no migration and no per-channel data
--      touch: a Free-tier channel's OBS access disappears the instant the
--      'alerts:free' row is flipped off, and comes back the instant it is
--      flipped back.
--   4. The two-layer gate still rejects unentitled and inactive actions
--      correctly -- only the entitlement SOURCE changed.
--   5. A per-channel channel_entitlement_versions.values.companionActionGroups
--      override (0089) still wins over the tier default (unchanged).

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000c01', 'google-l24-sep-creator', 'Synthetic L24-Sep Creator', current_timestamp, current_timestamp)
on conflict (id) do nothing;

-- === 1. Backwards compatibility: policy numbers match today's exactly ===
do $$
declare
  bad_count integer;
begin
  select count(*) into bad_count from (values
    ('alerts:free', 8), ('alerts:pro', 16), ('alerts:creator', 32), ('alerts:studio', 64)
  ) as expected(source_key, expected_limit)
  join companion_grant_policies policy on policy.source_key = expected.source_key
  where policy.action_limit <> expected.expected_limit
     or policy.granted is not true
     or policy.action_groups <> '["alerts", "obs", "mirror", "stream"]'::jsonb;
  if bad_count <> 0 then
    raise exception '% Alerts-tier companion_grant_policies row(s) do not match pre-0100 behavior', bad_count;
  end if;
  if not exists (
    select 1 from companion_grant_policies
     where source_key = 'standalone' and granted and action_limit = 8
       and action_groups = '["obs", "mirror", "stream"]'::jsonb
  ) then
    raise exception 'standalone companion_grant_policies row does not match today''s NO_ALERTS_ENTITLED_GROUPS default';
  end if;
end
$$;

-- Channel Free: Free-tier Alerts, default entitlement (no per-channel
-- companionActionGroups override).
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000c01', 'l24sep_free', 'L24-Sep Free Channel', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;
insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000c01', 'owner', current_timestamp)
on conflict do nothing;
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000c11', 1, 'free', 'individual_plan',
  app_private.tier_entitlement_dimensions('free'), current_timestamp, current_timestamp);
insert into alert_queues (id, channel_id, name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000c21', '00000000-0000-4000-8000-000000000c11', 'L24-Sep queue', current_timestamp, current_timestamp);

-- Channel Studio: Studio tier, proves the 64-slot ceiling still applies.
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000c12', '00000000-0000-4000-8000-000000000c01', 'l24sep_studio', 'L24-Sep Studio Channel', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;
insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000000c12', '00000000-0000-4000-8000-000000000c01', 'owner', current_timestamp)
on conflict do nothing;
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000c12', 1, 'studio', 'individual_plan',
  app_private.tier_entitlement_dimensions('studio'), current_timestamp, current_timestamp);

-- Channel Standalone: Companion-only implicit signup -- NO entitlement row.
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000c13', '00000000-0000-4000-8000-000000000c01', 'l24sep_standalone', 'L24-Sep Standalone Channel', false, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;
insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000000c13', '00000000-0000-4000-8000-000000000c01', 'owner', current_timestamp)
on conflict do nothing;

-- === companion_grant_policy resolves the right row for each channel ===
do $$
declare rec record;
begin
  select * into rec from app_private.companion_grant_policy('00000000-0000-4000-8000-000000000c11');
  if rec.source_key <> 'alerts:free' or rec.action_limit <> 8 or not (rec.action_groups ? 'alerts') then
    raise exception 'Free channel resolved to wrong companion_grant_policy: %', rec;
  end if;

  select * into rec from app_private.companion_grant_policy('00000000-0000-4000-8000-000000000c12');
  if rec.source_key <> 'alerts:studio' or rec.action_limit <> 64 then
    raise exception 'Studio channel resolved to wrong companion_grant_policy: %', rec;
  end if;

  select * into rec from app_private.companion_grant_policy('00000000-0000-4000-8000-000000000c13');
  if rec.source_key <> 'standalone' or rec.action_limit <> 8 or (rec.action_groups ? 'alerts') or not (rec.action_groups ? 'obs') then
    raise exception 'Standalone channel resolved to wrong companion_grant_policy: %', rec;
  end if;
end
$$;

-- === 2. Companion-only channel: Companion actions yes, Alerts actions zero ===
do $$
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
  begin
    perform * from app_private.update_companion_layout(
      '00000000-0000-4000-8000-000000000c13', '00000000-0000-4000-8000-000000000c01', 0, 4,
      '[{"slotIndex":1,"page":1,"label":"Pause","action":"pause_queue","targetId":"00000000-0000-4000-8000-000000000c21"}]'::jsonb
    );
    raise exception 'standalone channel unexpectedly got an Alerts action slot';
  exception when sqlstate '22023' then
    if sqlerrm !~ 'not entitled' then raise exception 'wrong rejection reason for standalone Alerts slot: %', sqlerrm; end if;
  end;
end
$$;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
select * from app_private.update_companion_layout(
  '00000000-0000-4000-8000-000000000c13', '00000000-0000-4000-8000-000000000c01', 0, 4,
  '[{"slotIndex":1,"page":1,"label":"Go Live","action":"obs_start_stream","targetId":"00000000-0000-4000-8000-000000000c13","targetLabel":"Main Scene"}]'::jsonb
);
commit;

do $$
begin
  if (select count(*) from companion_layout_versions where channel_id = '00000000-0000-4000-8000-000000000c13') <> 1 then
    raise exception 'standalone channel OBS layout was not saved';
  end if;
end
$$;

-- === 3. Flip is data, not schema: unbundle Companion from alerts:free ===
-- Before the flip: Free channel can save an OBS slot (its default policy
-- includes 'obs').
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
select * from app_private.update_companion_layout(
  '00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000c01', 0, 4,
  '[{"slotIndex":1,"page":1,"label":"Scene","action":"obs_set_scene","targetId":"00000000-0000-4000-8000-000000000c11","targetLabel":"Main Scene"}]'::jsonb
);
commit;
do $$
begin
  if (select count(*) from companion_layout_versions where channel_id = '00000000-0000-4000-8000-000000000c11') <> 1 then
    raise exception 'Free channel OBS layout was not saved before the flip';
  end if;
end
$$;

-- The flip itself: one UPDATE, no ALTER, no new migration file, touches no
-- channel_entitlement_versions row.
update companion_grant_policies set granted = false where source_key = 'alerts:free';

-- After the flip: same channel, same tier, same entitlement row -- now
-- rejected, because the row was flipped, not because anything about the
-- channel changed.
do $$
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
  begin
    perform * from app_private.update_companion_layout(
      '00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000c01', 1, 4,
      '[{"slotIndex":1,"page":1,"label":"Mute","action":"obs_toggle_mute","targetId":"00000000-0000-4000-8000-000000000c11","targetLabel":"Mic"}]'::jsonb
    );
    raise exception 'Free channel unexpectedly kept OBS access after alerts:free was unbundled';
  exception when sqlstate '22023' then
    if sqlerrm !~ 'not entitled' then raise exception 'wrong rejection reason after unbundling: %', sqlerrm; end if;
  end;
end
$$;

-- Flip back: proves the reverse direction is equally a plain UPDATE.
update companion_grant_policies set granted = true where source_key = 'alerts:free';
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
select * from app_private.update_companion_layout(
  '00000000-0000-4000-8000-000000000c11', '00000000-0000-4000-8000-000000000c01', 1, 4,
  '[{"slotIndex":1,"page":1,"label":"Mute","action":"obs_toggle_mute","targetId":"00000000-0000-4000-8000-000000000c11","targetLabel":"Mic"}]'::jsonb
);
commit;
do $$
begin
  if (select count(*) from companion_layout_versions where channel_id = '00000000-0000-4000-8000-000000000c11') <> 2 then
    raise exception 'Free channel did not regain OBS access after re-bundling';
  end if;
end
$$;

-- === 4. Two-layer gate: entitled-but-inactive is still a separate failure
--    mode from not-entitled (activation, 0093, untouched by this migration).
--    A page-size/slot-count request beyond the tier ceiling is still
--    rejected the same way it always was (Studio ceiling = 64).
do $$
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
  begin
    perform * from app_private.update_companion_layout(
      '00000000-0000-4000-8000-000000000c12', '00000000-0000-4000-8000-000000000c01', 0, 16,
      '[{"slotIndex":65,"page":5,"label":"Over","action":"obs_start_record","targetId":"00000000-0000-4000-8000-000000000c12","targetLabel":"x"}]'::jsonb
    );
    raise exception 'Studio channel unexpectedly accepted a slot beyond its 64-slot ceiling';
  exception when sqlstate '22023' then
    if sqlerrm !~ 'outside the tier/page allocation' then raise exception 'wrong rejection reason for over-ceiling slot: %', sqlerrm; end if;
  end;
end
$$;

-- === 5. Per-channel override (0089) still wins over the tier default ===
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000c14', '00000000-0000-4000-8000-000000000c01', 'l24sep_override', 'L24-Sep Override Channel', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;
insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000000c14', '00000000-0000-4000-8000-000000000c01', 'owner', current_timestamp)
on conflict do nothing;
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000c14', 1, 'studio', 'individual_plan',
  (app_private.tier_entitlement_dimensions('studio') || jsonb_build_object('companionActionGroups', jsonb_build_array('obs'))),
  current_timestamp, current_timestamp);

do $$
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000c01', true);
  begin
    perform * from app_private.update_companion_layout(
      '00000000-0000-4000-8000-000000000c14', '00000000-0000-4000-8000-000000000c01', 0, 4,
      '[{"slotIndex":1,"page":1,"label":"Resume","action":"resume_queue","targetId":"00000000-0000-4000-8000-000000000c21"}]'::jsonb
    );
    raise exception 'Studio channel with an obs-only override unexpectedly got an Alerts action slot';
  exception when sqlstate '22023' then
    if sqlerrm !~ 'not entitled' then raise exception 'wrong rejection reason for overridden channel: %', sqlerrm; end if;
  end;
end
$$;
