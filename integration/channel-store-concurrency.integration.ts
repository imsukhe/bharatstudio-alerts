import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { createSqlChannelStore } from '../apps/api/src/db/channel-store.js';

const dsn = process.env.BSA_CHANNEL_STORE_SQL_DSN;

if (!dsn) {
  throw new Error('BSA_CHANNEL_STORE_SQL_DSN is required');
}

const admin = postgres(dsn, { max: 4, prepare: false });

const ids = {
  user: '00000000-0000-4000-8000-000000000091',
  channel: '00000000-0000-4000-8000-000000000092',
};

async function seed() {
  await admin`insert into app_users (id, external_subject, display_name, created_at, updated_at)
    values (${ids.user}::uuid, ${`channel-store-concurrency-${ids.user}`}, 'Concurrency test', current_timestamp, current_timestamp)`;
  await admin`select channel_id from app_private.create_channel(
    ${ids.channel}::uuid,
    ${ids.user}::uuid,
    ${`concurrency-${ids.channel.slice(-6)}`},
    'Concurrency test channel'
  )`;
  await admin`update channel_entitlement_versions
    set values = jsonb_build_object('queueCount', 2)
    where channel_id = ${ids.channel}::uuid and version = 1`;
}

async function cleanup() {
  await admin`delete from queue_bindings where channel_id = ${ids.channel}::uuid`;
  await admin`delete from alert_queues where channel_id = ${ids.channel}::uuid`;
  await admin`delete from channel_configs where channel_id = ${ids.channel}::uuid`;
  await admin`delete from channel_entitlement_versions where channel_id = ${ids.channel}::uuid`;
  await admin`delete from channel_memberships where channel_id = ${ids.channel}::uuid`;
  await admin`delete from channels where id = ${ids.channel}::uuid`;
  await admin`delete from app_users where id = ${ids.user}::uuid`;
}

test('two concurrent queue creations cannot exceed the channel allocation', async () => {
  await seed();
  try {
    const first = postgres(dsn, { max: 1, prepare: false });
    const second = postgres(dsn, { max: 1, prepare: false });
    try {
      const firstStore = createSqlChannelStore(first);
      const secondStore = createSqlChannelStore(second);
      const results = await Promise.allSettled([
        firstStore.createQueue(ids.user, ids.channel, {
          queueId: '00000000-0000-4000-8000-000000000093',
          name: 'Concurrent queue A',
        }),
        secondStore.createQueue(ids.user, ids.channel, {
          queueId: '00000000-0000-4000-8000-000000000094',
          name: 'Concurrent queue B',
        }),
      ]);

      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      const rejected = results.find((result) => result.status === 'rejected');
      assert.match(String(rejected && rejected.status === 'rejected' ? rejected.reason : ''), /Queue entitlement limit reached/);

      const rows = await admin<{ count: number }[]>`select count(*)::int as count from alert_queues where channel_id = ${ids.channel}::uuid`;
      assert.equal(rows[0]?.count, 2, 'default queue plus exactly one concurrent queue must exist');
    } finally {
      await first.end({ timeout: 5 });
      await second.end({ timeout: 5 });
    }
  } finally {
    await cleanup();
  }
});

test('two concurrent config writes allocate one next version', async () => {
  await seed();
  try {
    const first = postgres(dsn, { max: 1, prepare: false });
    const second = postgres(dsn, { max: 1, prepare: false });
    try {
      const firstStore = createSqlChannelStore(first);
      const secondStore = createSqlChannelStore(second);
      const results = await Promise.all([
        firstStore.updateConfig(ids.user, ids.channel, { source: 'A' }, 1),
        secondStore.updateConfig(ids.user, ids.channel, { source: 'B' }, 1),
      ]);

      assert.equal(results.filter((result) => result !== null).length, 1);
      assert.equal(results.filter((result) => result === null).length, 1);
      const rows = await admin<{ count: number; max_version: number }[]>`
        select count(*)::int as count, max(version)::int as max_version
          from channel_configs
         where channel_id = ${ids.channel}::uuid`;
      assert.equal(rows[0]?.count, 2, 'initial config plus exactly one concurrent next version must exist');
      assert.equal(rows[0]?.max_version, 2);
    } finally {
      await first.end({ timeout: 5 });
      await second.end({ timeout: 5 });
    }
  } finally {
    await cleanup();
  }
});

test.after(async () => {
  await cleanup();
  await admin.end({ timeout: 5 });
});
