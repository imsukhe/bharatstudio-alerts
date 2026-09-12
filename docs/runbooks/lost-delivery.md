# Runbook: lost delivery

**Metric:** `bsa_reconciliation_lost_deliveries` (gauge, reconciliation-time)
**Source:** `apps/api/src/observability/reconciliation.ts` — `runReliabilityReconciliation`, third query
**Severity:** investigate same-shift. Not immediately financial (the payment/LiveEvent
already exist), but it's an alert the creator paid for and never saw.

## What fired

A row in `event_outbox_deliveries` has sat in a non-terminal `status`
(`pending`, `ready`, `held`, `failed_retriable`) for longer than the staleness
window (default 30 minutes, `defaultReconciliationThresholds.deliveryStalenessMinutes`).
Terminal states — `displayed`, `acknowledged`, `quarantined`, `suppressed`,
`refunded_after_display` — are excluded; this metric only counts deliveries
that never resolved either way.

## What it means

The alert worker (owned by the private Go service, see MASTER-PLAN L05) claims
deliveries via `event_outbox` → `event_outbox_deliveries` and is supposed to
either display them (SSE to the overlay) or move them to a terminal failure
state. A delivery stuck mid-way usually means the worker crashed or lost its
lease mid-processing, Cloud Tasks stopped retrying, or the overlay SSE
connection it was targeting was never up to receive it and nothing timed it
out.

## What to check first

1. List the stuck deliveries:
   ```sql
   select d.id, d.event_id, d.queue_id, d.status, d.attempt_count,
          d.next_action_at, d.last_error_code, d.updated_at,
          e.channel_id, e.trace_id
     from event_outbox_deliveries d
     join alert_events e on e.id = d.event_id
    where d.status not in ('displayed','acknowledged','quarantined','suppressed','refunded_after_display')
      and d.updated_at < now() - interval '30 minutes'
    order by d.updated_at asc
    limit 20;
   ```
2. `attempt_count` high + `last_error_code` populated → the worker is retrying
   and failing (check `last_error_code` against alert-worker logs for that
   `event_id`/`trace_id`).
3. `attempt_count = 0` and old → it was likely never claimed. Check whether
   the alert-worker pump is running at all (its own `/internal/metrics`
   endpoint — see the Go service, out of this task's ownership — and its pump
   outcome counters: `completed`/`partial`/`retryable`/`invalid`).
4. Check whether the target channel's overlay session was ever connected:
   `select * from overlay_sessions where channel_id = '<channel_id>' order by created_at desc limit 5;`
   A delivery with nowhere to land can still be legitimately `held`, not lost
   — cross-check against `next_action_at` (a held-for-good-reason delivery has
   a future `next_action_at`; a truly stuck one usually doesn't, or it's long
   past).

## What to do

- If the alert-worker pump is down: that's an infra incident, escalate per
  the alert-worker's own on-call path (not covered by this repo's ownership).
- If the pump is up but this specific delivery is stuck: check for a
  malformed `payload` on the parent `alert_events` row (`select payload from
  alert_events where id = '<event_id>'`) — a payload the overlay renderer
  can't consume is a common cause of an infinite `failed_retriable` loop.
- Do not manually flip `status` to `displayed`/`acknowledged` — that would
  claim a delivery the viewer never actually saw. If the delivery is
  confirmed unrecoverable (e.g. the channel's overlay session was deleted),
  the correct terminal state is `quarantined`, applied through the
  alert-worker's own quarantine path, not a direct UPDATE.
- Record the `trace_id` for cross-hop lookup — see the L09 build report's
  trace-path table.

## Cannot be validated without a deployment

Unit-tested against a mocked SQL client only. The staleness threshold (30
minutes) is a starting guess, not a measured value — L09's own task file
lists "dispatch latency, queue age" as targets still to be declared from real
staging load. Expect to tune this threshold once real delivery latency is
observed.
