// L09 required test: "a duplicated webhook produces exactly one LiveEvent".
// Uses the gated fault-guard.ts primitive (proves it needs the explicit
// switch — apps/api/test/l09-fault-injection-guard.test.ts covers the inert
// case without a database) against the REAL transaction boundary function,
// then asserts against `alert_events` directly and cross-checks with the
// existing duplicate-LiveEvent reconciliation query rather than a new one.
// Run: DATABASE_URL_DIRECT=postgres://... BSA_FAULT_INJECTION_ENABLE=1 NODE_ENV=test \
//   tsx scripts/load/l09-fault-duplicate-webhook-self-test.ts
// (see run-l09-fault-self-test.sh for the disposable-container wrapper,
// which sets both env vars.)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFixtureSqlClient, seedWorld, teardownWorld } from '../fixtures/alerts-fixture.js';
import { ensurePaymentAccount, seedCheckoutIntent, submitVerifiedPaymentWebhook, teardownCheckoutArtifacts } from './webhook-critical-path.js';
import { simulateDuplicateWebhookDelivery } from '../../apps/api/src/observability/fault-guard.js';
import { runReliabilityReconciliation, defaultReconciliationThresholds } from '../../apps/api/src/observability/reconciliation.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL_DIRECT (or DATABASE_URL) must be set to a disposable test database');
  const sql = createFixtureSqlClient(databaseUrl);
  let passed = 0;
  const total = 5;
  const worldKey = `l09-fault-selftest-${Date.now()}`;
  try {
    const world = await seedWorld(sql, { worldKey, handle: `fault_${worldKey}`, tier: 'creator' });
    const connectedAccountRef = `acct-fault-${worldKey}`;
    const paymentAccountId = await ensurePaymentAccount(sql, world.channelId, connectedAccountRef);
    const intent = await seedCheckoutIntent(sql, world, paymentAccountId, connectedAccountRef);
    const providerEventId = randomUUID(); // same event id both times — a retried webhook, not two distinct ones
    const providerPaymentId = `pay_fault_${randomUUID()}`;

    const { first, second } = await simulateDuplicateWebhookDelivery(
      () => submitVerifiedPaymentWebhook(sql, { providerEventId, providerPaymentId, intent }),
    );

    assert.equal(first.duplicate, false, 'first delivery of a new event id must not be flagged duplicate');
    passed++;

    assert.equal(second.duplicate, true, 'second delivery of the SAME event id must be flagged duplicate');
    passed++;

    const events = await sql<{ id: string }[]>`
      select id from alert_events where payment_id = (select id from payments where provider_payment_id = ${providerPaymentId})
    `;
    assert.equal(events.length, 1, `expected exactly one LiveEvent for the duplicated webhook, found ${events.length}`);
    passed++;

    const snapshot = await runReliabilityReconciliation(sql, defaultReconciliationThresholds);
    assert.equal(snapshot.duplicateLiveEvents, 0, 'reconciliation must confirm no duplicate LiveEvent exists after the fault run');
    passed++;

    await teardownCheckoutArtifacts(sql, world.channelId, connectedAccountRef);
    await teardownWorld(sql, world);
    const remaining = await sql<{ total: string }[]>`select count(*)::text as total from channels where id = ${world.channelId}::uuid`;
    assert.equal(remaining[0]?.total, '0', 'teardown left the channel behind');
    passed++;

    console.log(`L09 FAULT SELF-TEST PASS ${passed}/${total}`);
  } catch (err) {
    console.error(`L09 FAULT SELF-TEST FAIL at ${passed}/${total} passed`);
    console.error(err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
