-- GOA-01/GOA-02/GOA-03 (0150): goal completion is a latched, audited event,
-- never a second copy of the derived "reached" calculation. Uses base_world
-- channel '00000000-0000-4000-8000-000000000011' (owner user 1, viewer user
-- 6) and 'creator' tier for goal-count headroom, same shape as
-- goal_progress_and_refund.sql. Own fixture ids: payments/refunds
-- ...5f01-...5f04 (see fixtures/00_base_world.sql's id allocation registry --
-- ...5f00-...5fff is this file's own block, verified unused by grep before
-- use).
--
-- Goals are looked up by their (unique-per-file) title inside each do block,
-- same reason goal_progress_and_refund.sql does this: psql does NOT
-- interpolate `:'var'` inside a dollar-quoted body, and create_support_goal
-- generates its own id internally.
\set ON_ERROR_STOP on

-- session-level (is_local = false): this file's statements run as separate
-- implicit top-level transactions, and a local GUC would vanish after the
-- first one.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000011', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

select app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'GOA latch goal', 1000000, 'open', true);

-- =====================================================================
-- GOA-01 -- the latch is idempotent: crossing the target, and a retried
-- write, both produce exactly one completed row and the same identity.
-- =====================================================================
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000006a01', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_goa_1', 'order_goa_1', 600000, 'INR', 'captured', current_timestamp, current_timestamp);

do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA latch goal';

  -- Below target (progress 600000 < target 1000000): the latch must not fire.
  if app_private.latch_support_goal_completion(v_goal_id) is not null then
    raise exception 'latch fired before progress reached the target';
  end if;
end
$$;

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000006a02', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_goa_2', 'order_goa_2', 400000, 'INR', 'captured', current_timestamp, current_timestamp);

do $$
declare v_goal_id uuid; first_call uuid; second_call uuid; completed_rows integer;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA latch goal';

  -- (progress is exactly 1000000 == target after the inserts above)
  first_call := app_private.latch_support_goal_completion(v_goal_id);
  second_call := app_private.latch_support_goal_completion(v_goal_id);

  if first_call is null then
    raise exception 'latch did not fire once progress reached the target';
  end if;
  if first_call <> second_call then
    raise exception 'GOA-01: calling the latch twice must return the SAME completion id, got % then %', first_call, second_call;
  end if;

  select count(*) into completed_rows from public.support_goal_completions where goal_id = v_goal_id and status = 'completed';
  if completed_rows <> 1 then
    raise exception 'GOA-01: calling the latch twice must produce exactly one completed row, got %', completed_rows;
  end if;
end
$$;

-- =====================================================================
-- GOA-02 -- a processed refund reduces live progress (support_goal_
-- progress_paise, completely unmodified by 0150) but must NEVER un-write
-- the completion: completed_at and completed_progress_paise stay exactly
-- as first written, and `completed` stays true.
-- =====================================================================
insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000006a03', '00000000-0000-4000-8000-000000006a01', 'rfnd_goa_1', 600000, 'processed', current_timestamp, current_timestamp);

update payments set status = 'refunded' where id = '00000000-0000-4000-8000-000000006a01';

