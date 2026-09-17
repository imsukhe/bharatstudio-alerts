-- CMP-20 (0162): scene presets -- fixed six-name enum, upsert-on-first-
-- configure (never pre-seeded, never a free-text name), owner/admin-only
-- write, any-member read, ordered OBS-action steps restricted to the
-- four existing companion.ts 'obs' group verbs, and the "resolution"
-- read raising not-found rather than silently returning zero rows for a
-- missing/foreign preset.
--
-- Uses base_world channel '00000000-0000-4000-8000-000000000011' (owner
-- user 1, admin user 3, moderator user 5, viewer user 6).
\set ON_ERROR_STOP on

-- Invalid preset name is refused (only the six S5.2 names exist).
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
do $$
begin
  begin
    perform app_private.upsert_companion_scene_preset('00000000-0000-4000-8000-000000000011'::uuid, 'not_a_real_preset');
    raise exception 'an unrecognised preset name must be refused';
  exception when others then
    if sqlerrm <> 'invalid scene preset' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

-- A moderator cannot configure a preset.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
do $$
begin
  begin
    perform app_private.upsert_companion_scene_preset('00000000-0000-4000-8000-000000000011'::uuid, 'gameplay');
    raise exception 'a moderator must not be able to configure a scene preset';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s scene presets' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

-- An admin (not just the owner) can configure one, and configuring the
-- SAME name again is a no-op that returns the SAME id (never a second
-- row -- unique(channel_id, preset_name) plus the upsert's own
-- on-conflict-update-id-stays-the-same shape).
select set_config('app.user_id', '00000000-0000-4000-8000-000000000003', false); -- admin
do $$
declare v_id_1 uuid; v_id_2 uuid; v_count integer;
begin
  select app_private.upsert_companion_scene_preset('00000000-0000-4000-8000-000000000011'::uuid, 'gameplay') into v_id_1;
  select app_private.upsert_companion_scene_preset('00000000-0000-4000-8000-000000000011'::uuid, 'gameplay') into v_id_2;
  if v_id_1 <> v_id_2 then raise exception 'configuring the same preset name twice must return the same id'; end if;
  select count(*) into v_count from public.companion_scene_presets where channel_id = '00000000-0000-4000-8000-000000000011' and preset_name = 'gameplay';
  if v_count <> 1 then raise exception 'expected exactly one gameplay preset row, got %', v_count; end if;
end
$$;

-- Owner configures the other five names -- all six fit under the
-- unique(channel_id, preset_name) constraint with no separate cap
-- (see migration 0162 header, "NO INVENTED CAP").
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false); -- owner
select app_private.upsert_companion_scene_preset('00000000-0000-4000-8000-000000000011'::uuid, 'just_chatting');
select app_private.upsert_companion_scene_preset('00000000-0000-4000-8000-000000000011'::uuid, 'brb');
select app_private.upsert_companion_scene_preset('00000000-0000-4000-8000-000000000011'::uuid, 'sponsor');
select app_private.upsert_companion_scene_preset('00000000-0000-4000-8000-000000000011'::uuid, 'vertical');
select app_private.upsert_companion_scene_preset('00000000-0000-4000-8000-000000000011'::uuid, 'ending');

do $$
declare v_count integer;
begin
  select count(*) into v_count from app_private.list_channel_scene_presets('00000000-0000-4000-8000-000000000011'::uuid);
  if v_count <> 6 then raise exception 'expected all six scene presets configured, got %', v_count; end if;
end
$$;

-- A viewer can read the list (broader read than write, same shape every
-- other channel-config table in this schema already uses).
select set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false); -- viewer
do $$
declare v_count integer;
begin
  select count(*) into v_count from app_private.list_channel_scene_presets('00000000-0000-4000-8000-000000000011'::uuid);
  if v_count <> 6 then raise exception 'a viewer must still be able to read the channel''s scene preset list, got %', v_count; end if;
end
$$;

