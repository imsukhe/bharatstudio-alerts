# Runbook: refund failures

**Metric:** `bsa_reconciliation_refund_failures` (gauge, reconciliation-time)
**Source:** `apps/api/src/observability/reconciliation.ts` — `runReliabilityReconciliation`, fifth query
**Severity:** investigate same-shift. Direct creator/viewer money impact —
someone is owed money back and isn't getting it.

## What fired

A row in `refunds` has `status = 'failed'` and has been in that state for
longer than the grace window (default 15 minutes,
`refundFailureGraceMinutes` — long enough to not flag a refund still inside
its provider's own retry attempt).

## What it means

A refund was requested (creator-initiated, dispute, or a challenge/goal
rollback) and the provider-side attempt failed. Per MASTER-PLAN §11.5,
challenge refunds failing is a named key risk ("no escrow"). This is real
money owed to a viewer or creator that hasn't moved.

## What to check first

1. List the failed refunds:
   ```sql
   select r.id, r.payment_id, r.provider_refund_id, r.amount_paise,
          r.status, r.created_at, r.updated_at, p.channel_id, p.provider_payment_id
     from refunds r
     join payments p on p.id = r.payment_id
    where r.status = 'failed'
      and r.updated_at < now() - interval '15 minutes'
    order by r.updated_at desc
    limit 20;
   ```
2. Check whether the parent payment's own status still says `refunded` /
   `partially_refunded` (`payments.status`) — a mismatch between the payment's
   status and the refund's actual failure is worth flagging separately, it
   means a viewer/creator may believe money was returned when it wasn't.
3. This table is written by the private Go payment service's refund flow —
   check its own reconciliation outcome counters (per the L09 task file's
   2026-08-15 evidence: "payment and payment/refund reconciliation outcome
   counters") for the provider-side error it recorded, if any is exposed
   there.

## What to do

- Do not manually flip `refunds.status` to `processed` from this runbook —
  that would falsely claim money moved when it may not have. The refund must
  be re-attempted through the payment service's own refund-initiation path.
- Escalate to whoever owns `services/payment-webhook-go` refund handling with
  the `refunds.id` / `provider_refund_id` list above.
- If the affected channel is a creator awaiting a refund confirmation for a
  viewer complaint, this is also a support/comms issue independent of the
  technical fix — flag to L16/support ownership per MASTER-PLAN Part 7.14.

## Cannot be validated without a deployment

Unit-tested against a mocked SQL client only. No real refund failure has ever
been produced or caught by this query. The 15-minute grace window is a
starting guess; L09's task file does not yet declare a target for
refund-failure recovery time.
