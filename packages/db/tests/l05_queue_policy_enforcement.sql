-- L05 queue policy proof: approval, quiet mode and moderation are enforced at
-- the durable dispatch boundary. Accepted rows remain durable while blocked.
\set ON_ERROR_STOP on

insert into channel_configs (channel_id, version, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1000,
   '{"queue":{"approvalRequired":true,"mode":"priority"}}'::jsonb,
   current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000011', 1001,
   '{"queue":{"quietMode":{"enabled":true,"timezone":"Asia/Kolkata","start":"00:00","end":"23:59"}}}'::jsonb,
   current_timestamp, current_timestamp);

insert into alert_events (id, channel_id, source_type, source_id, trace_id,
  config_snapshot_version, payload, created_at)
values
  ('00000000-0000-4000-8000-0000000002e1', '00000000-0000-4000-8000-000000000011',
   'manual', 'policy-approval', 'trace-policy-approval', 1000,
   '{"message":"approval test"}'::jsonb, current_timestamp),
  ('00000000-0000-4000-8000-0000000002e3', '00000000-0000-4000-8000-000000000011',
   'manual', 'policy-quiet', 'trace-policy-quiet', 1001,
   '{"message":"quiet test"}'::jsonb, current_timestamp);

insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000002e2', '00000000-0000-4000-8000-0000000002e1', 'pending', current_timestamp, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-0000000002e4', '00000000-0000-4000-8000-0000000002e3', 'pending', current_timestamp, current_timestamp, current_timestamp);

insert into event_outbox_deliveries (id, event_id, outbox_id, queue_id, binding_id,
  source_id, config_snapshot_version, delivery_sequence, status, attempt_count,
  created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000002e5', '00000000-0000-4000-8000-0000000002e1',
   '00000000-0000-4000-8000-0000000002e2', '00000000-0000-4000-8000-000000000021',
   '00000000-0000-4000-8000-000000000031', 'policy-approval', 1000, 1, 'pending', 0,
   current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-0000000002e6', '00000000-0000-4000-8000-0000000002e3',
   '00000000-0000-4000-8000-0000000002e4', '00000000-0000-4000-8000-000000000021',
   '00000000-0000-4000-8000-000000000031', 'policy-quiet', 1001, 1, 'pending', 0,
   current_timestamp, current_timestamp);

begin;
set local role bsa_alert_worker;
do $$
begin
  if exists (select 1 from app_private.list_ready_event_deliveries(50)
             where delivery_id = '00000000-0000-4000-8000-0000000002e5') then
    raise exception 'approval-required delivery was dispatchable before approval';
  end if;
  if exists (select 1 from app_private.list_ready_event_deliveries(50)
             where delivery_id = '00000000-0000-4000-8000-0000000002e6') then
    raise exception 'quiet-mode delivery was dispatchable during quiet window';
  end if;
end
$$;
set local role postgres;
do $$
begin
  if (select status from event_outbox_deliveries where id = '00000000-0000-4000-8000-0000000002e5') <> 'pending'
     or (select status from event_outbox_deliveries where id = '00000000-0000-4000-8000-0000000002e6') <> 'pending' then
    raise exception 'blocked policy changed durable delivery status';
  end if;
end
$$;
commit;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
select * from app_private.apply_moderation_action(
  '00000000-0000-4000-8000-0000000002e1',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000001', 'approve', 'synthetic approval'
);
commit;

begin;
set local role bsa_alert_worker;
do $$
begin
  if not exists (select 1 from app_private.list_ready_event_deliveries(50)
             where delivery_id = '00000000-0000-4000-8000-0000000002e5') then
    raise exception 'approval action did not make delivery dispatchable';
  end if;
end
$$;
set local role postgres;
do $$
begin
  if (select status from event_outbox_deliveries where id = '00000000-0000-4000-8000-0000000002e5') <> 'ready' then
    raise exception 'approval action did not transition delivery to ready';
  end if;
end
$$;
commit;

