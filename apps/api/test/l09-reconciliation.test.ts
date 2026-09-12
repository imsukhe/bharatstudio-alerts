import assert from 'node:assert/strict';
import test from 'node:test';
import type { Sql } from 'postgres';
import { runReliabilityReconciliation, defaultReconciliationThresholds } from '../src/observability/reconciliation.js';

// No disposable-PostgreSQL harness is owned by this task (see build report,
// "What cannot be validated without a deployment" — the five real queries
// have been read/reasoned about against packages/db/migrations/0001_v1_
// baseline.sql, never executed). This mocks the `Sql` tagged-template call
// shape closely enough to prove: (a) each of the five queries is issued
// exactly once per run, in the fixed order the Promise.all array declares,
// and (b) the string counts postgres.js returns are mapped to the right
// field on the snapshot — the bug class most likely to survive a read-only
// code review.
function mockSql(responses: unknown[][]): Sql {
  let call = 0;
  const fn = ((...args: unknown[]) => {
    const first = args[0] as { raw?: unknown } | unknown[];
    const isTaggedTemplateCall = first !== null && typeof first === 'object' && 'raw' in (first as object);
    if (isTaggedTemplateCall) {
      const result = responses[call] ?? [];
      call += 1;
      return Promise.resolve(result);
    }
    // sql(array) helper call used inside the "not in (...)" query — return
    // the array through unchanged, it never reaches call-order counting.
    return first;
  }) as unknown as Sql;
  return fn;
}

test('maps five queries to the five snapshot fields in order, not just by shape', async () => {
  const sql = mockSql([
    [{ count: '2' }], // capturedPaymentsWithoutLiveEvent
    [{ count: '1' }], // duplicateLiveEvents
    [{ count: '7' }], // lostDeliveries
    [{ max_ms: '4321', avg_ms: '654' }], // webhook lag
    [{ count: '3' }], // refundFailures
  ]);
  const snapshot = await runReliabilityReconciliation(sql, defaultReconciliationThresholds);
  assert.equal(snapshot.capturedPaymentsWithoutLiveEvent, 2);
  assert.equal(snapshot.duplicateLiveEvents, 1);
  assert.equal(snapshot.lostDeliveries, 7);
  assert.equal(snapshot.webhookLagMsMax, 4321);
  assert.equal(snapshot.webhookLagMsAvg, 654);
  assert.equal(snapshot.refundFailures, 3);
  assert.ok(new Date(snapshot.observedAt).getTime() > 0);
});

test('an all-quiet system reconciles to all zeros, not an error', async () => {
  const sql = mockSql([
    [{ count: '0' }],
    [{ count: '0' }],
    [{ count: '0' }],
    [{ max_ms: '0', avg_ms: '0' }],
    [{ count: '0' }],
  ]);
  const snapshot = await runReliabilityReconciliation(sql);
  assert.deepEqual(
    [snapshot.capturedPaymentsWithoutLiveEvent, snapshot.duplicateLiveEvents, snapshot.lostDeliveries, snapshot.webhookLagMsMax, snapshot.webhookLagMsAvg, snapshot.refundFailures],
    [0, 0, 0, 0, 0, 0],
  );
});

test('missing rows (empty result set) reconcile to zero rather than throwing', async () => {
  const sql = mockSql([[], [], [], [], []]);
  const snapshot = await runReliabilityReconciliation(sql);
  assert.equal(snapshot.capturedPaymentsWithoutLiveEvent, 0);
  assert.equal(snapshot.webhookLagMsMax, 0);
});
