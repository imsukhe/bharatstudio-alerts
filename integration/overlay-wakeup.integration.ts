import assert from 'node:assert/strict';
import postgres from 'postgres';
import { createOverlayWakeup } from '../apps/api/src/db/overlay-wakeup.js';

const databaseUrl = process.env.BSA_OVERLAY_WAKEUP_SQL_DSN;
if (!databaseUrl) {
  throw new Error('BSA_OVERLAY_WAKEUP_SQL_DSN is required for the overlay wake-up integration test');
}

const listenerA = postgres(databaseUrl, { max: 1, prepare: false });
const listenerB = postgres(databaseUrl, { max: 1, prepare: false });
const publisher = postgres(databaseUrl, { max: 1, prepare: false });
const wakeupA = createOverlayWakeup(listenerA, { reconnectDelayMs: 10, maxReconnectDelayMs: 50 });
const wakeupB = createOverlayWakeup(listenerB, { reconnectDelayMs: 10, maxReconnectDelayMs: 50 });

async function waitForConnected(): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (
    (!wakeupA.health?.().connected || !wakeupB.health?.().connected) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(wakeupA.health?.().connected, true, 'first direct PostgreSQL listener did not connect');
  assert.equal(wakeupB.health?.().connected, true, 'second direct PostgreSQL listener did not connect');
}

async function main(): Promise<void> {
  try {
    await waitForConnected();

    const waitingA = wakeupA.wait('overlay-integration-a', 1_500);
    const waitingB = wakeupB.wait('overlay-integration-b', 1_500);
    await publisher`select pg_notify('bharatstudio_overlay_events', ${JSON.stringify({ event: 'integration' })})`;
    await Promise.all([waitingA, waitingB]);

    assert.equal(wakeupA.health?.().failures, 0);
    assert.equal(wakeupB.health?.().failures, 0);
    console.log('OVERLAY_WAKEUP_POSTGRES_TWO_LISTENER_INTEGRATION=PASS');
  } finally {
    await wakeupA.close();
    await wakeupB.close();
    await publisher.end({ timeout: 5 });
  }
}

void main();
