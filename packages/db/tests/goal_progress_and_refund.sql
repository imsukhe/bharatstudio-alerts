-- L16 (0102): support goal progress is derived from real payments only,
-- and a refund reduces it live. Uses base_world channel
-- '00000000-0000-4000-8000-000000000011' (owner user 1). Own fixture ids:
-- payments/refunds ...1701-...1712 (see fixtures/00_base_world.sql's id
-- allocation registry — next free block was ...1701 upward).
--
-- Goals are looked up by their (unique-per-file) title inside each do
-- block rather than captured via psql's \gset — psql does NOT interpolate
-- `:'var'` inside a dollar-quoted (`do $$ ... $$`) body (confirmed by
-- direct repro against this suite's postgres:16-alpine image), and
-- create_support_goal generates its own id internally (gen_random_uuid()),
-- so there is no fixed literal id to hardcode the way other files in this
-- suite do for their own pre-assigned fixture ids.
\set ON_ERROR_STOP on

-- session-level (is_local = false), not transaction-local: this file's
-- statements run as separate implicit top-level transactions (no explicit
-- begin/commit), and a local GUC would vanish after the first one.
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

-- base_world seeds channels/memberships only, not an entitlement version —
-- create_support_goal needs the channel's current tier to resolve its
-- goal-count limit. 'creator' (limit 10) gives this file headroom for the
-- several goals it creates.
insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000011', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- A stream-window goal with no payments yet has zero progress.
select app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'Zero-state goal', 500000, 'stream', true);

do $$
declare v_goal_id uuid; progress bigint;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Zero-state goal';
  progress := app_private.support_goal_progress_paise(v_goal_id);
  if progress <> 0 then
    raise exception 'a goal with no payments must have zero progress, got %', progress;
  end if;
  if app_private.support_goal_reached(v_goal_id) then
    raise exception 'a zero-progress goal must not read as reached';
  end if;
end
$$;

-- Two captured payments inside the goal's window move progress; a payment
-- BEFORE the goal started must never count.
select app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'Progress goal', 1000000, 'open', true);

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001701', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_goal_before', 'order_goal_before', 900000, 'INR', 'captured', current_timestamp - interval '1 hour', current_timestamp - interval '1 hour'),
  ('00000000-0000-4000-8000-000000001702', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_goal_1', 'order_goal_1', 300000, 'INR', 'captured', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001703', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_goal_2', 'order_goal_2', 200000, 'INR', 'captured', current_timestamp, current_timestamp);

do $$
declare v_goal_id uuid; progress bigint;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Progress goal';
  progress := app_private.support_goal_progress_paise(v_goal_id);
  if progress <> 500000 then
    raise exception 'progress must be the sum of captured payments inside the window only (500000), got %; a payment created before the goal started must never count', progress;
  end if;
  if app_private.support_goal_reached(v_goal_id) then
    raise exception 'progress (500000) is below target (1000000) — must not read as reached';
  end if;
end
$$;

-- A processed refund against one of the counted payments reduces progress
-- immediately, on the very next read — no separate write path exists.
insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001704', '00000000-0000-4000-8000-000000001702', 'rfnd_goal_1', 300000, 'processed', current_timestamp, current_timestamp);

update payments set status = 'refunded' where id = '00000000-0000-4000-8000-000000001702';

do $$
declare v_goal_id uuid; progress bigint;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Progress goal';
  progress := app_private.support_goal_progress_paise(v_goal_id);
  if progress <> 200000 then
    raise exception 'a processed refund must reduce progress live (expected 200000 after refunding pay_goal_1), got %', progress;
  end if;
end
$$;

-- A merely-'requested' (not yet processed) refund must NOT reduce progress
-- — only a processed refund is real money leaving.
insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001705', '00000000-0000-4000-8000-000000001703', 'rfnd_goal_2', 200000, 'requested', current_timestamp, current_timestamp);

do $$
declare v_goal_id uuid; progress bigint;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Progress goal';
  progress := app_private.support_goal_progress_paise(v_goal_id);
  if progress <> 200000 then
    raise exception 'a merely-requested refund must not move progress (expected still 200000), got %', progress;
  end if;
end
$$;

-- Reaching (and exceeding) the target flips the derived reached flag,
-- purely from real payment totals — never from a stored status value.
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001706', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_goal_3', 'order_goal_3', 900000, 'INR', 'captured', current_timestamp, current_timestamp);

do $$
declare v_goal_id uuid; progress bigint; reached boolean;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Progress goal';
  progress := app_private.support_goal_progress_paise(v_goal_id);
  reached := app_private.support_goal_reached(v_goal_id);
  if progress <> 1100000 then
    raise exception 'expected progress 1100000 after the third payment, got %', progress;
  end if;
  if not reached then
    raise exception 'progress (1100000) exceeds target (1000000) — must read as reached';
  end if;
end
$$;

-- A daily-window goal only counts payments inside today's UTC calendar
-- day; a payment dated yesterday must not count even though it is well
-- after the goal's own started_at.
select app_private.create_support_goal('00000000-0000-4000-8000-000000000011'::uuid, 'Daily goal', 100000, 'daily', true);

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001707', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_goal_yesterday', 'order_goal_yesterday', 500000, 'INR', 'captured', date_trunc('day', current_timestamp) - interval '2 hours', date_trunc('day', current_timestamp) - interval '2 hours'),
  ('00000000-0000-4000-8000-000000001708', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_goal_today', 'order_goal_today', 50000, 'INR', 'captured', current_timestamp, current_timestamp);

do $$
declare v_goal_id uuid; progress bigint;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Daily goal';
  progress := app_private.support_goal_progress_paise(v_goal_id);
  if progress <> 50000 then
    raise exception 'a daily-window goal must only count today''s payments (expected 50000), got %', progress;
  end if;
end
$$;

-- Ending a goal freezes its window: a payment made after ended_at must
-- never count, even though the channel keeps receiving tips.
do $$
declare v_goal_id uuid;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Daily goal';
  perform app_private.end_support_goal('00000000-0000-4000-8000-000000000011'::uuid, v_goal_id);
end
$$;

insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001709', '00000000-0000-4000-8000-000000000011', 'razorpay', 'pay_goal_after_end', 'order_goal_after_end', 900000, 'INR', 'captured', current_timestamp, current_timestamp);

do $$
declare v_goal_id uuid; progress bigint;
begin
  select id into v_goal_id from public.support_goals where channel_id = '00000000-0000-4000-8000-000000000011' and title = 'Daily goal';
  progress := app_private.support_goal_progress_paise(v_goal_id);
  if progress <> 50000 then
    raise exception 'progress must freeze at ended_at (expected still 50000), got %', progress;
  end if;
end
$$;

select 'GOAL_PROGRESS_AND_REFUND=PASS' as result;
