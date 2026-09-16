import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Sql } from 'postgres';
import { registerMetricsRoutes } from '../src/routes/metrics.js';
import { createApiMetrics } from '../src/observability/metrics.js';
import { persistReconciliationSnapshot, loadLatestReconciliationSnapshot } from '../src/observability/reconciliation-store.js';
import type { ReconciliationSnapshot } from '../src/observability/metrics.js';

const identity = { verify: async (authorization?: string) => authorization === 'Bearer worker-token' };

// A tiny fake durable store standing in for the real
// app_private.reliability_reconciliation_snapshot singleton row (migration
// 0130). It is intentionally shared *state*, not shared in-process
// behaviour: two separate `mockSql` handles below both read/write this one
// object, exactly the way two separate API instances share one Postgres
// row and nothing else — this is what makes the test a real cross-instance
// proof rather than "read after write in the same object."
function sharedDurableTable(): { row: Record<string, string> | undefined } {
  return { row: undefined };
}

function mockSqlOverTable(table: { row: Record<string, string> | undefined }): Sql {
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('record_reliability_reconciliation_snapshot')) {
      const [captured, duplicate, lost, lagMax, lagAvg, refund, observedAt] = values as [number, number, number, number, number, number, string];
      table.row = {
        captured_payments_without_live_event: String(captured),
        duplicate_live_events: String(duplicate),
        lost_deliveries: String(lost),
        webhook_lag_ms_max: String(lagMax),
        webhook_lag_ms_avg: String(lagAvg),
        refund_failures: String(refund),
        observed_at: observedAt,
      };
      return Promise.resolve([]);
    }
    if (text.includes('latest_reliability_reconciliation_snapshot')) {
      return Promise.resolve(table.row ? [table.row] : []);
    }
    throw new Error(`unexpected query in test fake: ${text}`);
  }) as unknown as Sql;
  return fn;
}

const sampleSnapshot: ReconciliationSnapshot = {
  capturedPaymentsWithoutLiveEvent: 4,
  duplicateLiveEvents: 2,
  lostDeliveries: 9,
  webhookLagMsMax: 1500,
  webhookLagMsAvg: 300,
  refundFailures: 1,
  observedAt: '2026-09-16T00:00:00.000Z',
};

// RT-06.8: reconciliation snapshot correctness across more than one
// process. `sqlOnA` and `sqlOnB` are deliberately two *different* `Sql`
// handles (as two API instances would each hold their own postgres
// connection) that only agree via the shared durable table — nothing about
// this test relies on JS object identity between the two "instances"
// beyond the fact that they are pointed at the same underlying row, the
// same way two real processes are pointed at the same Postgres row.
test('RT-06.8: a snapshot persisted by one process is read back correctly by a second, independent process', async () => {
  const table = sharedDurableTable();
  const sqlOnInstanceA = mockSqlOverTable(table);
  const sqlOnInstanceB = mockSqlOverTable(table);

  await persistReconciliationSnapshot(sqlOnInstanceA, sampleSnapshot);

  const readByInstanceB = await loadLatestReconciliationSnapshot(sqlOnInstanceB);
  assert.deepEqual(readByInstanceB, sampleSnapshot);
});

test('RT-06.8: loadLatestReconciliationSnapshot returns undefined, not zeros, before any process has ever recorded a snapshot', async () => {
  const table = sharedDurableTable();
  const sql = mockSqlOverTable(table);
  assert.equal(await loadLatestReconciliationSnapshot(sql), undefined);
});

test('RT-06.8: a later reconciliation run from a different process replaces the snapshot wholesale, and every instance sees the replacement', async () => {
  const table = sharedDurableTable();
  const sqlOnInstanceA = mockSqlOverTable(table);
  const sqlOnInstanceB = mockSqlOverTable(table);

  await persistReconciliationSnapshot(sqlOnInstanceA, sampleSnapshot);
  const laterSnapshot: ReconciliationSnapshot = { ...sampleSnapshot, capturedPaymentsWithoutLiveEvent: 0, webhookLagMsMax: 250, observedAt: '2026-09-16T00:05:00.000Z' };
  await persistReconciliationSnapshot(sqlOnInstanceB, laterSnapshot);

  const readByInstanceA = await loadLatestReconciliationSnapshot(sqlOnInstanceA);
  assert.deepEqual(readByInstanceA, laterSnapshot);
});

// RT-06.8 at the route level: GET /internal/metrics on an instance that
// never itself ran the reconciliation POST still renders the durable
// snapshot another instance computed — this is the actual defect RT-06
// §3.4 names ("reconciliation snapshots are process-local") being closed.
test('RT-06.8: GET /internal/metrics on an instance with no in-memory snapshot still renders another instance\'s durably recorded snapshot', async () => {
  const table = sharedDurableTable();
  await persistReconciliationSnapshot(mockSqlOverTable(table), sampleSnapshot);

  // A brand-new app + brand-new in-process ApiMetrics — this instance never
  // ran POST /internal/metrics/reconcile itself.
  const app = Fastify();
  const metrics = createApiMetrics();
  await registerMetricsRoutes(app, { metrics, serviceIdentity: identity, sql: mockSqlOverTable(table) });

  const response = await app.inject({ method: 'GET', url: '/internal/metrics', headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /bsa_reconciliation_captured_payments_without_live_event 4/);
  assert.match(response.body, /bsa_reconciliation_lost_deliveries 9/);
  await app.close();
});

test('RT-06.6/RT-06.8: a durable-read failure never fails the scrape — falls back to whatever this instance already holds', async () => {
  const app = Fastify();
  const metrics = createApiMetrics();
  const throwingSql = (() => { throw new Error('connection reset'); }) as unknown as Sql;
  await registerMetricsRoutes(app, { metrics, serviceIdentity: identity, sql: throwingSql });

  const response = await app.inject({ method: 'GET', url: '/internal/metrics', headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200, 'a broken durable read must never turn a scrape into an error response');
});
