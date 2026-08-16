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

select 'L05_QUEUE_POLICY=PASS' as result;
