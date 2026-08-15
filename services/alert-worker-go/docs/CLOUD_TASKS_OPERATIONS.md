# Alert delivery operations runbook

This runbook is for the v1 `deliver_overlay` Cloud Tasks target. It describes
how operators recover delivery work without deleting, acknowledging, or
rewriting accepted payment/alert evidence.

## Invariants

- `event_outbox_deliveries` is the source of truth for per-queue progress.
- A Cloud Tasks acknowledgement is only transport acknowledgement. It is not
  a browser display acknowledgement.
- A successful worker publication releases the worker lease; the overlay moves
  the delivery to `acknowledged` only after it renders and acknowledges the
  cursor.
- Enqueue failure, task timeout, worker crash, database outage, notification
  outage, TTS failure, or overlay disconnection must leave the durable delivery
  eligible for retry/replay.
- Never delete an event, payment, webhook delivery, outbox row, delivery row,
  attempt, or audit record to clear a backlog.
- Never return provider success for a newly accepted payment when the durable
  alert path has not been persisted and the worker wake-up has not been
  accepted.

## Required deployment values

These values must be recorded in the staging/production deployment record
before the queue is enabled. This document intentionally does not guess them.

| Value | Required decision/evidence |
|---|---|
| Cloud Tasks queue name and region | Pinned per environment |
| Target URL and OIDC audience | Private worker endpoint; audience and service-account binding tested |
| Per-attempt deadline | Must fit claim, publish, release and bounded HTTP timeouts |
| Retry backoff and maximum attempts | Approved by SRE/product; must allow recovery without infinite hot-looping |
| Dead-letter queue | Configured, access-restricted, monitored and replayable |
| Pump batch size, enqueue concurrency and cadence | `ALERT_WORKER_PUMP_CONCURRENCY` defaults to 8; size all three against DB pool, Cloud Tasks quota and overlay capacity |
| Backlog alert threshold | Based on measured staging queue age, not an unverified number |

The maximum-attempt setting is a transport safety limit, not permission to
discard a delivery. A task reaching the dead-letter queue leaves its durable
delivery state visible for recovery and must page the owner.

## Normal recovery paths

### Task enqueue failure

1. Keep the delivery in its current durable ready/retryable state.
2. Return a retryable response from the pump; do not mark the row complete.
3. Allow the next bounded ready-row scan to derive the same stable task name.
4. Confirm the task exists before treating the wake-up as recovered.

### Worker timeout or crash

1. Cloud Tasks retries the same command.
2. The lease expires; the next claim uses the expected attempt and state
   version, so stale work cannot claim a newer state.
3. If the overlay publication was durable but release was interrupted, the
   handler's retry transition makes the delivery reclaimable.
4. Confirm the delivery remains ready/retryable and that overlay replay can
   recover it before clearing the incident.

### Dead-lettered task

1. Stop any automated replay if the delivery is producing a repeatable error;
   do not suppress or delete the delivery.
2. Inspect the redacted task envelope, delivery ID, event ID, queue ID, attempt
   number, state version, trace ID, last error code and timestamps.
3. Verify the payment/webhook/outbox evidence and the overlay session state.
4. Fix the underlying dependency or configuration, then run the approved
   bounded replay/pump path. The stable task name makes a repeated enqueue
   harmless.
5. Verify browser/OBS replay and cursor acknowledgement. Record the result in
   the incident record.

### Overlay disconnected or notification outage

1. Keep notification failures non-terminal.
2. Verify the overlay reconnects with its last acknowledged cursor.
3. Verify durable replay returns eligible unacknowledged deliveries in policy
   order and that queue pause is respected.
4. Do not manually mark a delivery acknowledged merely because a wake-up was
   emitted.

## Manual replay guardrails

Manual recovery is allowed only for an identified delivery and must be:

- authenticated with the private operator identity;
- bounded to one environment, channel, queue and delivery set;
- idempotent by delivery/version/attempt;
- recorded with operator, reason, incident ID and outcome;
- unable to mutate payment gross amount, provider event identity or historical
  alert payload;
- followed by verification of durable state and overlay acknowledgement.

There is no destructive "clear backlog" operation.

## Monitoring and escalation

Alert on:

- ready/retryable delivery age and count;
- task enqueue failures and partial pump results;
- Cloud Tasks retry/dead-letter count;
- claim, publish, release and acknowledgement failures;
- overlay reconnect/resync and listener fallback rate;
- notification outage duration;
- database readiness failures and pool saturation;
- payment webhook retry rate and payment-to-alert recovery age.

The incident owner must preserve the redacted evidence bundle and reconcile
payments, webhook deliveries, outbox rows, per-queue deliveries, task attempts
and overlay cursor acknowledgements before closing the incident.

## Rollback

Disable the task target or enqueue feature flag first, preserve all durable
rows, and use the previous verified deployment only if it can consume the same
contract. Re-enable only after a staging replay proves no duplicate financial
effect and no lost accepted alert. Never roll back by deleting rows or
resetting attempt/state fields by hand.

## Open release gates

This runbook does not claim that the queue is production-ready. The following
still require staging/deployment evidence:

- live queue and dead-letter configuration;
- retry/backoff/deadline values;
- private OIDC invocation and IAM negative tests;
- cross-replica overlay replay and notification-outage drill;
- measured capacity and backlog thresholds;
- independent L05 review.