do $$
declare
  v_goal_id uuid;
  before_completed_at timestamptz;
  before_progress bigint;
  after_row record;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA latch goal';
  select completed_at into before_completed_at from public.support_goal_completions where goal_id = v_goal_id and status = 'completed';

  -- PROGRESS STAYS DERIVED: the refund drops it below target immediately,
  -- proving 0102's live-recomputation is untouched by this migration.
  before_progress := app_private.support_goal_progress_paise(v_goal_id);
  if before_progress <> 400000 then
    raise exception 'expected live progress to drop to 400000 after the refund (proves progress is still derived, not frozen), got %', before_progress;
  end if;
  if app_private.support_goal_reached(v_goal_id) then
    raise exception 'the OLD derived reached-flag is expected to flip back to false after a refund -- that is the pre-existing, unchanged 0102 behaviour this migration deliberately does not touch';
  end if;

  select * into after_row from app_private.get_channel_goal_completion('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);

  if after_row.completed is not true then
    raise exception 'GOA-02: a refund must never un-complete a goal -- completed flipped to false after the refund';
  end if;
  if after_row.completed_at <> before_completed_at then
    raise exception 'GOA-02: the completion record must not be rewritten by a refund -- completed_at changed from % to %', before_completed_at, after_row.completed_at;
  end if;
  if after_row.completed_progress_paise <> 1000000 then
    raise exception 'GOA-02: completed_progress_paise must stay frozen at the value observed when the latch fired (1000000), got %', after_row.completed_progress_paise;
  end if;
  if after_row.progress_paise <> 400000 then
    raise exception 'GOA-02: the completion read must still surface LIVE progress next to the frozen completion (400000 after the refund), got %', after_row.progress_paise;
  end if;
end
$$;

-- =====================================================================
-- GOA-03 -- manual reopen is explicit, reason-required and audited; never
-- automatic, never a side effect of a refund or of any read above.
-- =====================================================================

-- Not authorized: a viewer cannot reopen a completion. Nothing changes.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);
do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA latch goal';
  begin
    perform app_private.reopen_support_goal_completion('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'a viewer should never be able to do this');
    raise exception 'a viewer must not be able to reopen a completion';
  exception when sqlstate '42501' then
    null; -- expected
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

-- Reason required: null, empty and whitespace-only are all rejected, and
-- the completion row is untouched by every rejected attempt.
do $$
declare v_goal_id uuid; before_status text; after_status text; bad_reason text;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA latch goal';
  select status into before_status from public.support_goal_completions where goal_id = v_goal_id and status = 'completed';

  foreach bad_reason in array array[null, '', '   ']::text[]
  loop
    begin
      perform app_private.reopen_support_goal_completion('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, bad_reason);
      raise exception 'GOA-03: a reopen with reason % must be rejected', coalesce(quote_literal(bad_reason), 'NULL');
    exception when sqlstate '22023' then
      null; -- expected
    end;
  end loop;

  -- an over-long reason (501 chars) is also rejected
  begin
    perform app_private.reopen_support_goal_completion('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, repeat('x', 501));
    raise exception 'GOA-03: a 501-character reopen reason must be rejected';
  exception when sqlstate '22023' then
    null; -- expected
  end;

  select status into after_status from public.support_goal_completions where goal_id = v_goal_id and status = 'completed';
  if after_status is distinct from before_status then
    raise exception 'a rejected reopen attempt must not change the completion row';
  end if;
end
$$;

-- A goal that has never been completed cannot be reopened.
select app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'GOA never-completed goal', 5000000, 'open', true);
do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA never-completed goal';
  begin
    perform app_private.reopen_support_goal_completion('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'nothing to reopen');
    raise exception 'a goal that was never completed must not be reopenable';
  exception when sqlstate '22023' then
    null; -- expected
  end;
end
$$;

-- The successful, audited reopen.
do $$
declare v_goal_id uuid; row_after record; audit_actor uuid; audit_reason text;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA latch goal';

  perform app_private.reopen_support_goal_completion('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'refunded almost everything; reopening for a fresh push');

  select reopened_by_user_id, reopen_reason into audit_actor, audit_reason
    from public.support_goal_completions
   where goal_id = v_goal_id and status = 'reopened';

  if audit_actor <> '00000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'GOA-03: the reopen must be audited against the ACTING user, got %', audit_actor;
  end if;
  if audit_reason <> 'refunded almost everything; reopening for a fresh push' then
    raise exception 'GOA-03: the exact reopen reason must be persisted, got %', audit_reason;
  end if;

  select * into row_after from app_private.get_channel_goal_completion('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);
  if row_after.completed is not false then
    raise exception 'a reopened goal must read as not-completed';
  end if;
  if row_after.last_reopened_by_user_id <> '00000000-0000-4000-8000-000000000001'::uuid or row_after.last_reopen_reason <> 'refunded almost everything; reopening for a fresh push' then
    raise exception 'the completion read must surface who reopened it and why';
  end if;

  -- Reopening again with no active completion is rejected -- it is not a
  -- toggle.
  begin
    perform app_private.reopen_support_goal_completion('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id, 'trying to reopen an already-reopened goal');
    raise exception 'reopening an already-reopened (not currently completed) goal must be rejected';
  exception when sqlstate '22023' then
    null; -- expected
  end;
end
$$;

-- APPEND-ONLY HISTORY: crossing the target again after a manual reopen
-- creates a SECOND, NEW completed row -- the original 'reopened' row is
-- never deleted or rewritten. Full history survives.
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000006a04', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_goa_3', 'order_goa_3', 600000, 'INR', 'captured', current_timestamp, current_timestamp);

do $$
declare v_goal_id uuid; new_completion uuid; original_completion uuid; total_rows integer;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA latch goal';
  select id into original_completion from public.support_goal_completions where goal_id = v_goal_id and status = 'reopened';

  new_completion := app_private.latch_support_goal_completion(v_goal_id);
  if new_completion is null then
    raise exception 'expected a new completion once progress re-crossed the target after a reopen';
  end if;
  if new_completion = original_completion then
    raise exception 'a re-completion after a manual reopen must be a NEW row, not a rewrite of the reopened one';
  end if;

  select count(*) into total_rows from public.support_goal_completions where goal_id = v_goal_id;
  if total_rows <> 2 then
    raise exception 'append-only history: expected exactly 2 rows for this goal (one reopened, one newly completed), got %', total_rows;
  end if;
end
$$;

-- =====================================================================
-- Authorization / not-found parity: a non-member reading a channel's goal
-- completion gets the same not-found answer a wrong channel id would --
-- never a distinguishing error that would leak channel existence.
-- =====================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA latch goal';
  begin
    perform app_private.get_channel_goal_completion('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);
    raise exception 'a non-member must not be able to read this channel''s goal completion';
  exception when sqlstate 'P0002' then
    null; -- expected
  end;
end
$$;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

-- =====================================================================
-- Privacy as a property of the query: the completion read's declared
-- result type is asserted exactly, AND the actual columns returned by a
-- live call are asserted exactly via information_schema.columns -- same
-- double-check shape prf02_slice6_lobby_status.sql uses. Neither a
-- payment id nor a refund id is ever part of this read's shape.
-- =====================================================================
do $$
declare declared_result text;
begin
  select pg_catalog.pg_get_function_result(p.oid)
    into declared_result
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'get_channel_goal_completion';

  if declared_result is null then raise exception 'app_private.get_channel_goal_completion does not exist'; end if;
  if declared_result <> 'TABLE(goal_id uuid, completed boolean, completed_at timestamp with time zone, completed_progress_paise bigint, target_amount_paise_at_completion bigint, progress_paise bigint, target_amount_paise bigint, last_reopened_at timestamp with time zone, last_reopened_by_user_id uuid, last_reopen_reason text)' then
    raise exception 'the goal completion read''s declared result type changed unexpectedly: %', declared_result;
  end if;
end
$$;

create temporary table goa_completion_returned_shape as
  select * from app_private.get_channel_goal_completion(
    '00000000-0000-4000-8000-000000000011'::uuid,
    (select id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'GOA latch goal')
  );

do $$
declare actual_columns text;
begin
  select string_agg(column_name, ', ' order by ordinal_position)
    into actual_columns
    from information_schema.columns
   where table_name = 'goa_completion_returned_shape';

  if actual_columns <> 'goal_id, completed, completed_at, completed_progress_paise, target_amount_paise_at_completion, progress_paise, target_amount_paise, last_reopened_at, last_reopened_by_user_id, last_reopen_reason' then
    raise exception 'the columns actually returned by a live call changed unexpectedly, got "%"', actual_columns;
  end if;
  if actual_columns like '%payment%' or actual_columns like '%refund%' then
    raise exception 'the goal completion read must never surface a payment or refund identifier';
  end if;
end
$$;

select 'GOA_COMPLETION_LATCH=PASS' as result;
