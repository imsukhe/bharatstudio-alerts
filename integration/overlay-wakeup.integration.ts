import assert from 'node:assert/strict';
import postgres from 'postgres';
import { createDirectOverlayWakeup, createOverlayWakeup } from '../apps/api/src/db/overlay-wakeup.js';

const databaseUrl = process.env.BSA_OVERLAY_WAKEUP_SQL_DSN;
if (!databaseUrl) {
  throw new Error('BSA_OVERLAY_WAKEUP_SQL_DSN is required for the overlay wake-up integration test');
}

const listenerA = postgres(databaseUrl, { max: 1, prepare: false });
const listenerB = postgres(databaseUrl, { max: 1, prepare: false });
const publisher = postgres(databaseUrl, { max: 1, prepare: false });
const wakeupA = createOverlayWakeup(listenerA, { reconnectDelayMs: 10, maxReconnectDelayMs: 50 });
const wakeupB = createOverlayWakeup(listenerB, { reconnectDelayMs: 10, maxReconnectDelayMs: 50 });
// AUD-RT-03 uses the production direct adapter rather than the injectable
// listener above. Its deliberate 150ms backoff gives this test a deterministic
// interval to observe failed health before replacement registration succeeds.
const directWakeup = createDirectOverlayWakeup(databaseUrl, { reconnectDelayMs: 150, maxReconnectDelayMs: 150 });

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(condition(), true, message);
}

// AUD-SB-01 owns this otherwise isolated id block.  It deliberately creates
// a Free-tier catalogue sound, because trigger_soundboard_play's durable
// creator action is valid at that tier while the overlay render remains
// entitlement-gated.  The test is about committed channel-scoped wake-up
// delivery, not a tier upgrade.
const soundboardIds = {
  user: '00000000-0000-4000-8000-0000000000a1',
  channel: '00000000-0000-4000-8000-0000000000a2',
  catalogueEntry: '00000000-0000-4000-8000-0000000000a3',
};

async function seedSoundboardTriggerFixture(): Promise<void> {
  await publisher`insert into app_users (id, external_subject, display_name, created_at, updated_at)
    values (${soundboardIds.user}::uuid, ${`overlay-wakeup-soundboard-${soundboardIds.user}`}, 'Overlay wake-up soundboard test', current_timestamp, current_timestamp)`;
  await publisher`select channel_id from app_private.create_channel(
    ${soundboardIds.channel}::uuid,
    ${soundboardIds.user}::uuid,
    'overlay_wakeup_soundboard',
    'Overlay wake-up soundboard test channel'
  )`;
  await publisher`insert into soundboard_catalogue_entries (
    id, external_key, display_name, category, min_tier, gcs_object_key,
    content_sha256, mime_type, byte_size, duration_seconds, imported_at, updated_at
  ) values (
    ${soundboardIds.catalogueEntry}::uuid, 'overlay-wakeup-soundboard-clap',
    'Overlay wake-up clap', 'test', 'free', 'soundboard/catalogue/overlay-wakeup-clap',
    ${'a'.repeat(64)}, 'audio/mpeg', 1024, 1, current_timestamp, current_timestamp
  )`;
}

async function cleanupSoundboardTriggerFixture(): Promise<void> {
  // Keep the foreign-key order in lockstep with the real-store integration
  // fixture.  This makes the test repeatable against one disposable database
  // without touching any pre-existing fixture rows.
  await publisher`delete from channel_soundboard_plays where channel_id = ${soundboardIds.channel}::uuid`;
  await publisher`delete from channel_soundboard_uploads where channel_id = ${soundboardIds.channel}::uuid`;
  await publisher`delete from channel_soundboard_disables where channel_id = ${soundboardIds.channel}::uuid`;
  await publisher`delete from soundboard_catalogue_entries where id = ${soundboardIds.catalogueEntry}::uuid`;
  await publisher`delete from queue_bindings where channel_id = ${soundboardIds.channel}::uuid`;
  await publisher`delete from alert_queues where channel_id = ${soundboardIds.channel}::uuid`;
  await publisher`delete from channel_configs where channel_id = ${soundboardIds.channel}::uuid`;
  await publisher`delete from channel_entitlement_versions where channel_id = ${soundboardIds.channel}::uuid`;
  await publisher`delete from channel_memberships where channel_id = ${soundboardIds.channel}::uuid`;
  await publisher`delete from channels where id = ${soundboardIds.channel}::uuid`;
  await publisher`delete from app_users where id = ${soundboardIds.user}::uuid`;
}

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

