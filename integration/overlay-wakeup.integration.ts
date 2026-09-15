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

    // RT-02: both wake-up instances hold their own real LISTEN connection
    // to the SAME Postgres channel (bharatstudio_overlay_events) -- Postgres
    // itself has no notion of "channel A vs channel B" here, only this
    // single literal LISTEN channel. Routing to the right overlay/channel
    // subscribers is entirely this module's job, from the notification
    // payload's `channelId`. This proves that against a real database and
    // two real, independent listener connections, not fakes: a
    // notification for channel A resolves only channel A's subscription
    // (on either instance) and never channel B's, even though channel B's
    // own instance received the exact same raw NOTIFY.
    const subscriptionA = wakeupA.subscribe('overlay-integration-a');
    const subscriptionB = wakeupB.subscribe('overlay-integration-b');
    assert.ok(subscriptionA, 'wakeupA should admit a subscriber with no configured ceiling');
    assert.ok(subscriptionB, 'wakeupB should admit a subscriber with no configured ceiling');

    const waitingA = subscriptionA.wait(1_500);
    const waitingB = subscriptionB.wait(1_500);
    await publisher`select pg_notify('bharatstudio_overlay_events', ${JSON.stringify({ channelId: 'overlay-integration-a', eventId: 'integration-event' })})`;
    const [resultA, resultB] = await Promise.all([waitingA, waitingB]);

    assert.equal(resultA, 'notification', 'channel A\'s subscription should resolve from its own channel\'s notification');
    assert.equal(resultB, 'timeout', 'channel B\'s subscription must never resolve from channel A\'s notification');

    assert.equal(wakeupA.health?.().failures, 0);
    assert.equal(wakeupB.health?.().failures, 0);
    subscriptionA.release();
    subscriptionB.release();
    console.log('OVERLAY_WAKEUP_POSTGRES_TWO_LISTENER_CHANNEL_ISOLATION_INTEGRATION=PASS');
  } finally {
    await wakeupA.close();
    await wakeupB.close();
    await publisher.end({ timeout: 5 });
  }
}

void main();
