import type { Sql } from 'postgres';
import type { ReconciliationSnapshot } from './metrics.js';

// RT-06 §3.4: "reconciliation snapshots are process-local"
// (`setReconciliationSnapshot` in metrics.ts held the snapshot in a plain
// module variable). That is correct within one process but silently wrong
// the moment more than one API instance serves /internal/metrics: whichever
// instance last ran POST /internal/metrics/reconcile has the real numbers,
// and every other instance's scrape renders stale or all-zero gauges with
// no indication anything is wrong.
//
// Fix: persist the snapshot durably (migration 0130,
// app_private.record_reliability_reconciliation_snapshot /
// app_private.latest_reliability_reconciliation_snapshot) as the
// cross-instance-correct source, and have every /internal/metrics scrape
// read it. The in-memory `setReconciliationSnapshot` call in routes/
// metrics.ts is kept, not removed — it is what makes a *single* instance's
// scrape correct even if the durable read below ever fails, per RT-06.6
// (a metrics failure must never take the whole scrape down).
//
// Same access boundary as every other L09 reconciliation read: this is the
// same `sql` client already used directly by reconciliation.ts, gated by
// the identical /internal/metrics/* service-identity check. No payment,
// order, event, channel or donor identifier is stored here — only the
// seven bounded L09 counts/timestamps ReconciliationSnapshot already
// carries (see metrics.ts and reconciliation.ts).

export async function persistReconciliationSnapshot(sql: Sql, snapshot: ReconciliationSnapshot): Promise<void> {
  await sql`
    select app_private.record_reliability_reconciliation_snapshot(
      ${snapshot.capturedPaymentsWithoutLiveEvent}::bigint,
      ${snapshot.duplicateLiveEvents}::bigint,
      ${snapshot.lostDeliveries}::bigint,
      ${snapshot.webhookLagMsMax}::bigint,
      ${snapshot.webhookLagMsAvg}::bigint,
      ${snapshot.refundFailures}::bigint,
      ${snapshot.observedAt}::timestamptz
    )
  `;
}

type LatestSnapshotRow = {
  captured_payments_without_live_event: string | number;
  duplicate_live_events: string | number;
  lost_deliveries: string | number;
  webhook_lag_ms_max: string | number;
  webhook_lag_ms_avg: string | number;
  refund_failures: string | number;
  observed_at: string | Date;
};

// Returns undefined when no reconciliation run has ever been durably
// recorded (fresh database, or every instance has only ever run the
// in-memory path) — same "not yet computed" meaning the in-memory
// `reconciliation === undefined` case already had; callers must keep
// treating that as "no data yet," never as "all clear."
export async function loadLatestReconciliationSnapshot(sql: Sql): Promise<ReconciliationSnapshot | undefined> {
  const rows = await sql<LatestSnapshotRow[]>`
    select * from app_private.latest_reliability_reconciliation_snapshot()
  `;
  const row = rows[0];
  if (!row) return undefined;
  return {
    capturedPaymentsWithoutLiveEvent: Number(row.captured_payments_without_live_event),
    duplicateLiveEvents: Number(row.duplicate_live_events),
    lostDeliveries: Number(row.lost_deliveries),
    webhookLagMsMax: Number(row.webhook_lag_ms_max),
    webhookLagMsAvg: Number(row.webhook_lag_ms_avg),
    refundFailures: Number(row.refund_failures),
    observedAt: new Date(row.observed_at).toISOString(),
  };
}