async function exerciseDirectListenerLoss(): Promise<void> {
  await waitFor(
    () => directWakeup.health().connected,
    'production direct overlay listener did not register before termination rehearsal',
  );
  const subscription = directWakeup.subscribe('overlay-direct-loss');
  assert.ok(subscription, 'direct listener should admit a subscriber with no configured ceiling');
  const waiting = subscription.wait(1_500);
  const listenerRows = await publisher<{ pid: number }[]>`
    select pid
      from pg_stat_activity
     where application_name = 'bharatstudio-alerts-overlay-wakeup'
       and pid <> pg_backend_pid()
     order by backend_start desc
     limit 1
  `;
  const listenerPid = listenerRows[0]?.pid;
  assert.ok(listenerPid, 'could not identify the dedicated direct listener backend for termination rehearsal');
  await publisher`select pg_terminate_backend(${listenerPid})`;

  await assert.rejects(waiting, /overlay_listener_unavailable/, 'terminated listener must fail an in-flight overlay wait');
  assert.equal(directWakeup.health().connected, false, 'terminated listener must not remain represented as healthy');
  assert.equal(directWakeup.health().failures, 1, 'one terminated listener must create one failure record');

  await waitFor(
    () => directWakeup.health().connected,
    'replacement direct listener did not re-register after termination',
  );
  assert.equal(directWakeup.health().reconnects, 1, 'one terminated listener must create one reconnect record');
  const recoveredWait = subscription.wait(1_500);
  await publisher`select pg_notify('bharatstudio_overlay_events', ${JSON.stringify({ channelId: 'overlay-direct-loss', eventId: 'recovered-direct-listener-event' })})`;
  assert.equal(await recoveredWait, 'notification', 'replacement direct listener must deliver a later matching notification');
  subscription.release();
}

async function main(): Promise<void> {
  try {
    await seedSoundboardTriggerFixture();
    await waitForConnected();
    await exerciseDirectListenerLoss();

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

    // AUD-SB-01: prove the real owner/admin security-definer trigger inserts
    // its durable row and wakes only the matching channel's live listener at
    // transaction commit.  This closes the seam between the SQL function and
    // the direct Postgres LISTEN path; a manually-issued pg_notify alone
    // cannot prove that seam.
    const soundboardSubscription = wakeupA.subscribe(soundboardIds.channel);
    assert.ok(soundboardSubscription, 'soundboard channel should admit a subscriber with no configured ceiling');
    const validWake = soundboardSubscription.wait(1_500);
    const triggered = await publisher.begin(async (transaction) => {
      await transaction`select set_config('app.user_id', ${soundboardIds.user}, true)`;
      return await transaction<{ play_id: string }[]>`select app_private.trigger_soundboard_play(
        ${soundboardIds.channel}::uuid,
        ${soundboardIds.catalogueEntry}::uuid,
        null
      ) as play_id`;
    });
    const playId = triggered[0]?.play_id;
    assert.ok(playId, 'the successful trigger must return its durable play id');
    assert.equal(await validWake, 'notification', 'a committed Soundboard play must wake the matching overlay listener');
    const playRows = await publisher<{ count: number }[]>`select count(*)::integer as count
      from channel_soundboard_plays
      where id = ${playId}::uuid and channel_id = ${soundboardIds.channel}::uuid`;
    assert.equal(playRows[0]?.count, 1, 'the wake-up must correspond to one durable Soundboard play row');

    // The function validates before insert/notify.  A rejected request must
    // neither insert nor wake the listener; PostgreSQL would defer any NOTIFY
    // until commit in any case, but this calls the actual failing path.
    const rejectedWake = soundboardSubscription.wait(350);
    await assert.rejects(
      publisher.begin(async (transaction) => {
        await transaction`select set_config('app.user_id', ${soundboardIds.user}, true)`;
        await transaction`select app_private.trigger_soundboard_play(${soundboardIds.channel}::uuid, null, null)`;
      }),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '22023',
      'an invalid Soundboard source must be rejected before durable insertion or wake-up',
    );
    assert.equal(await rejectedWake, 'timeout', 'a rejected Soundboard trigger must not wake an overlay listener');
    soundboardSubscription.release();
    console.log('OVERLAY_WAKEUP_POSTGRES_TWO_LISTENER_CHANNEL_ISOLATION_INTEGRATION=PASS');
  } finally {
    await cleanupSoundboardTriggerFixture();
    await directWakeup.close();
    await wakeupA.close();
    await wakeupB.close();
    await publisher.end({ timeout: 5 });
  }
}

void main();
