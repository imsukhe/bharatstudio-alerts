# Runbook: a load run failed an L09 invariant

**Source:** `scripts/load/load-harness.ts` (`runLoadTest`), self-tests
`scripts/load/l09-load-invariants-self-test.ts` and
`scripts/load/l09-fault-duplicate-webhook-self-test.ts`.
**Severity:** stop. Do not proceed with any further L09 load/failure work,
and do not report L09 load evidence as passing, until this is root-caused.

## What fired

A local load run (`scripts/load/run-load-harness.sh` or either
`run-l09-*-self-test.sh`) printed a report where
`invariants.capturedPaymentsWithoutLiveEvent > 0` or
`invariants.duplicateLiveEvents > 0`. Both fields come directly from
`runReliabilityReconciliation` (`apps/api/src/observability/reconciliation.ts`)
— the same function that computes the two production reliability gauges
described in `captured-payment-without-live-event.md` and
`duplicate-live-event.md`.

This is not a latency or throughput miss. It means the harness found a
concrete, reproducible violation of MASTER-PLAN §11.2: money captured with
no LiveEvent, or one payment producing more than one LiveEvent — on a local
Postgres, under load or fault injection, right now, in code.

## What it means

Unlike the production runbooks for these same gauges, this fired against a
disposable container the harness itself just tore down (or is about to).
**Capture the evidence before anything is torn down or rerun**, because the
container disappears when the shell script exits:

1. Re-run with `set -eu` temporarily removed / `trap` disabled in the
   relevant `run-*.sh`, or export `LOAD_PG_PORT` (or `L09_LOAD_PG_PORT` /
   `L09_FAULT_PG_PORT`) to a fixed value and comment out the `cleanup`
   trap's `docker rm -f`, so the container survives after the script exits.
2. Connect to it directly (`docker exec -it <container> psql -U postgres`)
   and run the exact queries in `captured-payment-without-live-event.md`
   step 1 or `duplicate-live-event.md` step 1, scoped to the load run's
   `worldKey` (its channel `handle` is `load_<worldKey>` or
   `fault_<worldKey>` — see `load-harness.ts` / the self-tests).
3. Save the full JSON report the harness printed to stdout — `worldKey`,
   `tipCount`, `concurrency`, and the per-invariant counts are the minimum
   needed to reproduce.

## What to check first

- Is this reproducible at `tipCount: 1, concurrency: 1`? If the invariant
  still fails with no concurrency at all, the bug is in
  `app_private.record_verified_payment_webhook`
  (`packages/db/migrations/0028_v1_l04_capture_projection_dedup.sql`) or in
  `scripts/load/webhook-critical-path.ts`'s call to it — not a concurrency
  bug. Compare the harness's call against
  `services/payment-webhook-go/internal/ingress/sql_store.go`'s
  `PersistVerified` line by line; a drift between the two is the most likely
  harness-side cause and does NOT indicate a production bug.
- Does it only fail above a specific concurrency? That implicates a real
  race in the stored function or in `resolveDeliveryRows`' queue-binding
  selection (`scripts/load/webhook-critical-path.ts`) — treat this as a
  genuine production-reliability finding, not a harness bug, and escalate
  per this file's severity above.
- Was a `fault-guard.ts` primitive active? If
  `simulateDatabaseErrorMidTransaction` or `simulateNeverAckingDelivery` was
  in use, confirm the failure is the invariant metric genuinely catching a
  real gap and not an artifact of the fault probe's own rows (the probe
  writes a `source_type = 'manual'` alert_events row with no payment_id —
  it must never appear in either invariant's count; if it does, that is a
  bug in the reconciliation query's filter, not in the system under test).

## What this does NOT mean

A failure here is local-Postgres, single-machine evidence. It proves a real
defect exists in the transaction boundary or the harness's use of it — it
does **not** by itself prove or disprove anything about a deployed
environment's behavior under real network latency, connection pooling, or
Cloud Tasks retry timing. Fix and re-verify locally first; deployment
verification remains the separate, still-open work this file's sibling
runbooks and the L09 task file describe.
