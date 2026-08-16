import test from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { createSqlChannelStore } from '../src/db/channel-store.js';

type TaggedQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

function fakeSql(responses: (query: string) => unknown[]): { sql: Sql; queries: string[] } {
  const queries: string[] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((result, part, index) => `${result}${part}${index < values.length ? `[$${index + 1}]` : ''}`, '');
    queries.push(query);
    return responses(query);
  }) as unknown as TaggedQuery;
  const sql = (() => { throw new Error('root query must not be used'); }) as unknown as Sql;
  const helpers = sql as unknown as {
    begin: (callback: (transaction: TaggedQuery) => Promise<unknown>) => Promise<unknown>;
    json: (value: unknown) => unknown;
  };
  helpers.begin = async (callback) => callback(tx);
  helpers.json = (value) => value;
  return { sql, queries };
}

test('queue creation locks the channel before evaluating the entitlement count', async () => {
  const channelId = '00000000-0000-4000-8000-000000000011';
  const queueId = '00000000-0000-4000-8000-000000000021';
  const fake = fakeSql((query) => {
    if (query.includes("set_config('app.user_id'")) return [];
    if (query.includes('select id') && query.includes('for update')) return [];
    if (query.includes("values->>'queueCount'")) return [{ queue_count_text: '1' }];
    if (query.includes('count(*)::int as queue_count')) return [{ queue_count: 0 }];
    if (query.includes('insert into alert_queues')) return [{ id: queueId, channel_id: channelId, name: 'Main', is_paused: false, closed_at: null }];
    if (query.includes('insert into queue_bindings')) return [];
    throw new Error(`unexpected query: ${query}`);
  });

  const queue = await createSqlChannelStore(fake.sql).createQueue('00000000-0000-4000-8000-000000000001', channelId, { queueId, name: 'Main' });
  assert.equal(queue.queueId, queueId);
  const lockIndex = fake.queries.findIndex((query) => query.includes('select id') && query.includes('for update'));
  const entitlementIndex = fake.queries.findIndex((query) => query.includes("values->>'queueCount'"));
  assert.ok(lockIndex >= 0);
  assert.ok(entitlementIndex > lockIndex);
});

test('configuration updates lock the channel before allocating the next version', async () => {
  const channelId = '00000000-0000-4000-8000-000000000011';
  const fake = fakeSql((query) => {
    if (query.includes("set_config('app.user_id'")) return [];
    if (query.includes('select id') && query.includes('for update')) return [];
    if (query.includes('coalesce(max(version), 0)')) return [{ version: 2 }];
    if (query.includes('select values from channel_entitlement_versions')) return [{ values: {} }];
    if (query.includes('insert into channel_configs')) return [{ channel_id: channelId, version: 3, values: {}, effective_at: new Date('2026-08-15T00:00:00Z') }];
    throw new Error(`unexpected query: ${query}`);
  });

  const config = await createSqlChannelStore(fake.sql).updateConfig('00000000-0000-4000-8000-000000000001', channelId, {}, 2);
  assert.equal(config?.version, 3);
  const lockIndex = fake.queries.findIndex((query) => query.includes('select id') && query.includes('for update'));
  const versionIndex = fake.queries.findIndex((query) => query.includes('coalesce(max(version), 0)'));
  assert.ok(lockIndex >= 0);
  assert.ok(versionIndex > lockIndex);
});

test('configuration updates reject a queue mode outside the published entitlement', async () => {
  const channelId = '00000000-0000-4000-8000-000000000011';
  const fake = fakeSql((query) => {
    if (query.includes("set_config('app.user_id'")) return [];
    if (query.includes('select id') && query.includes('for update')) return [];
    if (query.includes('coalesce(max(version), 0)')) return [{ version: 2 }];
    if (query.includes('select values from channel_entitlement_versions')) {
      return [{ values: { configFeatures: { allowedQueueModes: ['fifo'] } } }];
    }
    throw new Error(`unexpected query: ${query}`);
  });

  await assert.rejects(
    createSqlChannelStore(fake.sql).updateConfig(
      '00000000-0000-4000-8000-000000000001',
      channelId,
      { queue: { mode: 'aggregated' } },
      2,
    ),
    /ERR_ENTITLEMENT_QUEUE_MODE/,
  );
});
