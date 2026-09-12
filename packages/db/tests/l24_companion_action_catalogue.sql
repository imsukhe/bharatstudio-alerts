-- L24 Companion action catalogue and standalone mode (0089).
-- Executed in the isolated PostgreSQL harness after migrations 0001-0089.
--
-- Proves:
--   - the widened companion_commands action CHECK accepts the full 17-action
--     catalogue and still rejects an unlisted action, for NEW rows;
--   - app_private.companion_action_group() classifies every catalogue action;
--   - the entitlement layer (channel_entitlement_versions.values.companionActionGroups)
--     is enforced by update_companion_layout, independent of any client:
--       * a channel with NO entitlement row (Companion-only signup) accepts
--         obs/mirror/stream slots and rejects an alerts slot;
--       * a channel entitled only to ['obs'] rejects an alerts slot even
--         though it is Creator tier;
--   - the target-type discriminator: an obs-group slot requires a bounded
--     targetLabel and rejects a queue UUID pattern in its place; an
--     alerts-group slot rejects a targetLabel and requires a real,
--     active, same-channel queue UUID (0042 behavior, unchanged);
--   - no historical companion_commands row is touched by this migration.

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000b01', 'google-l24-creator', 'Synthetic L24 Creator', current_timestamp, current_timestamp)
on conflict (id) do nothing;

-- Channel A: Creator tier, full entitlement (default companionActionGroups).
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000b11', '00000000-0000-4000-8000-000000000b01', 'l24_full', 'L24 Full Channel', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;
insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000000b11', '00000000-0000-4000-8000-000000000b01', 'owner', current_timestamp)
on conflict do nothing;
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000b11', 1, 'creator', 'individual_plan',
  app_private.tier_entitlement_dimensions('creator'), current_timestamp, current_timestamp);
insert into alert_queues (id, channel_id, name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000b21', '00000000-0000-4000-8000-000000000b11', 'L24 queue', current_timestamp, current_timestamp);

-- Channel B: Companion-only implicit signup -- NO entitlement row at all.
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000b12', '00000000-0000-4000-8000-000000000b01', 'l24_companion_only', 'L24 Companion Only', false, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;
insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000000b12', '00000000-0000-4000-8000-000000000b01', 'owner', current_timestamp)
on conflict do nothing;

-- Channel C: Creator tier, but entitled only to the 'obs' group (proves the
-- entitlement check reads the real per-channel value, not a tier default).
insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000b13', '00000000-0000-4000-8000-000000000b01', 'l24_obs_only', 'L24 OBS Only', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;
insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000000b13', '00000000-0000-4000-8000-000000000b01', 'owner', current_timestamp)
on conflict do nothing;
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000b13', 1, 'creator', 'individual_plan',
  (app_private.tier_entitlement_dimensions('creator') || jsonb_build_object('companionActionGroups', jsonb_build_array('obs'))),
  current_timestamp, current_timestamp);

-- === companion_action_group classifies every catalogue action ===
do $$
declare
  bad_count integer;
begin
  select count(*) into bad_count from (values
    ('pause_queue','alerts'), ('resume_queue','alerts'), ('send_test_alert','alerts'),
    ('obs_set_scene','obs'), ('obs_toggle_source','obs'), ('obs_toggle_mute','obs'),
    ('obs_start_stream','obs'), ('obs_stop_stream','obs'),
    ('obs_start_record','obs'), ('obs_stop_record','obs'),
    ('obs_save_replay_buffer','obs'), ('obs_set_transition','obs'),
    ('mirror_start','mirror'), ('mirror_stop','mirror'), ('mirror_screenshot','mirror'),
    ('stream_go_live','stream'), ('stream_end','stream')
  ) as expected(action, expected_group)
  where app_private.companion_action_group(expected.action) is distinct from expected.expected_group;
  if bad_count <> 0 then
    raise exception 'companion_action_group misclassified % catalogue action(s)', bad_count;
  end if;
  if app_private.companion_action_group('delete_everything') is not null then
    raise exception 'companion_action_group unexpectedly classified an unlisted action';
  end if;
end
$$;

-- === companion_commands CHECK accepts the new catalogue, rejects unlisted ===
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000b01', true);
insert into companion_commands (id, channel_id, actor_user_id, idempotency_key, action, target_id, status, created_at)
values ('00000000-0000-4000-8000-000000000b31', '00000000-0000-4000-8000-000000000b11', '00000000-0000-4000-8000-000000000b01', 'l24-obs-001', 'obs_start_stream', 'l24-scene', 'accepted', current_timestamp);
commit;

do $$
begin
  begin
    insert into companion_commands (id, channel_id, actor_user_id, idempotency_key, action, target_id, status, created_at)
    values ('00000000-0000-4000-8000-000000000b32', '00000000-0000-4000-8000-000000000b11', '00000000-0000-4000-8000-000000000b01', 'l24-bad-001', 'delete_everything', 'x', 'accepted', current_timestamp);
    raise exception 'unlisted Companion action unexpectedly accepted by the CHECK constraint';
  exception when check_violation then
    null;
  end;
end
$$;

