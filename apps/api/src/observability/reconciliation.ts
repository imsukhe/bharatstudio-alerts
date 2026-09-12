import type { Sql } from 'postgres';
import type { ReconciliationSnapshot } from './metrics.js';

// L09 reconciliation-time reliability checks (MASTER-PLAN Part 11.2).
//
// Several of the seven reliability metrics are absence-of-a-thing and
// structurally cannot be observed from a single request: a captured payment
// with no LiveEvent, a duplicate LiveEvent, a delivery that never reached a
// terminal state. These are computed here by periodic, read-only SQL against
// the same tables the webhook transaction boundary writes (MASTER-PLAN
// §4.5-4.7): `payments`, `alert_events`, `event_outbox_deliveries`,
// `payment_webhook_deliveries`, `refunds` (schema: packages/db/migrations/
// 0001_v1_baseline.sql).
//
// This module never mutates state and never returns a payment/order/event/
// donor identifier to a caller outside this process — see
// runReliabilityReconciliation's return type and routes/metrics.ts, which is
// the only caller and only returns bounded counts over a service-identity
// gated endpoint.

export type ReconciliationThresholds = {
  // A payment is "captured" and no LiveEvent exists after this many minutes
  // — long enough that an in-flight webhook transaction (§4.5) could not
  // still be mid-COMMIT, short enough to catch a real gap same-shift.
  capturedPaymentGraceMinutes: number;
  // A delivery is "lost" if it has sat in a non-terminal status this long.
  deliveryStalenessMinutes: number;
  // A refund counts toward the failure gauge if it has been in `failed`
  // status for at least this long (avoids flagging a refund still inside
  // its own retry window).
  refundFailureGraceMinutes: number;
};

export const defaultReconciliationThresholds: ReconciliationThresholds = {
  capturedPaymentGraceMinutes: 15,
  deliveryStalenessMinutes: 30,
  refundFailureGraceMinutes: 15,
};

const TERMINAL_DELIVERY_STATUSES = ['displayed', 'acknowledged', 'quarantined', 'suppressed', 'refunded_after_display'];

export async function runReliabilityReconciliation(
  sql: Sql,
  thresholds: ReconciliationThresholds = defaultReconciliationThresholds,
): Promise<ReconciliationSnapshot> {
  const [missingLiveEventRows, duplicateRows, lostDeliveryRows, webhookLagRows, refundFailureRows] = await Promise.all([
    // A captured payment (§4.5 step 6) must have produced exactly one
    // LiveEvent (§4.5 step 8) linked via alert_events.payment_id. No row on
    // the left side of this anti-join, past the grace window, is money in
    // with nothing on stream.
    sql<{ count: string }[]>`
      select count(*)::text as count
        from payments p
       where p.status = 'captured'
         and p.updated_at < now() - make_interval(mins => ${thresholds.capturedPaymentGraceMinutes})
         and not exists (
           select 1 from alert_events e
            where e.payment_id = p.id and e.source_type = 'payment'
         )
    `,
    // §4.6: UNIQUE(provider, provider_payment_id) makes a duplicate payment
    // row impossible, but that does not by itself prove one LiveEvent per
    // payment — this checks the actual invariant directly.
    sql<{ count: string }[]>`
      select count(*)::text as count from (
        select payment_id from alert_events
         where payment_id is not null and source_type = 'payment'
         group by payment_id
        having count(*) > 1
      ) duplicates
    `,
    // A delivery that never reached a terminal status (displayed,
    // acknowledged, quarantined, suppressed, refunded_after_display) past
    // the staleness window is a lost delivery, not merely a slow one.
    sql<{ count: string }[]>`
      select count(*)::text as count
        from event_outbox_deliveries d
       where d.status not in ${sql(TERMINAL_DELIVERY_STATUSES)}
         and d.updated_at < now() - make_interval(mins => ${thresholds.deliveryStalenessMinutes})
    `,
    // Lag between provider webhook receipt and local payment persistence,
    // joined on the provider payment id captured by both tables.
    sql<{ max_ms: string | null; avg_ms: string | null }[]>`
      select
        coalesce(max(extract(epoch from (p.created_at - w.received_at)) * 1000), 0)::text as max_ms,
        coalesce(avg(extract(epoch from (p.created_at - w.received_at)) * 1000), 0)::text as avg_ms
        from payment_webhook_deliveries w
        join payments p
          on p.provider = w.provider and p.provider_payment_id = w.entity_id
       where w.entity_type = 'payment' and w.processing_status = 'processed'
         and w.received_at > now() - interval '24 hours'
    `,
    sql<{ count: string }[]>`
      select count(*)::text as count
        from refunds r
       where r.status = 'failed'
         and r.updated_at < now() - make_interval(mins => ${thresholds.refundFailureGraceMinutes})
    `,
  ]);

  return {
    capturedPaymentsWithoutLiveEvent: Number(missingLiveEventRows[0]?.count ?? '0'),
    duplicateLiveEvents: Number(duplicateRows[0]?.count ?? '0'),
    lostDeliveries: Number(lostDeliveryRows[0]?.count ?? '0'),
    webhookLagMsMax: Math.round(Number(webhookLagRows[0]?.max_ms ?? '0')),
    webhookLagMsAvg: Math.round(Number(webhookLagRows[0]?.avg_ms ?? '0')),
    refundFailures: Number(refundFailureRows[0]?.count ?? '0'),
    observedAt: new Date().toISOString(),
  };
}
