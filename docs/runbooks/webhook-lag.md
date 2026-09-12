# Runbook: webhook lag

**Metrics:** `bsa_reconciliation_webhook_lag_ms_max`, `bsa_reconciliation_webhook_lag_ms_avg` (gauges, reconciliation-time)
**Source:** `apps/api/src/observability/reconciliation.ts` — `runReliabilityReconciliation`, fourth query
**Severity:** investigate same-shift if `max` spikes; page if it stays elevated
alongside a rise in `bsa_reconciliation_captured_payments_without_live_event`
(that combination means the fast path is falling behind badly enough that
reconciliation is doing the real work).

## What fired

The gap, in milliseconds, between `payment_webhook_deliveries.received_at`
(when Razorpay's webhook hit the private payment service) and
`payments.created_at` (when the local payment row was persisted), for
deliveries processed in the last 24 hours. `avg` is the rolling average;
`max` is the worst single case in that window.

## What it means

Per MASTER-PLAN §4.7: "Webhook is the fast path; the provider API is the
recovery path." A rising lag means the fast path is slow — the alert a viewer
paid for is taking longer to reach the overlay, even though nothing is
technically lost yet. If lag keeps rising past the reconciliation grace window
(15 minutes, `capturedPaymentGraceMinutes`), it starts generating false
positives on the captured-payment-without-LiveEvent check.

## What to check first

1. Confirm it's real, not a query artifact:
   ```sql
   select w.provider_event_id, w.received_at, p.created_at,
          extract(epoch from (p.created_at - w.received_at)) * 1000 as lag_ms
     from payment_webhook_deliveries w
     join payments p on p.provider = w.provider and p.provider_payment_id = w.entity_id
    where w.entity_type = 'payment' and w.processing_status = 'processed'
      and w.received_at > now() - interval '24 hours'
    order by lag_ms desc
    limit 20;
   ```
2. Is the lag concentrated in a time window (a deploy, a DB failover) or
   spread evenly (sustained capacity problem)?
3. Check `payment_webhook_deliveries.processing_status` distribution for the
   same window — a rise in `retryable_failure` alongside rising lag points at
   the payment service's own retry loop, not just slow persistence.
4. This is computed inside this TS API's reconciliation check, but the
   webhook itself is handled by the private Go payment service
   (`services/payment-webhook-go`, out of this task's ownership) — check that
   service's own `/internal/metrics` (payment checkout/reconciliation outcome
   counters, per the L09 task file's 2026-08-15 evidence) for its side of the
   same window.

## What to do

- Isolated spike tied to a known deploy/restart: note it, no action.
- Sustained rise: check DB connection pool saturation and Cloud Tasks
  queue depth for the payment service — this metric can't tell you which,
  only that persistence is slow.
- If `bsa_reconciliation_captured_payments_without_live_event` starts moving
  at the same time: stop treating this as a performance issue and follow
  `docs/runbooks/captured-payment-without-live-event.md` instead — lag has
  turned into loss.

## Cannot be validated without a deployment

Unit-tested against a mocked SQL client only. No real webhook has ever been
measured end-to-end through this query; the 24-hour window and the specific
join on `(provider, provider_payment_id)` are unverified against production
data volumes and have not been checked for index coverage.
