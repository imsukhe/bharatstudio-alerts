// L09 required test: "a load run reports the two invariants" + "the harness
// tears down cleanly". Runs a small load through runLoadTest and asserts:
//   1. the report actually carries both invariant fields, and both are 0
//      (no lost captured payment, no duplicate LiveEvent) on a normal run
//      with no fault injected;
//   2. after the run, nothing belonging to this worldKey remains in the
//      database — teardownWorld plus teardownCheckoutArtifacts left it
//      clean, the same post-teardown-cleanliness check scripts/fixtures/
//      self-test.ts already applies to its own tables.
// Run: DATABASE_URL_DIRECT=postgres://... tsx scripts/load/l09-load-invariants-self-test.ts
// (see run-l09-load-self-test.sh for the disposable-container wrapper.)
import assert from 'node:assert/strict';
import { createFixtureSqlClient } from '../fixtures/alerts-fixture.js';
import { runLoadTest } from './load-harness.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL_DIRECT (or DATABASE_URL) must be set to a disposable test database');
  const sql = createFixtureSqlClient(databaseUrl);
  let passed = 0;
  const total = 5;
  try {
    const worldKey = `l09-load-selftest-${Date.now()}`;
    const report = await runLoadTest(sql, { worldKey, tipCount: 20, concurrency: 5 });

    assert.equal(report.tipCount, 20, 'report tipCount mismatch');
    passed++;

    assert.equal(report.succeeded + report.failed + report.quarantined, 20, 'every tip must be accounted for exactly once');
    passed++;

    assert.equal(report.invariants.capturedPaymentsWithoutLiveEvent, 0, 'a normal run must not lose a captured payment');
    passed++;

    assert.equal(report.invariants.duplicateLiveEvents, 0, 'a normal run must not duplicate a LiveEvent');
    passed++;

    // Teardown cleanliness: nothing tagged with this worldKey's channel
    // handle remains. runLoadTest already called teardownCheckoutArtifacts
    // + teardownWorld internally; this re-derives the channel the same way
    // alerts-fixture.ts does and confirms it is gone.
    const handle = `load_${worldKey}`;
    const remaining = await sql<{ total: string }[]>`select count(*)::text as total from channels where handle = ${handle}`;
    assert.equal(remaining[0]?.total, '0', 'teardown left the channel behind');
    passed++;

    console.log(`L09 LOAD SELF-TEST PASS ${passed}/${total}`);
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.error(`L09 LOAD SELF-TEST FAIL at ${passed}/${total} passed`);
    console.error(err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
