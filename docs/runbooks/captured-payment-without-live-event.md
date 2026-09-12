# Runbook: captured payment without a LiveEvent

**Metric:** `bsa_reconciliation_captured_payments_without_live_event` (gauge, reconciliation-time)
**Source:** `apps/api/src/observability/reconciliation.ts` — `runReliabilityReconciliation`, first query
**Severity:** page immediately. This is money in, nothing on stream — MASTER-PLAN §11.2: "Lost captured payment = unacceptable".

## What fired

A row in `payments` has `status = 'captured'` and `updated_at` older than the grace
window (default 15 minutes, `defaultReconciliationThresholds.capturedPaymentGraceMinutes`
in `apps/api/src/observability/reconciliation.ts`), with no matching row in
`alert_events` where `alert_events.payment_id = payments.id and source_type = 'payment'`.

## What it means

The payment webhook transaction boundary (MASTER-PLAN §4.5) is supposed to create the
payment and the LiveEvent in the same transaction, step 6 then step 8. If a captured
payment exists with no LiveEvent, either that transaction partially failed in a way
that shouldn't be possible, or a payment was marked captured through the reconciliation
worker (§4.7, `reconciliation_work_items`) without also producing the LiveEvent it's
supposed to on that path.

A creator was paid (or the creator's viewer was charged) and got no alert.

## What to check first

1. Get the count and confirm it isn't zero from a bug in the check itself:
   ```sql
   select p.id, p.provider_payment_id, p.channel_id, p.status, p.updated_at
     from payments p
    where p.status = 'captured'
      and p.updated_at < now() - interval '15 minutes'
      and not exists (
        select 1 from alert_events e
         where e.payment_id = p.id and e.source_type = 'payment'
      )
    order by p.updated_at desc
    limit 20;
   ```
2. For each `payments.id`, check `reconciliation_work_items` for a matching row
   (`payload->>'paymentId' = <id>`) — is it `pending`/`running` (still working) or
   `completed`/`quarantined` (finished without producing a LiveEvent — the real bug)?
3. Check `payment_webhook_deliveries` for the same `provider_payment_id` — was there
   a webhook at all, or did this payment only ever get created through the
   reconciliation path?

## What to do

- If `reconciliation_work_items` shows the item still `pending`/`running` and it's
  younger than a few minutes past the grace window, it may just be slow — recheck
  before escalating.
- If it's `completed` or `quarantined` with no LiveEvent, this is a correctness bug
  in the reconciliation worker's capture-to-LiveEvent step (owned by the private Go
  payment service — see `services/payment-webhook-go`, out of this task's ownership).
  File it against L09/L19 with the payment id and the reconciliation_work_items row.
- Do not manually insert an `alert_events` row from this runbook. Creating a LiveEvent
  is the one write this system treats as financially significant (§4.5 step 8) — it
  must go through the same code path a webhook or reconciliation worker uses, or it
  risks becoming exactly the duplicate-LiveEvent failure this system also guards
  against. Escalate to whoever owns the payment service for a repair run.
- Trace path for this specific payment: see `docs/runbooks/webhook-lag.md` and the
  trace-path table in the L09 build report for the field to search at each hop,
  starting from `payments.provider_payment_id`.

## Cannot be validated without a deployment

This check has been unit-tested against a mocked SQL client (`apps/api/test/l09-reconciliation.test.ts`),
never against a real Postgres instance or real webhook traffic. The query has not been
run against production-shaped data volumes; its performance at scale is unverified.
