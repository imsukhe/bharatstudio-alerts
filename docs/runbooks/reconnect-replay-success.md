# Runbook: reconnect replay success

**Metric:** `bsa_overlay_reconnect_replay_total{outcome="success"|"failure"}` (counter, request-time — NOT YET WIRED)
**Source:** `ApiMetrics.recordReconnectReplay` — `apps/api/src/observability/metrics.ts`
**Severity:** investigate same-shift once wired. A failure here means a
creator's overlay went dark on reconnect, mid-stream.

## Status: instrumentation exists, call site does not

This counter is defined and unit-tested (`apps/api/test/l09-reliability-metrics.test.ts`),
but nothing calls `metrics.recordReconnectReplay(...)` yet. The call belongs
in the overlay SSE reconnect/cursor-replay path in `apps/api/src/routes/overlay.ts`,
which this task does not own. See the L09 build report, "Wiring needed", for
the exact call to add. Until that lands, this metric reads flat zero forever
— flat zero is not evidence of health, it's evidence of no instrumentation.

## What fires (once wired)

`recordReconnectReplay('success')` on a reconnecting overlay SSE client
successfully resuming from its last cursor (`overlay_cursors`) with no gap.
`recordReconnectReplay('failure')` when a reconnect cannot resume — cursor not
found, cursor too old (events already archived), or the replay query itself
errors.

## What it means

The acceptance criterion this backs (L09 task file): "An overlay connected to
replica B receives an event committed through replica A; disabling live
notification still allows cursor/replay recovery." A `failure` here in
production means an overlay lost events on reconnect — the viewer/creator saw
a gap, not just a delay.

## What to check first (once wired)

1. Correlate with `overlay_sessions` for the channel: is this a fresh session
   (expected `failure` — nothing to replay) or a genuine reconnect
   (unexpected `failure` — investigate)?
2. Check `overlay_cursors` for the session — is the stored cursor older than
   the event archival window (see `retention_jobs`/`event-archive` maintenance
   job in `apps/api/src/domain/maintenance.ts`)? A cursor that's aged out is
   an expected failure mode, not a bug, but it does mean the viewer missed
   real events — check `event_outbox_deliveries` for that channel in the gap
   window to see what was actually lost.
3. If neither applies, check API logs for the request's `trace_id` (the
   request's own Fastify `request.id`, distinct from a payment's
   `alert_events.trace_id`) around the failure — the safe logger
   (`apps/api/src/observability/safe-log.ts`) will have a bounded
   `overlay_reconnect_failed`-style event once wired, with no raw error text.

## What to do

- A single failure on session start: benign, ignore.
- A cluster of failures for one channel: check whether that channel's overlay
  session was affected by a deploy/restart around the same time.
- A cluster of failures across many channels: likely a cursor-store or DB
  issue — treat as a live incident, not a one-off.

## Cannot be validated without a deployment

Nothing here has fired even once — the call site doesn't exist yet. Once
wired, this still needs real reconnect traffic (a real client dropping and
resuming an SSE connection) to produce its first real data point; the local
disposable-Postgres L03 harness proves the underlying replay query works
across replicas, not that this counter fires correctly around it.
