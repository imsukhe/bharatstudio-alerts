import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { createSqlSafeSoundboardStore } from '../apps/api/src/db/safe-soundboard-store.js';

/*
 * PRF-02 slice 7 hostile-review finding #2 (low): the SQL errcode ->
 * TypeScript outcome mapping for the soundboard's "caps not configured"
 * case was covered by NEITHER layer.
 *
 * apps/api/src/db/safe-soundboard-store.ts:138 maps Postgres errcode
 * 55000 (raised by app_private.upload_channel_soundboard_clip when
 * either duration/byte-size cap is unset -- migration 0143's header:
 * "unset means the upload path is INERT, never unlimited") to
 * `{ outcome: 'caps_not_configured' }`.
 *
 * packages/db/tests/prf02_slice7_safe_soundboard.sql proves the SQL side
 * raises 55000 (stops at SQL, never touches the TypeScript mapping).
 * apps/api/test/prf02-slice7-safe-soundboard-routes.test.ts stubs
 * SafeSoundboardStore entirely (never calls createSqlSafeSoundboardStore,
 * so it never touches the isPgErrorWithCode(error, '55000') branch
 * either). If the SQL errcode this function raises ever changed -- to a
 * different SQLSTATE, or if the check were reordered behind a different
 * failure -- both suites would stay green and the mapping in production
 * would quietly stop working (uploads would either throw an unhandled
 * error or be misreported as `invalid`).
 *
 * This file closes that seam: it calls createSqlSafeSoundboardStore's
 * REAL `uploadClip` against a REAL Postgres database with
 * `caps.maxDurationSeconds` / `caps.maxByteSize` genuinely undefined
 * (never `??`-defaulted to a chosen number -- see the store's own
 * header), and asserts the outcome the TypeScript layer actually
 * produces is `'caps_not_configured'`. Follows the identical pattern
 * ../integration/channel-store-concurrency.integration.ts already
 * establishes in this repository for store-against-database coverage:
 * a `BSA_*_SQL_DSN` env var, a real `postgres()` connection, the real
 * `createSql*Store` factory, seeded via raw SQL, run with `node:test`,
 * wired into packages/db/tests/run-l03-application-behavior.sh's
 * Go/TS integration leg alongside overlay-wakeup, overlay-cross-replica
 * and channel-store-concurrency.
 */

const dsn = process.env.BSA_SAFE_SOUNDBOARD_SQL_DSN;

if (!dsn) {
  throw new Error('BSA_SAFE_SOUNDBOARD_SQL_DSN is required');
}

const admin = postgres(dsn, { max: 4, prepare: false });

const ids = {
  user: '00000000-0000-4000-8000-000000000095',
  channel: '00000000-0000-4000-8000-000000000096',
};

async function seed() {
  await admin`insert into app_users (id, external_subject, display_name, created_at, updated_at)
    values (${ids.user}::uuid, ${`safe-soundboard-caps-${ids.user}`}, 'Soundboard caps test', current_timestamp, current_timestamp)`;
  await admin`select channel_id from app_private.create_channel(
    ${ids.channel}::uuid,
    ${ids.user}::uuid,
    ${`sb-caps-${ids.channel.slice(-6)}`},
    'Soundboard caps test channel'
  )`;
}

async function cleanup() {
  // FK order matches ../integration/channel-store-concurrency.integration.ts's
  // own cleanup() exactly -- app_private.create_channel seeds a default
  // alert_queues row (with a queue_bindings row), which must be deleted
  // before the channel itself can be.
  await admin`delete from channel_soundboard_plays where channel_id = ${ids.channel}::uuid`;
  await admin`delete from channel_soundboard_uploads where channel_id = ${ids.channel}::uuid`;
  await admin`delete from channel_soundboard_disables where channel_id = ${ids.channel}::uuid`;
  await admin`delete from queue_bindings where channel_id = ${ids.channel}::uuid`;
  await admin`delete from alert_queues where channel_id = ${ids.channel}::uuid`;
  await admin`delete from channel_configs where channel_id = ${ids.channel}::uuid`;
  await admin`delete from channel_entitlement_versions where channel_id = ${ids.channel}::uuid`;
  await admin`delete from channel_memberships where channel_id = ${ids.channel}::uuid`;
  await admin`delete from channels where id = ${ids.channel}::uuid`;
  await admin`delete from app_users where id = ${ids.user}::uuid`;
}

test('uploadClip against a real database with both caps unset maps Postgres errcode 55000 to outcome caps_not_configured', async () => {
  await seed();
  try {
    const conn = postgres(dsn, { max: 1, prepare: false });
    try {
      const store = createSqlSafeSoundboardStore(conn);

      // Both caps genuinely undefined -- never `?? somenumber`, exactly
      // as apps/api/src/index.ts wires safeSoundboardUploadCaps from
      // config.soundboardUploadMaxDurationSeconds /
      // config.soundboardUploadMaxByteSize, which are themselves unset
      // in every environment today (migration 0143's header).
      const result = await store.uploadClip(
        ids.user,
        ids.channel,
        {
          displayName: 'Caps seam probe',
          contentSha256: 'a'.repeat(64),
          mimeType: 'audio/mpeg',
          byteSize: 1024,
          durationSeconds: 3,
          rightsAttested: true,
        },
        { maxDurationSeconds: undefined, maxByteSize: undefined },
      );

      assert.equal(
        result.outcome,
        'caps_not_configured',
        `expected the real store to map errcode 55000 to 'caps_not_configured' against a real database, got ${JSON.stringify(result)}`,
      );

      const rows = await admin<{ count: number }[]>`select count(*)::int as count from channel_soundboard_uploads where channel_id = ${ids.channel}::uuid`;
      assert.equal(rows[0]?.count, 0, 'an unset-caps upload must insert nothing -- the control is inert, not unlimited');
    } finally {
      await conn.end({ timeout: 5 });
    }
  } finally {
    await cleanup();
  }
});

test.after(async () => {
  await cleanup();
  await admin.end({ timeout: 5 });
});
