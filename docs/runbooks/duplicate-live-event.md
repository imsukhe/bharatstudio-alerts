# Runbook: duplicate LiveEvent

**Metric:** `bsa_reconciliation_duplicate_live_events` (gauge, reconciliation-time)
**Source:** `apps/api/src/observability/reconciliation.ts` — `runReliabilityReconciliation`, second query
**Severity:** page immediately. MASTER-PLAN §11.2: "Duplicate financial event = unacceptable".

## What fired

More than one row in `alert_events` shares the same `payment_id` (with
`source_type = 'payment'`). One payment produced two (or more) alerts/queue
entries — a creator got paid once and alerted twice, or a viewer's single tip
triggered two TTS reads / two overlay pops.

## What it means

`UNIQUE(provider, provider_payment_id)` on `payments` (migration `0001_v1_baseline.sql`)
makes a duplicate *payment* row impossible. This metric checks a different
invariant: that each payment produced exactly one LiveEvent (§4.6: "Repeated
webhooks produce one payment, one LiveEvent, one alert"). If this fires, either
the webhook dedup on `(provider, provider_event_id)` was bypassed somehow, or
something outside the webhook transaction boundary (a manual test alert, a
backfill script, a reconciliation repair) created a second LiveEvent against an
already-alerted payment.

## What to check first

1. Find the duplicated payment(s):
   ```sql
   select payment_id, count(*), array_agg(id order by created_at) as event_ids,
          array_agg(source_id order by created_at) as source_ids,
          array_agg(trace_id order by created_at) as trace_ids
     from alert_events
    where payment_id is not null and source_type = 'payment'
    group by payment_id
   having count(*) > 1;
   ```
2. Compare the `trace_id` values for the duplicated rows. Two different
   `razorpay:<event-id>` values means two distinct webhook deliveries were
   both treated as the first capture for this payment — a dedup bug. The same
   `trace_id` twice would mean the dedup key was bypassed entirely (e.g. a
   direct insert) — check `source_id` for whether one of the rows is a
   `manual`/companion-triggered test alert that was mis-tagged with
   `source_type = 'payment'`.
3. Check `event_outbox_deliveries` for both `event_id`s — did both actually
   reach `displayed`/`acknowledged` (real double alert), or did one get
   `quarantined`/`suppressed` before delivery (bad data, but no viewer-visible
   duplicate)?

## What to do

- If both events delivered: this is a live incident, not just a data
  correctness bug — the creator was alerted twice for one payment. Notify the
  affected creator's channel is not automated; check Companion
  (`apps/api/src/routes/companion.ts`) for a manual mute/cancel action if a
  delivery is still in flight.
- Capture the full row (`alert_events.id`, `trace_id`, `payment_id`,
  `created_at`) before touching anything — this is the evidence for the fix.
- Do not delete either `alert_events` row. It's the append-only financial
  audit trail (MASTER-PLAN §11.1). If a second alert must be suppressed after
  the fact, that's an `event_outbox_deliveries.status = 'quarantined'`
  transition through the alert-worker's own quarantine path, not a delete.
- File against L09 with the query output above. If the two `trace_id`s
  differ, this is a webhook dedup bug and belongs with whoever owns
  `services/payment-webhook-go` (§4.5/§4.6), not this API.

## Cannot be validated without a deployment

Unit-tested against a mocked SQL client only (`apps/api/test/l09-reconciliation.test.ts`).
No real duplicate has ever been produced or caught by this query against a live
database — the webhook dedup path it's meant to catch failures of is itself
only locally tested (see L09 task file, "DONE" markers for §4.5/§4.6).
