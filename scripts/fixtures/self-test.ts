// Self-test for the seed/fixture harness: seeds a world, asserts each of the
// 7 required items exists, tears down, asserts the DB is clean again.
// Run: DATABASE_URL_DIRECT=postgres://... tsx scripts/fixtures/self-test.ts
import assert from 'node:assert/strict';
import { ALL_QUEUE_MODES, createFixtureSqlClient, seedWorld, teardownWorld } from './alerts-fixture.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL_DIRECT (or DATABASE_URL) must be set to a disposable test database');

  const sql = createFixtureSqlClient(databaseUrl);
  let passed = 0;
  const total = 8; // 7 world items + 1 post-teardown cleanliness check
  try {
    const worldKey = `selftest-${Date.now()}`;
    const world = await seedWorld(sql, { worldKey, handle: `fixture_${Date.now()}`, tier: 'creator' });
    await seedWorld(sql, { worldKey, handle: world.handle, tier: 'creator' }); // re-run: proves idempotency

    const [channelRow] = await sql`select handle from channels where id = ${world.channelId}::uuid`;
    assert.equal(channelRow?.handle, world.handle, 'channel + entitled user not found');
    passed++;

    const [entitlement] = await sql`select tier from channel_entitlement_versions where channel_id = ${world.channelId}::uuid and version = 1`;
    assert.equal(entitlement?.tier, 'creator', 'entitlement tier not set');
    passed++;

    const [overlay] = await sql`select id from overlay_sessions where id = ${world.overlayId}::uuid and channel_id = ${world.channelId}::uuid`;
    assert.ok(overlay, 'overlay session not found');
    passed++;

    const [paymentAlert] = await sql`select source_type from alert_events where id = ${world.paymentAlertEventId}::uuid and payment_id = ${world.paymentId}::uuid`;
    assert.equal(paymentAlert?.source_type, 'payment', 'captured-payment alert_event not found');
    passed++;

    const [manualAlert] = await sql`select source_type from alert_events where id = ${world.manualAlertEventId}::uuid`;
    assert.equal(manualAlert?.source_type, 'manual', 'manual alert_event not found');
    passed++;

    const [companionAlert] = await sql`select source_type from alert_events where id = ${world.companionAlertEventId}::uuid`;
    assert.equal(companionAlert?.source_type, 'companion', 'companion alert_event not found');
    passed++;

    const queueRows = await sql`select name from alert_queues where channel_id = ${world.channelId}::uuid`;
    assert.equal(queueRows.length, ALL_QUEUE_MODES.length, `expected ${ALL_QUEUE_MODES.length} queues, one per mode`);
    passed++;

    await teardownWorld(sql, world);
    const remaining = await sql`
      select
        (select count(*)::int from channels where id = ${world.channelId}::uuid) +
        (select count(*)::int from app_users where id = ${world.userId}::uuid) +
        (select count(*)::int from alert_events where channel_id = ${world.channelId}::uuid) +
        (select count(*)::int from overlay_sessions where channel_id = ${world.channelId}::uuid) +
        (select count(*)::int from alert_queues where channel_id = ${world.channelId}::uuid) +
        (select count(*)::int from queue_bindings where channel_id = ${world.channelId}::uuid) as total`;
    assert.equal(remaining[0]?.total, 0, 'teardown left rows behind');
    passed++;

    console.log(`SELF-TEST PASS ${passed}/${total}`);
  } catch (err) {
    console.error(`SELF-TEST FAIL at ${passed}/${total} passed`);
    console.error(err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
