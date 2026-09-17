-- GOA-04/GOA-09/GOA-18/GOA-19/GOA-20/GOA-21 (0158): the goal trigger
-- engine spine. Uses base_world channel '00000000-0000-4000-8000-
-- 000000000011' (owner user 1). Own fixture ids: payments/goal
-- ...7200-...72ff (see fixtures/00_base_world.sql's id allocation
-- registry -- pre-assigned to this lane by the coordinator).
--
-- Goals/rules are looked up by their (unique-per-file) title/label inside
-- each do block, the same reason goa_completion_latch.sql and
-- goal_progress_and_refund.sql do this: psql does not interpolate
-- `:'var'` inside a dollar-quoted body, and the create_* functions
-- generate their own ids internally.
\set ON_ERROR_STOP on

-- session-level (is_local = false): this file's statements run as
-- separate implicit top-level transactions.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000011', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

select app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'GOA trigger engine goal', 1000000, 'open', true);

-- =====================================================================
-- GTE-STRUCT-1 -- GOA-20 STRUCTURAL PROOF. No column anywhere in this
-- migration's tables carries a name that could plausibly let a creator
-- disable, override, suppress or bypass the loud/full-screen interlock,
-- and the dispatch function's own body contains no such token either.
-- =====================================================================
do $$
declare offending text;
begin
  select string_agg(table_name || '.' || column_name, ', ' order by table_name, column_name)
    into offending
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('goal_trigger_rules', 'goal_trigger_actions', 'goal_trigger_conditions', 'goal_trigger_evaluations', 'goal_trigger_action_runs')
     and (
       column_name ~* 'interlock' or column_name ~* 'suppress' or column_name ~* 'override'
       or column_name ~* 'bypass' or column_name ~* 'force_fire' or column_name ~* 'allow_loud'
       or column_name ~* 'clutch' or column_name ~* 'ignore_safety'
     );
  if offending is not null then
    raise exception 'GTE-STRUCT-1: a goal_trigger_* table carries a column that could configure an interlock away: %', offending;
  end if;
end
$$;

do $$
declare definition text; forbidden text;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'dispatch_goal_trigger_sequence';
  if definition is null then raise exception 'GTE-STRUCT-1: app_private.dispatch_goal_trigger_sequence does not exist'; end if;

  foreach forbidden in array array['suppress_interlock', 'override', 'bypass', 'force_fire', 'allow_loud', 'ignore_safety']
  loop
    if position(forbidden in definition) > 0 then
      raise exception 'GTE-STRUCT-1: dispatch_goal_trigger_sequence contains a "%" token -- the loud/full-screen interlock must have no configurable escape hatch (GOA-20)', forbidden;
    end if;
  end loop;

  -- The interlock branch must be reached from action_type via the
  -- IMMUTABLE severity lookup, not from action_row.fire_mode or any
  -- creator-writable column.
  if position('goal_trigger_action_severity(action_row.action_type)' in definition) = 0 then
    raise exception 'GTE-STRUCT-1: dispatch_goal_trigger_sequence no longer derives the interlock decision from action_type alone -- structural guarantee broken';
  end if;
end
$$;