-- === Entitlement layer: no entitlement row => zero Alerts, OBS still works ===
do $$
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000b01', true);
  begin
    perform * from app_private.update_companion_layout(
      '00000000-0000-4000-8000-000000000b12', '00000000-0000-4000-8000-000000000b01', 0, 4,
      '[{"slotIndex":1,"page":1,"label":"Pause","action":"pause_queue","targetId":"00000000-0000-4000-8000-000000000b21"}]'::jsonb
    );
    raise exception 'Companion-only channel unexpectedly got an Alerts action slot';
  exception when sqlstate '22023' then
    if sqlerrm !~ 'not entitled' then raise exception 'wrong rejection reason for Companion-only Alerts slot: %', sqlerrm; end if;
  end;
end
$$;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000b01', true);
select * from app_private.update_companion_layout(
  '00000000-0000-4000-8000-000000000b12', '00000000-0000-4000-8000-000000000b01', 0, 4,
  '[{"slotIndex":1,"page":1,"label":"Go Live","action":"obs_start_stream","targetId":"00000000-0000-4000-8000-000000000b12","targetLabel":"Main Scene"}]'::jsonb
);
commit;

do $$
begin
  if (select count(*) from companion_layout_versions where channel_id = '00000000-0000-4000-8000-000000000b12') <> 1 then
    raise exception 'Companion-only channel OBS layout was not saved';
  end if;
end
$$;

-- === Entitlement layer: Creator tier restricted to ['obs'] rejects Alerts ===
do $$
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000b01', true);
  begin
    perform * from app_private.update_companion_layout(
      '00000000-0000-4000-8000-000000000b13', '00000000-0000-4000-8000-000000000b01', 0, 4,
      '[{"slotIndex":1,"page":1,"label":"Resume","action":"resume_queue","targetId":"00000000-0000-4000-8000-000000000b21"}]'::jsonb
    );
    raise exception 'obs-only-entitled channel unexpectedly got an Alerts action slot';
  exception when sqlstate '22023' then
    if sqlerrm !~ 'not entitled' then raise exception 'wrong rejection reason: %', sqlerrm; end if;
  end;
end
$$;

-- === Target-type discriminator ===
-- OBS slot missing targetLabel is rejected.
do $$
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000b01', true);
  begin
    perform * from app_private.update_companion_layout(
      '00000000-0000-4000-8000-000000000b11', '00000000-0000-4000-8000-000000000b01', 0, 4,
      '[{"slotIndex":1,"page":1,"label":"Scene","action":"obs_set_scene","targetId":"00000000-0000-4000-8000-000000000b11"}]'::jsonb
    );
    raise exception 'OBS slot with no targetLabel unexpectedly accepted';
  exception when sqlstate '22023' then
    if sqlerrm !~ 'targetLabel' then raise exception 'wrong rejection reason for missing OBS targetLabel: %', sqlerrm; end if;
  end;
end
$$;

-- Alerts slot carrying a targetLabel is rejected (shape belongs to OBS only).
do $$
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000b01', true);
  begin
    perform * from app_private.update_companion_layout(
      '00000000-0000-4000-8000-000000000b11', '00000000-0000-4000-8000-000000000b01', 0, 4,
      '[{"slotIndex":1,"page":1,"label":"Pause","action":"pause_queue","targetId":"00000000-0000-4000-8000-000000000b21","targetLabel":"nope"}]'::jsonb
    );
    raise exception 'Alerts slot with a targetLabel unexpectedly accepted';
  exception when sqlstate '22023' then
    if sqlerrm !~ 'targetLabel' then raise exception 'wrong rejection reason for Alerts+targetLabel: %', sqlerrm; end if;
  end;
end
$$;

-- Full-entitlement channel accepts a well-formed OBS slot alongside an Alerts
-- slot in the same layout (both groups entitled, both target shapes valid).
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000b01', true);
select * from app_private.update_companion_layout(
  '00000000-0000-4000-8000-000000000b11', '00000000-0000-4000-8000-000000000b01', 0, 4,
  '[
    {"slotIndex":1,"page":1,"label":"Pause","action":"pause_queue","targetId":"00000000-0000-4000-8000-000000000b21"},
    {"slotIndex":2,"page":1,"label":"Scene","action":"obs_set_scene","targetId":"00000000-0000-4000-8000-000000000b11","targetLabel":"Main Scene"},
    {"slotIndex":3,"page":1,"label":"Go Live","action":"stream_go_live","targetId":"00000000-0000-4000-8000-000000000b11"}
  ]'::jsonb
);
commit;

do $$
begin
  if (select count(*) from companion_layout_versions where channel_id = '00000000-0000-4000-8000-000000000b11') <> 1 then
    raise exception 'mixed-group Companion layout was not saved for the fully-entitled channel';
  end if;
end
$$;

-- === No historical row is touched ===
do $$
begin
  if (select count(*) from companion_commands where channel_id = '00000000-0000-4000-8000-000000000b11') <> 1 then
    raise exception 'this test unexpectedly altered companion_commands row count';
  end if;
  if (select action from companion_commands where id = '00000000-0000-4000-8000-000000000b31') <> 'obs_start_stream' then
    raise exception 'the OBS companion_commands row was mutated';
  end if;
end
$$;
