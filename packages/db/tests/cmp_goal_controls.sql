-- CMP-21 (0162): goal controls from Companion -- role gate, control-
-- session lease gate, increase-target validation + idempotent retry,
-- start-timer's 'stream'-window restriction, mark-complete's forced
-- early completion (and its interaction with 0150's reopen), and the
-- GOA-21-style structural prepare-not-fire enforcement on
-- companion_goal_control_invocations.
--
-- Uses base_world channel '00000000-0000-4000-8000-000000000011' (owner
-- user 1, admin user 3, operator user 4, moderator user 5, viewer user
-- 6) and channel '...0012' (owner user 2) as a cross-channel probe.
-- This file's own fixture ids (control-session ids) come from this
-- task's reserved block, 00000000-0000-0000-0000-0000000063xx.
\set ON_ERROR_STOP on

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- ---------------------------------------------------------------
-- Classifier: exactly the four-value vocabulary, and only celebration
-- classifies as outbound_or_public.
-- ---------------------------------------------------------------
do $$
begin
  if app_private.companion_goal_control_class('increase_target') <> 'local' then raise exception 'increase_target must classify local'; end if;
  if app_private.companion_goal_control_class('start_timer') <> 'local' then raise exception 'start_timer must classify local'; end if;
  if app_private.companion_goal_control_class('mark_complete') <> 'local' then raise exception 'mark_complete must classify local'; end if;
  if app_private.companion_goal_control_class('trigger_celebration') <> 'outbound_or_public' then raise exception 'trigger_celebration must classify outbound_or_public'; end if;
  if app_private.companion_goal_control_class('nonexistent') is not null then raise exception 'an unknown control type must classify null, not silently local'; end if;
end
$$;

-- ---------------------------------------------------------------
-- Structural GOA-21 equivalent: Postgres itself refuses an
-- outbound_or_public control row with fire_mode = 'fire', regardless of
-- who tries to insert it or how -- this is what makes "a comment is not
-- enforcement; the constraint is" true here too.
-- ---------------------------------------------------------------
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
select app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'Structural check goal', 500000, 'stream', true);