-- Adding an action step: restricted to the four existing OBS verbs, no
-- new one accepted; a moderator cannot add a step; an out-of-channel
-- preset id is not found (not leaked as a different error).
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false); -- owner
do $$
declare v_preset_id uuid;
begin
  select id into v_preset_id from public.companion_scene_presets where channel_id = '00000000-0000-4000-8000-000000000011' and preset_name = 'gameplay';

  begin
    perform app_private.add_companion_scene_preset_action('00000000-0000-4000-8000-000000000011'::uuid, v_preset_id, 0, 'obs_invent_a_verb', 'Gameplay Scene');
    raise exception 'an unrecognised OBS verb must be refused';
  exception when others then
    if sqlerrm <> 'invalid scene preset action' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;

  perform app_private.add_companion_scene_preset_action('00000000-0000-4000-8000-000000000011'::uuid, v_preset_id, 0, 'obs_set_scene', 'Gameplay Scene');
  perform app_private.add_companion_scene_preset_action('00000000-0000-4000-8000-000000000011'::uuid, v_preset_id, 1, 'obs_toggle_source', 'Webcam');
  perform app_private.add_companion_scene_preset_action('00000000-0000-4000-8000-000000000011'::uuid, v_preset_id, 2, 'obs_toggle_mute', 'Mic');

  -- A duplicate step_order on the same preset is refused by the unique
  -- index, the same "append, never upsert a step" idiom 0158 uses.
  begin
    perform app_private.add_companion_scene_preset_action('00000000-0000-4000-8000-000000000011'::uuid, v_preset_id, 0, 'obs_set_transition', 'Cut');
    raise exception 'a duplicate step_order on the same preset must be refused';
  exception when unique_violation then
    null; -- expected
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false); -- moderator
do $$
declare v_preset_id uuid;
begin
  select id into v_preset_id from public.companion_scene_presets where channel_id = '00000000-0000-4000-8000-000000000011' and preset_name = 'gameplay';
  begin
    perform app_private.add_companion_scene_preset_action('00000000-0000-4000-8000-000000000011'::uuid, v_preset_id, 3, 'obs_set_transition', 'Cut');
    raise exception 'a moderator must not be able to add a scene preset action';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s scene presets' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

-- Resolution: the ordered action list, in step_order -- and raises
-- (never silently empty) for a foreign/missing preset.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false); -- owner
do $$
declare v_preset_id uuid; v_types text[]; v_labels text[];
begin
  select id into v_preset_id from public.companion_scene_presets where channel_id = '00000000-0000-4000-8000-000000000011' and preset_name = 'gameplay';

  select array_agg(action_type order by step_order), array_agg(target_label order by step_order)
    into v_types, v_labels
    from app_private.list_companion_scene_preset_actions('00000000-0000-4000-8000-000000000011'::uuid, v_preset_id);

  if v_types <> array['obs_set_scene', 'obs_toggle_source', 'obs_toggle_mute'] then
    raise exception 'unexpected resolved action_type order: %', v_types;
  end if;
  if v_labels <> array['Gameplay Scene', 'Webcam', 'Mic'] then
    raise exception 'unexpected resolved target_label order: %', v_labels;
  end if;

  begin
    perform * from app_private.list_companion_scene_preset_actions('00000000-0000-4000-8000-000000000011'::uuid, gen_random_uuid());
    raise exception 'a nonexistent preset id must raise, not return zero rows silently';
  exception when others then
    if sqlerrm <> 'scene preset not found' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

-- A cross-channel owner (channel '...0012') gets the same non-leaking
-- refusal reading channel '...0011''s presets.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false); -- owner of ...0012
do $$
begin
  begin
    perform app_private.upsert_companion_scene_preset('00000000-0000-4000-8000-000000000011'::uuid, 'ending');
    raise exception 'a non-member must not be able to configure another channel''s scene preset';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s scene presets' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

select 'CMP_SCENE_PRESETS=PASS' as result;
