-- L15 YouTube connector: close the three gaps the poller-only lane could not
-- close from services/youtube-poller-go alone (that lane owns only that
-- service, this migration, and packages/db/tests/l15_youtube_delivery.sql).
--
-- GAP 1 — NO DELIVERY PATH.
--   The poller wrote alert_events directly (0091 granted bsa_connector_poller
--   raw insert/select on that table) but never touched event_outbox, so a
--   normalised event sat there forever with nothing to route it to an
--   overlay. Worse: alert_events has row level security
--   (0002_v1_security_rls_archive.sql:174) with only one policy,
--   alert_events_member_select, scoped to bsa_app
--   (0002_v1_security_rls_archive.sql:253) — there is no INSERT policy for
--   ANY role. Every other write path in this codebase
--   (app_private.create_manual_alert — 0019/0003 — and
--   app_private.record_verified_payment_webhook — 0007) is a SECURITY
--   DEFINER function owned by the migration owner, which is exempt from its
--   own tables' RLS; none of them hand a caller role a raw table grant. The
--   0091 grant would not actually have let bsa_connector_poller insert a row
--   once RLS started being exercised for real (this repo's own suite never
--   ran a YouTube insert against a real Postgres before now — see the new
--   integration test). That is fixed here the same way, not with a new
--   pipeline: app_private.record_youtube_alert_event is a SECURITY DEFINER
--   function that, in one transaction, inserts alert_events, inserts
--   event_outbox (status 'pending' — identical shape to create_manual_alert
--   and record_verified_payment_webhook), and inserts event_outbox_deliveries
--   rows (status 'ready') for every active queue_bindings row that routes
--   this source, using the exact-source-id-beats-'__channel_default__'
--   fallback precedence record_verified_payment_webhook already established
--   for connector-shaped writes. If no queue_bindings row routes it yet, the
--   outbox row is marked 'quarantined' — visible in
--   app_private.get_alert_history, never silently dropped — exactly as
--   record_verified_payment_webhook does when delivery_count = 0.
--
-- GAP 2 — MESSAGE LOSS ON TRANSIENT FAILURE.
--   The poller's own retry/backoff and duplicate/transient/permanent
--   classification live in services/youtube-poller-go/internal/store
--   (Go code, out of this migration's scope), but a permanent-but-not-
--   duplicate failure needs somewhere durable to land so it is "recorded",
--   not merely logged and forgotten. youtube_event_ingest_failures is that
--   durable record, written through its own tightly-scoped SECURITY DEFINER
--   function for the same RLS reason as gap 1.
--
-- GAP 3 — NO INTEGRATION TEST — is closed by
-- packages/db/tests/l15_youtube_delivery.sql and
-- packages/db/tests/run-l15-youtube-delivery-integration (Go), not by this
-- file, but both depend on the objects created here.
--
-- Depends on 0001-0093. Does not modify 0001-0093.

-- ---------------------------------------------------------------------------
-- 0. Correct the 0091 grant: bsa_connector_poller must not hold a raw table
--    grant on alert_events. RLS has exactly one policy on that table
--    (alert_events_member_select, to bsa_app) and no INSERT policy for any
--    role, so this grant could never have produced a working insert path —
--    every write to alert_events in this codebase goes through a SECURITY
--    DEFINER function instead, which is exempt from RLS as the table owner.
--    Revoking a grant made by an earlier, already-landed migration is not an
--    edit to that migration's file; 0086 and 0091 themselves both revoke
--    grants made by an earlier migration in exactly this way.
-- ---------------------------------------------------------------------------
revoke insert, select on public.alert_events from bsa_connector_poller;

-- Needed to call the SECURITY DEFINER functions below at all (every other
-- role that calls into app_private already holds this — bsa_alert_worker,
-- 0003; bsa_payment, 0006/0007/0008 — this is the same grant, not a new
-- pattern).
grant usage on schema app_private to bsa_connector_poller;

-- ---------------------------------------------------------------------------
-- 1. Durable record of a permanently-rejected YouTube event.
--    Insert-only, append-only, same shape as archive_records
--    (0002_v1_security_rls_archive.sql) for the same reason: a connector
--    must never be able to erase evidence that an event was rejected.
-- ---------------------------------------------------------------------------
create table public.youtube_event_ingest_failures (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  source_id text not null,
  source_event_type text,
  sqlstate_code text,
  error_detail text not null check (char_length(error_detail) between 1 and 4096),
  payload jsonb,
  created_at timestamptz not null default current_timestamp
);

create index youtube_event_ingest_failures_channel_idx
  on public.youtube_event_ingest_failures (channel_id, created_at desc);

alter table public.youtube_event_ingest_failures enable row level security;
revoke all on public.youtube_event_ingest_failures from public;

-- ---------------------------------------------------------------------------
-- 2. app_private.record_youtube_alert_event — the delivery path.
--
--    Idempotent on the same partial unique index the poller's own advisory
--    lock previously stood in for (alert_events_external_source_unique,
--    0091). ON CONFLICT ... DO NOTHING is a real database-level guarantee,
--    not merely a writer-side lock, so this also strictly strengthens the
--    idempotency gap 0091 already reduced but did not close: a second writer
--    that skipped the advisory lock, or a bug computing its key, could not
--    previously have been stopped by the database itself. It now is.
--
--    Routing mirrors record_verified_payment_webhook's precedence: an exact
--    source_id binding beats a channel's '__channel_default__' fallback
--    binding for the same queue; every other active 'youtube' binding for
--    the channel gets its own delivery row, highest priority first. Delivery
--    ids are deterministic (md5 of event id + queue id), not
--    gen_random_uuid(), matching create_manual_alert's own convention so a
--    retried call is exactly as idempotent for the deliveries it creates as
--    it is for the event/outbox rows.
-- ---------------------------------------------------------------------------
create or replace function app_private.record_youtube_alert_event(
  target_event_id uuid,
  target_outbox_id uuid,
  target_channel_id uuid,
  target_source_id text,
  target_source_event_type text,
  target_source_user_id text,
  target_trace_id text,
  target_config_snapshot_version bigint,
  target_payload jsonb
)
returns table (event_id uuid, inserted boolean, delivery_count integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  local_event_id uuid;
  local_delivery_count integer := 0;
  selected_binding record;
begin
  if target_event_id is null or target_outbox_id is null or target_channel_id is null
     or target_source_id is null or length(target_source_id) = 0 then
    raise exception 'invalid youtube alert event' using errcode = '22023';
  end if;

  insert into public.alert_events (
    id, channel_id, payment_id, source_type, source_id,
    source_event_type, source_user_id,
    trace_id, config_snapshot_version, payload, created_at
  )
  values (
    target_event_id, target_channel_id, null, 'youtube', target_source_id,
    target_source_event_type, target_source_user_id,
    target_trace_id, target_config_snapshot_version, target_payload, current_timestamp
  )
  on conflict (channel_id, source_type, source_id)
    where source_type in ('youtube', 'twitch', 'kick')
  do nothing
  returning id into local_event_id;

  if local_event_id is null then
    -- Duplicate: the message id has already been recorded (and already
    -- routed, the first time it was inserted). ON CONFLICT DO NOTHING never
    -- returns the pre-existing row via RETURNING, so it is looked up
    -- explicitly — the caller must learn the ORIGINAL event's id, not the
    -- new candidate id this call happened to be offered, so it can
    -- recognise this as the same alert rather than a different one. Not an
    -- error — reprocessing an already-seen id must be a no-op, never a
    -- second alert.
    select id into local_event_id
      from public.alert_events
     where channel_id = target_channel_id and source_type = 'youtube' and source_id = target_source_id;
    return query select local_event_id, false, 0;
    return;
  end if;

  insert into public.event_outbox (id, event_id, status, available_at, created_at, updated_at)
  values (target_outbox_id, local_event_id, 'pending', current_timestamp, current_timestamp, current_timestamp);

  for selected_binding in
    select binding.id as binding_id,
           binding.queue_id as queue_id,
           binding.priority as source_priority,
           coalesce(binding.override_values, '{}'::jsonb) as override_values,
           binding.created_at as created_at
      from public.queue_bindings binding
     where binding.channel_id = target_channel_id
       and binding.closed_at is null
       and binding.source_type = 'youtube'
       and binding.source_id in (target_source_id, '__channel_default__')
       and not (
         binding.source_id = '__channel_default__'
         and exists (
           select 1
             from public.queue_bindings exact_binding
            where exact_binding.channel_id = target_channel_id
              and exact_binding.closed_at is null
              and exact_binding.source_type = 'youtube'
              and exact_binding.source_id = target_source_id
              and exact_binding.queue_id = binding.queue_id
         )
       )
     order by binding.priority desc, binding.created_at asc, binding.id asc
  loop
    local_delivery_count := local_delivery_count + 1;
    insert into public.event_outbox_deliveries (
      id, event_id, outbox_id, queue_id, binding_id, source_id,
      config_snapshot_version, delivery_sequence, source_priority, override_values,
      status, attempt_count, created_at, updated_at
    )
    values (
      md5('youtube-delivery:' || local_event_id::text || ':' || selected_binding.queue_id::text)::uuid,
      local_event_id, target_outbox_id, selected_binding.queue_id, selected_binding.binding_id, target_source_id,
      target_config_snapshot_version, local_delivery_count, selected_binding.source_priority, selected_binding.override_values,
      'ready', 0, current_timestamp, current_timestamp
    );
  end loop;

  if local_delivery_count = 0 then
    -- No queue_bindings row routes this connector's events yet for this
    -- channel. Recorded and visible (get_alert_history surfaces
    -- 'quarantined'), never silently dropped, exactly as
    -- record_verified_payment_webhook does for the same delivery_count = 0
    -- case.
    update public.event_outbox
       set status = 'quarantined', updated_at = current_timestamp
     where id = target_outbox_id;
  end if;

  return query select local_event_id, true, local_delivery_count;
end
$$;

revoke execute on function app_private.record_youtube_alert_event(uuid, uuid, uuid, text, text, text, text, bigint, jsonb) from public;
grant execute on function app_private.record_youtube_alert_event(uuid, uuid, uuid, text, text, text, text, bigint, jsonb) to bsa_connector_poller;

-- ---------------------------------------------------------------------------
-- 3. app_private.record_youtube_ingest_failure — the "recorded, not
--    dropped" side of gap 2. Called by the poller only after it has
--    classified a failure as permanent (retrying would never succeed) and
--    exhausted retry for a transient one (see internal/store/events.go).
-- ---------------------------------------------------------------------------
create or replace function app_private.record_youtube_ingest_failure(
  target_id uuid,
  target_channel_id uuid,
  target_source_id text,
  target_source_event_type text,
  target_sqlstate_code text,
  target_error_detail text,
  target_payload jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_id is null or target_channel_id is null or target_source_id is null
     or target_error_detail is null or length(target_error_detail) = 0 then
    raise exception 'invalid youtube ingest failure record' using errcode = '22023';
  end if;

  insert into public.youtube_event_ingest_failures (
    id, channel_id, source_id, source_event_type, sqlstate_code, error_detail, payload, created_at
  )
  values (
    target_id, target_channel_id, target_source_id, target_source_event_type,
    target_sqlstate_code, left(target_error_detail, 4096), target_payload, current_timestamp
  )
  on conflict (id) do nothing;

  return target_id;
end
$$;

revoke execute on function app_private.record_youtube_ingest_failure(uuid, uuid, text, text, text, text, jsonb) from public;
grant execute on function app_private.record_youtube_ingest_failure(uuid, uuid, text, text, text, text, jsonb) to bsa_connector_poller;