-- 0065's mode-aware selection order: priority mode ranks by
-- source_priority + 1-per-30s aging (anti-starvation), everything else
-- (fifo/stacked/pills/aggregated — all presentation-only, see the
-- "Server-side queue-mode dispatch semantics" audit finding) is a pure
-- created_at/id tiebreak that never reads source_priority at all.
--
-- Everything below runs inside one transaction that always rolls back.
-- list_ready_event_deliveries has no channel/queue scope in its signature —
-- it selects globally — so leaving these rows 'pending' past this test
-- would keep ranking them ahead of every other channel's rank-0 deliveries
-- for the rest of this disposable database's lifetime, silently starving
-- unrelated tests downstream (this was caught by exactly that failure mode
-- against services/alert-worker-go's own integration test, not assumed).
begin;
insert into channel_configs (channel_id, version, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1002, '{"queue":{"mode":"priority"}}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000011', 1003, '{"queue":{"mode":"stacked","stackLimit":3}}'::jsonb, current_timestamp, current_timestamp);

insert into alert_events (id, channel_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values
  ('00000000-0000-4000-8000-0000000002f1', '00000000-0000-4000-8000-000000000011', 'manual', 'policy-priority-low', 'trace-policy-priority-low', 1002, '{"message":"low"}'::jsonb, current_timestamp - interval '10 seconds'),
  ('00000000-0000-4000-8000-0000000002f2', '00000000-0000-4000-8000-000000000011', 'manual', 'policy-priority-high', 'trace-policy-priority-high', 1002, '{"message":"high"}'::jsonb, current_timestamp - interval '10 seconds'),
  ('00000000-0000-4000-8000-0000000002f3', '00000000-0000-4000-8000-000000000011', 'manual', 'policy-priority-aged', 'trace-policy-priority-aged', 1002, '{"message":"aged"}'::jsonb, current_timestamp - interval '90 seconds'),
  ('00000000-0000-4000-8000-0000000002f4', '00000000-0000-4000-8000-000000000011', 'manual', 'policy-stacked-highprio', 'trace-policy-stacked-highprio', 1003, '{"message":"stacked ignores priority"}'::jsonb, current_timestamp - interval '5 seconds');

insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000002f5', '00000000-0000-4000-8000-0000000002f1', 'pending', current_timestamp, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-0000000002f6', '00000000-0000-4000-8000-0000000002f2', 'pending', current_timestamp, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-0000000002f7', '00000000-0000-4000-8000-0000000002f3', 'pending', current_timestamp, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-0000000002f8', '00000000-0000-4000-8000-0000000002f4', 'pending', current_timestamp, current_timestamp, current_timestamp);

insert into event_outbox_deliveries (id, event_id, outbox_id, queue_id, binding_id, source_priority,
  source_id, config_snapshot_version, delivery_sequence, status, attempt_count, created_at, updated_at)
values
  -- rank = source_priority + floor(age_seconds / 30): 1 + 0 = 1
  ('00000000-0000-4000-8000-0000000002f9', '00000000-0000-4000-8000-0000000002f1', '00000000-0000-4000-8000-0000000002f5', '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000031', 1, 'policy-priority-low', 1002, 1, 'pending', 0, current_timestamp - interval '10 seconds', current_timestamp),
  -- rank = 10 + 0 = 10 (must rank first)
  ('00000000-0000-4000-8000-0000000002fa', '00000000-0000-4000-8000-0000000002f2', '00000000-0000-4000-8000-0000000002f6', '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000031', 10, 'policy-priority-high', 1002, 1, 'pending', 0, current_timestamp - interval '10 seconds', current_timestamp),
  -- rank = 0 + floor(90/30) = 3 (must rank between low and high)
  ('00000000-0000-4000-8000-0000000002fb', '00000000-0000-4000-8000-0000000002f3', '00000000-0000-4000-8000-0000000002f7', '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000031', 0, 'policy-priority-aged', 1002, 1, 'pending', 0, current_timestamp - interval '90 seconds', current_timestamp),
  -- stacked mode: source_priority=99 must NOT jump ahead of the priority-mode rows above despite being numerically huge
  ('00000000-0000-4000-8000-0000000002fc', '00000000-0000-4000-8000-0000000002f4', '00000000-0000-4000-8000-0000000002f8', '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000031', 99, 'policy-stacked-highprio', 1003, 1, 'pending', 0, current_timestamp - interval '5 seconds', current_timestamp);

set local role bsa_alert_worker;
do $$
declare
  ranked uuid[];
begin
  -- WITH ORDINALITY (not row_number()/array_agg without an explicit ORDER
  -- BY) is what actually guarantees this test observes the function's own
  -- emission order rather than an unspecified plan-dependent order.
  select array_agg(delivery_id order by seq) into ranked
    from app_private.list_ready_event_deliveries(50)
      with ordinality as t(delivery_id, event_id, outbox_id, queue_id, binding_id, attempt_number, state_version, trace_id, seq)
   where delivery_id in (
     '00000000-0000-4000-8000-0000000002f9', '00000000-0000-4000-8000-0000000002fa',
     '00000000-0000-4000-8000-0000000002fb', '00000000-0000-4000-8000-0000000002fc'
   );
  if ranked <> array[
    '00000000-0000-4000-8000-0000000002fa'::uuid, -- priority high (rank 10)
    '00000000-0000-4000-8000-0000000002fb'::uuid, -- priority aged (rank 3)
    '00000000-0000-4000-8000-0000000002f9'::uuid, -- priority low (rank 1)
    '00000000-0000-4000-8000-0000000002fc'::uuid  -- stacked mode: source_priority ignored, falls back to created_at/id
  ] then
    raise exception 'priority-with-aging selection order was wrong: %', ranked;
  end if;
end
$$;
rollback;

select 'L05_QUEUE_POLICY=PASS' as result;
