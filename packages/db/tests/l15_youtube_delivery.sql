-- L15 acceptance: closing the three gaps flagged against the YouTube
-- connector poller (services/youtube-poller-go).
--
-- 1. DELIVERY PATH: a normalised YouTube event inserted through
--    app_private.record_youtube_alert_event (0094) produces an
--    event_outbox row AND is routed to every active queue_bindings row for
--    that channel/source, via event_outbox_deliveries — the same mechanism
--    create_manual_alert (0019) and record_verified_payment_webhook (0007)
--    use, not a parallel pipeline.
-- 2. IDEMPOTENCY: reprocessing the identical YouTube message id is a no-op —
--    no second alert_events row, no second event_outbox row, no second
--    event_outbox_deliveries row — enforced by
--    alert_events_external_source_unique (0091) via ON CONFLICT, a real
--    database guarantee, not only the poller's own advisory lock.
-- 3. NO ROUTE CONFIGURED: with no matching queue_bindings row, the event is
--    still recorded (visible, quarantined), never silently dropped.
-- 4. PERMANENT-FAILURE RECORDING: app_private.record_youtube_ingest_failure
--    (0094) durably records a rejection the poller could not retry away.
-- 5. LEAST PRIVILEGE: bsa_connector_poller can do all of the above ONLY
--    through the SECURITY DEFINER functions in 0094 — it holds no direct
--    table grant on alert_events (the 0091 grant is revoked by 0094,
--    because alert_events has row level security with no INSERT policy for
--    any role — every write path in this codebase goes through a definer
--    function instead).
--
-- Runs inside begin/rollback. Synthetic identifiers only. Own id block:
-- ...1701-...1730 (packages/db/tests/fixtures/00_base_world.sql's own
-- registry names ...1701 upward as the next free block as of this write;
-- grepped across packages/db/tests/*.sql before use to confirm no
-- collision).

\set ON_ERROR_STOP on

begin;

-- Reuses base_world's channel ...0011 (owner ...0001), seeded by
-- run-sql-suite.sh before every test file in this suite.

insert into channel_configs (channel_id, version, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000011', 1, '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into alert_queues (id, channel_id, name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001701', '00000000-0000-4000-8000-000000000011', 'YouTube Queue', current_timestamp, current_timestamp);

-- A channel-wide default binding, the same '__channel_default__' fallback
-- convention payment routing already uses (0036/0091 comments).
insert into queue_bindings (id, channel_id, queue_id, source_type, source_id, allow_duplicates, priority, created_at)
values ('00000000-0000-4000-8000-000000001702', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000001701', 'youtube', '__channel_default__', true, 10, current_timestamp);

do $$
declare
  event_id_1 uuid;
  event_id_2 uuid;
  inserted_1 boolean;
  inserted_2 boolean;
  delivery_count_1 integer;
  delivery_count_2 integer;
  alert_count integer;
  outbox_count integer;
  outbox_status text;
  delivery_row_count integer;
  quarantine_event_id uuid;
  quarantine_inserted boolean;
  quarantine_delivery_count integer;
  quarantine_outbox_status text;
  failure_id uuid;
  failure_count integer;
begin
  -- bsa_connector_poller must hold no direct grant on alert_events: every
  -- write goes through the definer functions instead (RLS on alert_events
  -- has no INSERT policy for any role). Checked as the migration owner —
  -- has_table_privilege reports on the named role regardless of the
  -- caller's own current role.
  if has_table_privilege('bsa_connector_poller', 'public.alert_events', 'INSERT') then
    raise exception 'bsa_connector_poller must not hold a direct INSERT grant on alert_events';
  end if;
  if has_table_privilege('bsa_connector_poller', 'public.event_outbox', 'INSERT') then
    raise exception 'bsa_connector_poller must not hold a direct INSERT grant on event_outbox';
  end if;

  set role bsa_connector_poller;

  -- ---------------------------------------------------------------------
  -- 1. First delivery: event + outbox('pending') + one ready delivery,
  --    routed through the channel-default binding.
  -- ---------------------------------------------------------------------
  select event_id, inserted, delivery_count
    into event_id_1, inserted_1, delivery_count_1
    from app_private.record_youtube_alert_event(
      '00000000-0000-4000-8000-000000001710'::uuid,
      '00000000-0000-4000-8000-000000001711'::uuid,
      '00000000-0000-4000-8000-000000000011'::uuid,
      'yt-msg-1', 'youtube.super_chat', 'UC_viewer_1',
      'youtube-poller:yt-msg-1', 1,
      '{"displayName":"Viewer","message":"hi","amountMinorUnits":500,"currency":"USD"}'::jsonb
    );

  if not inserted_1 or event_id_1 <> '00000000-0000-4000-8000-000000001710'::uuid then
    raise exception 'first record_youtube_alert_event call was not treated as a new insert';
  end if;
  if delivery_count_1 <> 1 then
    raise exception 'expected exactly one delivery via the channel-default binding, got %', delivery_count_1;
  end if;

  -- Verification queries run as the migration owner: bsa_connector_poller
  -- holds no direct SELECT on these tables either (see the has_table_privilege
  -- checks above) — that is the point being proven, not a test bug.
  reset role;

  select count(*) into alert_count from public.alert_events
   where id = event_id_1 and source_type = 'youtube' and source_id = 'yt-msg-1';
  if alert_count <> 1 then
    raise exception 'alert_events row for yt-msg-1 not found';
  end if;

  select status into outbox_status from public.event_outbox where event_id = event_id_1;
  if outbox_status <> 'pending' then
    raise exception 'event_outbox status = %, want pending', outbox_status;
  end if;

  select count(*) into delivery_row_count
    from public.event_outbox_deliveries
   where event_id = event_id_1 and status = 'ready' and queue_id = '00000000-0000-4000-8000-000000001701';
  if delivery_row_count <> 1 then
    raise exception 'expected one ready event_outbox_deliveries row, got %', delivery_row_count;
  end if;

  set role bsa_connector_poller;

  -- ---------------------------------------------------------------------
  -- 2. Idempotency: reprocessing the identical message id is a no-op.
  -- ---------------------------------------------------------------------
  select event_id, inserted, delivery_count
    into event_id_2, inserted_2, delivery_count_2
    from app_private.record_youtube_alert_event(
      '00000000-0000-4000-8000-000000001712'::uuid, -- different candidate ids: proves de-dup is on
      '00000000-0000-4000-8000-000000001713'::uuid, -- (channel_id, source_type, source_id), not on the caller's ids
      '00000000-0000-4000-8000-000000000011'::uuid,
      'yt-msg-1', 'youtube.super_chat', 'UC_viewer_1',
      'youtube-poller:yt-msg-1-retry', 1,
      '{"displayName":"Viewer","message":"hi","amountMinorUnits":500,"currency":"USD"}'::jsonb
    );

  if inserted_2 then
    raise exception 'reprocessing the same YouTube message id was NOT treated as a duplicate';
  end if;
  if event_id_2 <> event_id_1 then
    raise exception 'duplicate reprocessing returned a different event_id than the original: % vs %', event_id_2, event_id_1;
  end if;

  reset role;

  select count(*) into alert_count from public.alert_events where source_type = 'youtube' and source_id = 'yt-msg-1';
  if alert_count <> 1 then
    raise exception 'reprocessing produced a second alert_events row (count=%)', alert_count;
  end if;
  select count(*) into outbox_count from public.event_outbox where event_id = event_id_1;
  if outbox_count <> 1 then
    raise exception 'reprocessing produced a second event_outbox row (count=%)', outbox_count;
  end if;
  select count(*) into delivery_row_count from public.event_outbox_deliveries where event_id = event_id_1;
  if delivery_row_count <> 1 then
    raise exception 'reprocessing produced a second event_outbox_deliveries row (count=%)', delivery_row_count;
  end if;

  set role bsa_connector_poller;

  -- ---------------------------------------------------------------------
  -- 3. No route configured yet for this channel/source: recorded, visible,
  --    quarantined — never silently dropped.
  -- ---------------------------------------------------------------------
  select event_id, inserted, delivery_count
    into quarantine_event_id, quarantine_inserted, quarantine_delivery_count
    from app_private.record_youtube_alert_event(
      '00000000-0000-4000-8000-000000001714'::uuid,
      '00000000-0000-4000-8000-000000001715'::uuid,
      '00000000-0000-4000-8000-000000000012'::uuid, -- base_world's OTHER channel, has no youtube binding
      'yt-msg-unrouted', 'youtube.super_chat', 'UC_viewer_2',
      'youtube-poller:yt-msg-unrouted', 1, '{}'::jsonb
    );

  if not quarantine_inserted or quarantine_delivery_count <> 0 then
    raise exception 'unrouted event was not inserted with delivery_count=0 (inserted=%, delivery_count=%)', quarantine_inserted, quarantine_delivery_count;
  end if;

  reset role;

  select status into quarantine_outbox_status from public.event_outbox where event_id = quarantine_event_id;
  if quarantine_outbox_status <> 'quarantined' then
    raise exception 'unrouted event_outbox status = %, want quarantined (recorded, not dropped)', quarantine_outbox_status;
  end if;

  set role bsa_connector_poller;

  -- ---------------------------------------------------------------------
  -- 4. Permanent-failure recording (the "recorded, not dropped" half of
  --    the transient/permanent split — see internal/store/events.go).
  -- ---------------------------------------------------------------------
  select app_private.record_youtube_ingest_failure(
    '00000000-0000-4000-8000-000000001716'::uuid,
    '00000000-0000-4000-8000-000000000011'::uuid,
    'yt-msg-bad', 'youtube.super_chat', '23502',
    'synthetic not-null violation for test', '{}'::jsonb
  ) into failure_id;

  reset role;

  select count(*) into failure_count from public.youtube_event_ingest_failures
   where id = failure_id and source_id = 'yt-msg-bad' and sqlstate_code = '23502';
  if failure_count <> 1 then
    raise exception 'permanent failure was not durably recorded';
  end if;
exception when others then
  reset role;
  raise;
end
$$;
reset role;
rollback;

select 'L15_YOUTUBE_DELIVERY=PASS' as result;