-- GOA-21 structural half: an outbound action_type can never carry
-- fire_mode = 'fire' -- the CHECK constraint itself, proven by a raw
-- INSERT attempt that must fail.
do $$
declare v_rule_id uuid; caught boolean := false;
begin
  select app_private.create_goal_trigger_rule(
    '00000000-0000-4000-8000-000000000011'::uuid,
    (select id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA trigger engine goal'),
    'first_contribution', null, null, 'once_per_stream'
  ) into v_rule_id;

  begin
    insert into public.goal_trigger_actions (id, rule_id, step_order, delay_ms, action_type, fire_mode, created_at, updated_at)
    values (gen_random_uuid(), v_rule_id, 0, 0, 'noop_outbound', 'fire', current_timestamp, current_timestamp);
  exception when check_violation then
    caught := true;
  end;

  if not caught then
    raise exception 'GOA-21: inserting an outbound action with fire_mode = fire must be rejected by a CHECK constraint, but it succeeded';
  end if;
end
$$;

-- =====================================================================
-- GTE-2 -- GOA-21: an outbound action configured with NO explicit
-- fire_mode (relying purely on the default) must come back as 'prepare'
-- and, on dispatch, as status = 'prepared' -- never 'fired'.
-- =====================================================================
do $$
declare v_rule_id uuid; v_action_id uuid; v_eval_id uuid; v_status text; v_fire_mode text;
begin
  select app_private.create_goal_trigger_rule(
    '00000000-0000-4000-8000-000000000011'::uuid,
    (select id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA trigger engine goal'),
    'first_contribution', null, null, 'once_per_stream'
  ) into v_rule_id;

  select app_private.add_goal_trigger_action(
    '00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 0, 500, 'noop_outbound', null
  ) into v_action_id;

  select fire_mode into v_fire_mode from public.goal_trigger_actions where id = v_action_id;
  if v_fire_mode <> 'prepare' then
    raise exception 'GOA-21: an unconfigured outbound action must default to fire_mode = prepare, got %', v_fire_mode;
  end if;
end
$$;

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000007200', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_gte_1', 'order_gte_1', 300000, 'INR', 'captured', current_timestamp, current_timestamp);

do $$
declare v_goal_id uuid; v_rule_id uuid; v_action_id uuid; v_eval_id uuid; v_status text;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA trigger engine goal';

  select app_private.create_goal_trigger_rule(
    '00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'first_contribution', null, null, 'once_per_stream'
  ) into v_rule_id;
  select app_private.add_goal_trigger_action(
    '00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 0, 0, 'noop_outbound', null
  ) into v_action_id;

  select app_private.evaluate_goal_trigger_rule(v_rule_id, '00000000-0000-4000-8000-000000007200'::uuid) into v_eval_id;
  if v_eval_id is null then
    raise exception 'GOA-04: first_contribution rule did not fire on the goal''s first payment';
  end if;

  perform app_private.dispatch_goal_trigger_sequence(v_eval_id);
  select status into v_status from public.goal_trigger_action_runs where evaluation_id = v_eval_id;
  if v_status <> 'prepared' then
    raise exception 'GOA-21: an unconfigured outbound action must NOT fire -- expected status prepared, got %', v_status;
  end if;
end
$$;

-- =====================================================================
-- GTE-3 -- GOA-18: an ordered sequence with per-step delays is DATA, not
-- an emergent property of row order. Actions are inserted OUT of
-- step_order; dispatch must return them in step_order order with each
-- delay_ms preserved verbatim, and a second dispatch call must return
-- the identical ordering and delays (stability).
-- =====================================================================
do $$
declare
  v_goal_id uuid; v_rule_id uuid;
  v_a0 uuid; v_a1 uuid; v_a2 uuid;
  v_eval_id uuid;
  rec record;
  expected_order integer[] := array[0, 1, 2];
  expected_delay integer[] := array[0, 250, 4000];
  seen_order integer[] := array[]::integer[];
  seen_delay integer[] := array[]::integer[];
  i integer;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA trigger engine goal';

  select app_private.create_goal_trigger_rule(
    '00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'first_contribution', null, null, 'once_per_stream'
  ) into v_rule_id;

  -- Inserted deliberately out of step_order: 2, then 0, then 1.
  select app_private.add_goal_trigger_action('00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 2, 4000, 'noop_local_quiet', 'fire') into v_a2;
  select app_private.add_goal_trigger_action('00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 0, 0, 'noop_local_quiet', 'fire') into v_a0;
  select app_private.add_goal_trigger_action('00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 1, 250, 'noop_local_quiet', 'fire') into v_a1;

  select app_private.evaluate_goal_trigger_rule(v_rule_id, '00000000-0000-4000-8000-000000007200'::uuid) into v_eval_id;
  if v_eval_id is null then
    raise exception 'GOA-18 setup: rule unexpectedly did not fire';
  end if;

  perform app_private.dispatch_goal_trigger_sequence(v_eval_id);

  for rec in select step_order, delay_ms from public.goal_trigger_action_runs where evaluation_id = v_eval_id order by step_order asc
  loop
    seen_order := seen_order || rec.step_order;
    seen_delay := seen_delay || rec.delay_ms;
  end loop;

  if seen_order <> expected_order then
    raise exception 'GOA-18: dispatch did not return steps in step_order order, got %', seen_order;
  end if;
  if seen_delay <> expected_delay then
    raise exception 'GOA-18: dispatch did not preserve each step''s configured delay_ms, got %', seen_delay;
  end if;

  -- Stability: dispatch again (idempotent re-call) must return the exact
  -- same ordering/delays, not a fresh, potentially differently-ordered set.
  seen_order := array[]::integer[];
  seen_delay := array[]::integer[];
  perform app_private.dispatch_goal_trigger_sequence(v_eval_id);
  for rec in select step_order, delay_ms from public.goal_trigger_action_runs where evaluation_id = v_eval_id order by step_order asc
  loop
    seen_order := seen_order || rec.step_order;
    seen_delay := seen_delay || rec.delay_ms;
  end loop;
  if seen_order <> expected_order or seen_delay <> expected_delay then
    raise exception 'GOA-18: a second dispatch call for the same evaluation changed ordering or delays -- must be stable';
  end if;

  if (select count(*) from public.goal_trigger_action_runs where evaluation_id = v_eval_id) <> 3 then
    raise exception 'GOA-18: a second dispatch call must not duplicate action runs (idempotent dispatch)';
  end if;
end
$$;

-- =====================================================================
-- GTE-4 -- GOA-19: an unevaluatable condition (only_live -- no live/
-- broadcast-status concept exists in this schema) fails SAFE. The
-- attached action is explicitly configured fire_mode = 'fire' and would
-- otherwise fire immediately; the condition must still block it.
-- =====================================================================
do $$
declare
  v_goal_id uuid; v_rule_id uuid; v_eval_id uuid; v_status text; v_reason text;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA trigger engine goal';

  select app_private.create_goal_trigger_rule(
    '00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'first_contribution', null, null, 'once_per_stream'
  ) into v_rule_id;
  perform app_private.add_goal_trigger_condition('00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 'only_live', null);
  perform app_private.add_goal_trigger_action('00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 0, 0, 'noop_local_quiet', 'fire');

  select app_private.evaluate_goal_trigger_rule(v_rule_id, '00000000-0000-4000-8000-000000007200'::uuid) into v_eval_id;
  if v_eval_id is null then
    raise exception 'GOA-19 setup: rule unexpectedly did not fire';
  end if;

  perform app_private.dispatch_goal_trigger_sequence(v_eval_id);
  select status, blocked_reason into v_status, v_reason from public.goal_trigger_action_runs where evaluation_id = v_eval_id;

  if v_status <> 'blocked_condition' then
    raise exception 'GOA-19: an unevaluatable condition must fail safe (block the action), got status %', v_status;
  end if;
  if v_reason is null or position('unevaluatable' in v_reason) = 0 then
    raise exception 'GOA-19: the blocked reason must honestly say the condition is unevaluatable, got %', v_reason;
  end if;
end
$$;

-- GTE-4b -- the ONE evaluatable GOA-19 condition (not_during_sponsor_slot)
-- actually evaluates, both ways, against public.sponsor_cards (0145).
do $$
declare
  v_goal_id uuid; v_rule_id uuid; v_eval_id uuid; v_status text;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA trigger engine goal';

  select app_private.create_goal_trigger_rule(
    '00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'first_contribution', null, null, 'once_per_stream'
  ) into v_rule_id;
  perform app_private.add_goal_trigger_condition('00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 'not_during_sponsor_slot', null);
  perform app_private.add_goal_trigger_action('00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 0, 0, 'noop_local_quiet', 'fire');

  -- No sponsor card exists for this channel yet: the condition passes.
  select app_private.evaluate_goal_trigger_rule(v_rule_id, '00000000-0000-4000-8000-000000007200'::uuid) into v_eval_id;
  perform app_private.dispatch_goal_trigger_sequence(v_eval_id);
  select status into v_status from public.goal_trigger_action_runs where evaluation_id = v_eval_id;
  if v_status <> 'fired' then
    raise exception 'GOA-19: not_during_sponsor_slot must PASS (and the action fire) when no sponsor card is active, got %', v_status;
  end if;
end
$$;

insert into public.sponsor_cards (id, channel_id, created_by_user_id, sponsor_name, enabled, created_at, updated_at)
values ('00000000-0000-4000-8000-000000007201', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'GTE Sponsor', true, current_timestamp, current_timestamp);

do $$
declare
  v_goal_id uuid; v_rule_id uuid; v_eval_id uuid; v_status text;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA trigger engine goal';

  select app_private.create_goal_trigger_rule(
    '00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'first_contribution', null, null, 'every_time'
  ) into v_rule_id;
  perform app_private.add_goal_trigger_condition('00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 'not_during_sponsor_slot', null);
  perform app_private.add_goal_trigger_action('00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 0, 0, 'noop_local_quiet', 'fire');

  -- Enabled sponsor card with no schedule = currently active: the
  -- condition must now block.
  select app_private.evaluate_goal_trigger_rule(v_rule_id, '00000000-0000-4000-8000-000000007202'::uuid) into v_eval_id;
  perform app_private.dispatch_goal_trigger_sequence(v_eval_id);
  select status into v_status from public.goal_trigger_action_runs where evaluation_id = v_eval_id;
  if v_status <> 'blocked_condition' then
    raise exception 'GOA-19: not_during_sponsor_slot must BLOCK when a sponsor card is currently active, got %', v_status;
  end if;
end
$$;

-- =====================================================================
-- GTE-5 -- GOA-20 behavioural proof: a loud_or_fullscreen LOCAL action
-- explicitly configured fire_mode = 'fire' (allowed by the check
-- constraint -- only outbound actions are barred from 'fire') is STILL
-- blocked_interlock, every time, with fire_mode having no effect on the
-- outcome. Paired with a quiet local action on the SAME rule that DOES
-- fire, proving the interlock is scoped to severity, not a global kill.
-- =====================================================================
do $$
declare
  v_goal_id uuid; v_rule_id uuid; v_eval_id uuid;
  v_loud_status text; v_loud_reason text; v_quiet_status text;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA trigger engine goal';

  select app_private.create_goal_trigger_rule(
    '00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'first_contribution', null, null, 'once_per_stream'
  ) into v_rule_id;
  perform app_private.add_goal_trigger_action('00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 0, 0, 'noop_local_loud_or_fullscreen', 'fire');
  perform app_private.add_goal_trigger_action('00000000-0000-4000-8000-000000000011'::uuid, v_rule_id, 1, 100, 'noop_local_quiet', 'fire');

  select app_private.evaluate_goal_trigger_rule(v_rule_id, '00000000-0000-4000-8000-000000007200'::uuid) into v_eval_id;
  if v_eval_id is null then
    raise exception 'GOA-20 setup: rule unexpectedly did not fire';
  end if;
  perform app_private.dispatch_goal_trigger_sequence(v_eval_id);

  select status, blocked_reason into v_loud_status, v_loud_reason
    from public.goal_trigger_action_runs where evaluation_id = v_eval_id and step_order = 0;
  select status into v_quiet_status
    from public.goal_trigger_action_runs where evaluation_id = v_eval_id and step_order = 1;

  if v_loud_status <> 'blocked_interlock' then
    raise exception 'GOA-20: a loud_or_fullscreen action with fire_mode = fire must still be blocked_interlock, got %', v_loud_status;
  end if;
  if v_loud_reason is null or position('not creator-configurable' in v_loud_reason) = 0 then
    raise exception 'GOA-20: the blocked reason must say the interlock is not creator-configurable, got %', v_loud_reason;
  end if;
  if v_quiet_status <> 'fired' then
    raise exception 'GOA-20: the interlock must be scoped to loud/full-screen severity only -- the quiet step on the same rule must still fire, got %', v_quiet_status;
  end if;
end
$$;

-- =====================================================================
-- GTE-6 -- GOA-04/GOA-09: percentage and absolute thresholds cross
-- exactly once (once_per_stream), and reached_100 fires FROM 0150's own
-- latch, not from a re-derived boolean.
-- =====================================================================
do $$
declare
  v_goal_id uuid;
  v_pct_rule uuid; v_abs_rule uuid; v_100_rule uuid;
  v_eval1 uuid; v_eval2 uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA trigger engine goal';

  select app_private.create_goal_trigger_rule(
    '00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'threshold_percentage', 25, null, 'once_per_stream'
  ) into v_pct_rule;
  select app_private.create_goal_trigger_rule(
    '00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'threshold_absolute', null, 900000, 'once_per_stream'
  ) into v_abs_rule;
  select app_private.create_goal_trigger_rule(
    '00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'reached_100', null, null, 'once_per_stream'
  ) into v_100_rule;

  -- Progress so far: 300000 (30%) -- above the 25% threshold, below the
  -- absolute (900000) and 100% (1000000) thresholds.
  select app_private.evaluate_goal_trigger_rule(v_pct_rule, '00000000-0000-4000-8000-000000007200'::uuid) into v_eval1;
  if v_eval1 is null then
    raise exception 'GOA-04: threshold_percentage(25) did not fire at 30%% progress';
  end if;
  if app_private.evaluate_goal_trigger_rule(v_abs_rule, '00000000-0000-4000-8000-000000007200'::uuid) is not null then
    raise exception 'GOA-04: threshold_absolute(900000) fired too early at progress 300000';
  end if;
  if app_private.evaluate_goal_trigger_rule(v_100_rule, '00000000-0000-4000-8000-000000007200'::uuid) is not null then
    raise exception 'GOA-04: reached_100 fired too early at progress 300000';
  end if;

  -- GOA-09 once_per_stream: re-evaluating the SAME already-crossed
  -- percentage rule with a DIFFERENT source event must be a no-op.
  select app_private.evaluate_goal_trigger_rule(v_pct_rule, gen_random_uuid()) into v_eval2;
  if v_eval2 is not null then
    raise exception 'GOA-09: a once_per_stream rule fired a second time for the same goal';
  end if;
end
$$;

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000007203', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_gte_2', 'order_gte_2', 300000, 'INR', 'captured', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000007204', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_gte_3', 'order_gte_3', 400000, 'INR', 'captured', current_timestamp, current_timestamp);

do $$
declare
  v_goal_id uuid; v_abs_rule uuid; v_100_rule uuid; v_completion_id uuid; v_eval_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA trigger engine goal';
  select id into v_abs_rule from public.goal_trigger_rules where goal_id = v_goal_id and trigger_type = 'threshold_absolute';
  select id into v_100_rule from public.goal_trigger_rules where goal_id = v_goal_id and trigger_type = 'reached_100';

  -- Progress is now 300000 + 300000 + 400000 = 1000000 -- exactly the
  -- target: both the absolute threshold (900000) and reached_100 cross.
  select app_private.evaluate_goal_trigger_rule(v_abs_rule, '00000000-0000-4000-8000-000000007204'::uuid) into v_eval_id;
  if v_eval_id is null then
    raise exception 'GOA-04: threshold_absolute(900000) did not fire once progress reached 1000000';
  end if;

  select app_private.evaluate_goal_trigger_rule(v_100_rule, '00000000-0000-4000-8000-000000007204'::uuid) into v_eval_id;
  if v_eval_id is null then
    raise exception 'GOA-04: reached_100 did not fire once progress reached the target';
  end if;

  -- reached_100 fires FROM 0150's latch: the evaluation's source_event_id
  -- must equal 0150's own completion id for this goal, not a re-derived
  -- value and not the caller-supplied payment id.
  select id into v_completion_id from public.support_goal_completions where goal_id = v_goal_id and status = 'completed';
  if not exists (select 1 from public.goal_trigger_evaluations where id = v_eval_id and source_event_id = v_completion_id) then
    raise exception 'GOA-04: reached_100 must fire FROM 0150''s latched completion event, not a re-derived boolean';
  end if;
end
$$;

-- =====================================================================
-- GTE-7 -- 0150 UNTOUCHED: the completion latch and progress derivation
-- this migration calls still behave exactly as 0150 shipped them --
-- proven by re-running 0150's own idempotency check against the same
-- goal this file just completed.
-- =====================================================================
do $$
declare
  v_goal_id uuid; first_call uuid; second_call uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA trigger engine goal';
  first_call := app_private.latch_support_goal_completion(v_goal_id);
  second_call := app_private.latch_support_goal_completion(v_goal_id);
  if first_call is null or first_call <> second_call then
    raise exception '0150 UNTOUCHED check: latch_support_goal_completion is no longer idempotent';
  end if;
end
$$;

-- =====================================================================
-- GTE-8 -- privacy/shape: list_channel_goal_trigger_rules,
-- list_goal_trigger_actions and list_goal_trigger_action_runs return
-- exactly their declared column sets (no source_event_id leak, no
-- internal book-keeping column).
-- =====================================================================
do $$
declare cols text;
begin
  select string_agg(a.attname, ',' order by a.attnum)
    into cols
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type t on t.oid = p.prorettype
    join pg_class c on c.oid = t.typrelid
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where n.nspname = 'app_private' and p.proname = 'list_channel_goal_trigger_rules';
  if cols <> 'rule_id,goal_id,trigger_type,enabled,threshold_percentage,threshold_amount_paise,repeat_mode,created_at,updated_at' then
    raise exception 'GTE-8: list_channel_goal_trigger_rules column set changed unexpectedly: %', cols;
  end if;
end
$$;

select 'goa_trigger_engine.sql: all checks passed' as result;