do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Structural check goal';
  begin
    insert into public.companion_goal_control_invocations (id, channel_id, goal_id, actor_user_id, control_type, fire_mode, idempotency_key, created_at)
    values (gen_random_uuid(), '00000000-0000-4000-8000-000000000011', v_goal_id, '00000000-0000-4000-8000-000000000001'::uuid, 'trigger_celebration', 'fire', 'direct-insert-attempt-0001', current_timestamp);
    raise exception 'the database must refuse an outbound_or_public control row with fire_mode = fire';
  exception when check_violation then
    null; -- expected
  end;
  -- 'prepare' is fine for the same control_type.
  insert into public.companion_goal_control_invocations (id, channel_id, goal_id, actor_user_id, control_type, fire_mode, idempotency_key, created_at)
  values (gen_random_uuid(), '00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, '00000000-0000-4000-8000-000000000001'::uuid, 'trigger_celebration', 'prepare', 'direct-insert-attempt-0002', current_timestamp);
end
$$;

-- ---------------------------------------------------------------
-- Role gate: same owner/admin-only bound as every other support-goal
-- mutation (0102/0150). No control session even needs to exist for this
-- to be refused -- the role check runs first.
-- ---------------------------------------------------------------
select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false); -- moderator
do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Structural check goal';
  begin
    perform app_private.increase_support_goal_target('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, '00000000-0000-0000-0000-000000006300'::uuid, 'moderator-attempt-idem-key-01', 600000);
    raise exception 'a moderator must not be able to increase a goal target from Companion';
  exception when others then
    if sqlerrm <> 'not authorized to manage this channel''s support goals' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

-- ---------------------------------------------------------------
-- Lease gate: an owner/admin caller with NO active control session is
-- refused distinctly from a role failure.
-- ---------------------------------------------------------------
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false); -- owner
do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Structural check goal';
  begin
    perform app_private.increase_support_goal_target('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, '00000000-0000-0000-0000-000000006301'::uuid, 'no-lease-attempt-idem-key-01', 600000);
    raise exception 'an owner with no active Companion control session must be refused';
  exception when others then
    if sqlerrm <> 'no active Companion control session for this channel' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

-- Acquire a real lease (owner, channel '...0011', session id from this
-- task's reserved block).
select session_id from app_private.acquire_companion_control_session(
  '00000000-0000-0000-0000-000000006300'::uuid, '00000000-0000-4000-8000-000000000011'::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid, 'web', 'cmp-goal-ctrl-test-session-01', current_timestamp + interval '5 minutes'
);

-- A session leased for a DIFFERENT channel does not authorize this one.
do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Structural check goal';
  begin
    perform app_private.increase_support_goal_target('00000000-0000-4000-8000-000000000012'::uuid, v_goal_id, '00000000-0000-0000-0000-000000006300'::uuid, 'cross-channel-lease-idem-key-01', 600000);
    raise exception 'a lease for another channel must not authorize this one';
  exception when others then
    if sqlerrm not in ('no active Companion control session for this channel', 'not authorized to manage this channel''s support goals', 'support goal not found') then
      raise exception 'unexpected error: %', sqlerrm;
    end if;
  end;
end
$$;

-- ---------------------------------------------------------------
-- Increase target: succeeds with a valid lease; refuses a non-increase;
-- a retry with the SAME idempotency key is a silent no-op, not a second
-- failed validation against the now-updated target.
-- ---------------------------------------------------------------
do $$
declare v_goal_id uuid; v_target bigint;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Structural check goal';

  perform app_private.increase_support_goal_target('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, '00000000-0000-0000-0000-000000006300'::uuid, 'increase-idem-key-0001', 600000);
  select target_amount_paise into v_target from public.support_goals where id = v_goal_id;
  if v_target <> 600000 then raise exception 'target must be 600000 after a valid increase, got %', v_target; end if;

  -- Not an increase (equal to current) -- refused.
  begin
    perform app_private.increase_support_goal_target('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, '00000000-0000-0000-0000-000000006300'::uuid, 'increase-idem-key-0002', 600000);
    raise exception 'a non-increase must be refused';
  exception when others then
    if sqlerrm <> 'the new target must be greater than the current target' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;

  -- Retry of the FIRST call (same idempotency key) after the target has
  -- already moved to 600000 must be a silent no-op, not re-validated
  -- against 600000 (which would otherwise spuriously fail).
  perform app_private.increase_support_goal_target('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, '00000000-0000-0000-0000-000000006300'::uuid, 'increase-idem-key-0001', 600000);
  select target_amount_paise into v_target from public.support_goals where id = v_goal_id;
  if v_target <> 600000 then raise exception 'a retried increase must not change the target again, got %', v_target; end if;
end
$$;

-- ---------------------------------------------------------------
-- Start timer: only for a 'stream'-window goal; moves started_at
-- forward.
-- ---------------------------------------------------------------
select app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'Daily window goal', 200000, 'daily', true);
do $$
declare v_stream_goal_id uuid; v_daily_goal_id uuid; v_before timestamptz; v_after timestamptz;
begin
  select id into v_stream_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Structural check goal';
  select id into v_daily_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Daily window goal';

  select started_at into v_before from public.support_goals where id = v_stream_goal_id;
  perform pg_sleep(0.01);
  perform app_private.start_support_goal_timer('00000000-0000-4000-8000-000000000011'::uuid, v_stream_goal_id, '00000000-0000-0000-0000-000000006300'::uuid, 'start-timer-idem-key-0001');
  select started_at into v_after from public.support_goals where id = v_stream_goal_id;
  if v_after <= v_before then raise exception 'start timer must move started_at forward'; end if;

  begin
    perform app_private.start_support_goal_timer('00000000-0000-4000-8000-000000000011'::uuid, v_daily_goal_id, '00000000-0000-0000-0000-000000006300'::uuid, 'start-timer-idem-key-0002');
    raise exception 'start timer must be refused for a non-stream-window goal';
  exception when others then
    if sqlerrm <> 'start timer only applies to a stream-window support goal' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

-- ---------------------------------------------------------------
-- Mark complete: forces an early completion below target, freezes
-- progress at the moment of the call, and is idempotent -- a natural
-- 100% crossing afterwards (via get_channel_goal_completion's own
-- opportunistic latch) must not create a second active row. Reopen
-- (0150, unmodified) still works on a manually-completed goal.
-- ---------------------------------------------------------------
select app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'Forced complete goal', 1000000, 'open', true);
do $$
declare v_goal_id uuid; v_progress bigint; v_completed_count integer; v_completed_progress bigint;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Forced complete goal';
  v_progress := app_private.support_goal_progress_paise(v_goal_id);
  if v_progress <> 0 then raise exception 'expected zero progress before any payment, got %', v_progress; end if;
  if app_private.support_goal_reached(v_goal_id) then raise exception 'expected this goal to not be naturally reached'; end if;

  perform app_private.manually_complete_support_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, '00000000-0000-0000-0000-000000006300'::uuid, 'mark-complete-idem-key-0001');

  select count(*), max(completed_progress_paise) into v_completed_count, v_completed_progress
    from public.support_goal_completions where goal_id = v_goal_id and status = 'completed';
  if v_completed_count <> 1 then raise exception 'expected exactly one active completion row, got %', v_completed_count; end if;
  if v_completed_progress <> 0 then raise exception 'completed_progress_paise must freeze at the live progress (0) at the moment of the call, got %', v_completed_progress; end if;

  -- Idempotent retry with a DIFFERENT idempotency key must still be a
  -- no-op (only one active completion row ever).
  perform app_private.manually_complete_support_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, '00000000-0000-0000-0000-000000006300'::uuid, 'mark-complete-idem-key-0002');
  select count(*) into v_completed_count from public.support_goal_completions where goal_id = v_goal_id and status = 'completed';
  if v_completed_count <> 1 then raise exception 'a second manual-complete call must not create a second active completion row, got %', v_completed_count; end if;

  -- The existing, unmodified 0150 reopen path still works on this row.
  perform app_private.reopen_support_goal_completion('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'testing reopen after a manual complete');
  select count(*) into v_completed_count from public.support_goal_completions where goal_id = v_goal_id and status = 'completed';
  if v_completed_count <> 0 then raise exception 'reopen must clear the active completion row, got % still active', v_completed_count; end if;
end
$$;

-- ---------------------------------------------------------------
-- Trigger celebration: always recorded as fire_mode = 'prepare', never
-- 'fire', through the real function (not the direct-insert probe above).
-- ---------------------------------------------------------------
do $$
declare v_goal_id uuid; v_fire_mode text; v_class text;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Forced complete goal';
  perform app_private.prepare_support_goal_celebration('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, '00000000-0000-0000-0000-000000006300'::uuid, 'celebration-idem-key-0001');
  select fire_mode into v_fire_mode from public.companion_goal_control_invocations
   where channel_id = '00000000-0000-4000-8000-000000000011' and idempotency_key = 'celebration-idem-key-0001';
  if v_fire_mode <> 'prepare' then raise exception 'trigger_celebration must always be recorded as prepare, got %', v_fire_mode; end if;
  v_class := app_private.companion_goal_control_class('trigger_celebration');
  if v_class <> 'outbound_or_public' then raise exception 'unexpected classification %', v_class; end if;
end
$$;

select 'CMP_GOAL_CONTROLS=PASS' as result;
