-- L16 (0102): role gating (viewer/moderator cannot manage goals) and the
-- hidden per-tier goal-count entitlement (Free 1 / Pro 3, per master plan
-- Part 7 §7.6). Uses base_world channel '...0011' (owner 1/admin 3/
-- operator 4/moderator 5/viewer 6) and channel '...0012' (owner 2, used as
-- a cross-channel probe). See goal_progress_and_refund.sql's file header
-- for why goal ids are looked up by title rather than \gset inside do
-- blocks.
\set ON_ERROR_STOP on

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', 1, 'pro', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- A viewer cannot create a support goal on the channel they view.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);
do $$
begin
  begin
    perform app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'Viewer attempt', 100000, 'open', true);
    raise exception 'a viewer must not be able to create a support goal';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s support goals' then
      raise exception 'unexpected error for viewer create: %', sqlerrm;
    end if;
  end;
end
$$;

-- A moderator cannot create one either.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
do $$
begin
  begin
    perform app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'Moderator attempt', 100000, 'open', true);
    raise exception 'a moderator must not be able to create a support goal';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s support goals' then
      raise exception 'unexpected error for moderator create: %', sqlerrm;
    end if;
  end;
end
$$;

-- An admin (not just the owner) CAN create one, and can then edit it — the
-- gate is role-based, not owner-only.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000003', false);
select app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'Admin-managed goal', 5000000, 'open', true);

do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Admin-managed goal';
  if v_goal_id is null then raise exception 'admin create did not land a row'; end if;
  perform app_private.update_support_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'Renamed by admin', null);
end
$$;

-- A moderator cannot edit (or end) the admin's goal, even though a
-- moderator CAN read the channel's goal list (broader read, narrow write).
select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
do $$
declare v_goal_id uuid; goal_count integer;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Renamed by admin';

  select count(*) into goal_count from app_private.list_channel_goals('00000000-0000-4000-8000-000000000011'::uuid);
  if goal_count < 1 then
    raise exception 'a moderator must still be able to read the channel''s goal list';
  end if;

  begin
    perform app_private.update_support_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'Moderator rename attempt', null);
    raise exception 'a moderator must not be able to update a support goal';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s support goals' then
      raise exception 'unexpected error for moderator update: %', sqlerrm;
    end if;
  end;

  begin
    perform app_private.end_support_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);
    raise exception 'a moderator must not be able to end a support goal';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s support goals' then
      raise exception 'unexpected error for moderator end: %', sqlerrm;
    end if;
  end;
end
$$;

-- A non-member (owner of the OTHER base_world channel) gets the same
-- "not authorized" refusal against channel '...0011' — no cross-channel
-- goal creation.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
do $$
begin
  begin
    perform app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'Cross-channel attempt', 100000, 'open', true);
    raise exception 'a non-member (another channel''s owner) must not be able to create a support goal here';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s support goals' then
      raise exception 'unexpected error for cross-channel create: %', sqlerrm;
    end if;
  end;
end
$$;

-- Free tier (channel '...0011', limit 1): the owner already has one
-- active goal from earlier in this file ("Renamed by admin", still
-- active/not ended) — wait, the admin-created goal above was created
-- while the channel's published tier was 'free' (limit 1), so it already
-- consumed the free-tier's entire goal allowance. A second goal on this
-- still-free channel must be refused with the tier-limit message, not a
-- generic authorization failure.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
do $$
begin
  begin
    perform app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'Second free-tier goal', 100000, 'open', true);
    raise exception 'a free-tier channel already at its 1-goal limit must not be able to create a second one';
  exception when others then
    if sqlerrm <> 'support goal limit reached for the channel''s current tier' then
      raise exception 'unexpected error for free-tier limit: %', sqlerrm;
    end if;
  end;
end
$$;

-- Pro tier (channel '...0012', limit 3): three goals succeed, a fourth is
-- refused with the same tier-limit message.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
select app_private.create_support_goal('00000000-0000-4000-8000-000000000012'::uuid, 'Pro goal 1', 100000, 'open', true);
select app_private.create_support_goal('00000000-0000-4000-8000-000000000012'::uuid, 'Pro goal 2', 100000, 'open', true);
select app_private.create_support_goal('00000000-0000-4000-8000-000000000012'::uuid, 'Pro goal 3', 100000, 'open', true);

do $$
begin
  begin
    perform app_private.create_support_goal('00000000-0000-4000-8000-000000000012'::uuid, 'Pro goal 4', 100000, 'open', true);
    raise exception 'a Pro-tier channel at its 3-goal limit must not be able to create a 4th';
  exception when others then
    if sqlerrm <> 'support goal limit reached for the channel''s current tier' then
      raise exception 'unexpected error for Pro-tier limit: %', sqlerrm;
    end if;
  end;
end
$$;

-- Ending one of the three frees a slot — the limit counts LIVE (non-ended)
-- goals, not goals ever created.
do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000012' and title = 'Pro goal 1';
  perform app_private.end_support_goal('00000000-0000-4000-8000-000000000012'::uuid, v_goal_id);
  perform app_private.create_support_goal('00000000-0000-4000-8000-000000000012'::uuid, 'Pro goal 5 (after ending one)', 100000, 'open', true);
end
$$;

-- An ended goal cannot be edited.
do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000012' and title = 'Pro goal 1';
  begin
    perform app_private.update_support_goal('00000000-0000-4000-8000-000000000012'::uuid, v_goal_id, 'Cannot rename', null);
    raise exception 'an ended goal must not be editable';
  exception when others then
    if sqlerrm <> 'an ended support goal cannot be edited' then
      raise exception 'unexpected error editing an ended goal: %', sqlerrm;
    end if;
  end;
end
$$;

select 'GOAL_ROLE_AND_ENTITLEMENT=PASS' as result;
