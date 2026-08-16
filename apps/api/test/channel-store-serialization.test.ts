import test from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { createSqlChannelStore } from '../src/db/channel-store.js';

type TaggedQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

function fakeSql(responses: (query: string) => unknown[]): { sql: Sql; queries: string[]; calls: { query: string; values: unknown[] }[] } {
  const queries: string[] = [];
  const calls: { query: string; values: unknown[] }[] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((result, part, index) => `${result}${part}${index < values.length ? `[$${index + 1}]` : ''}`, '');
    queries.push(query);
    calls.push({ query, values });
    return responses(query);
  }) as unknown as TaggedQuery;
  const sql = (() => { throw new Error('root query must not be used'); }) as unknown as Sql;
  const helpers = sql as unknown as {
    begin: (callback: (transaction: TaggedQuery) => Promise<unknown>) => Promise<unknown>;
    json: (value: unknown) => unknown;
  };
  helpers.begin = async (callback) => callback(tx);
  helpers.json = (value) => value;
  return { sql, queries, calls };
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

test('pausing a queue stamps a manual reason, timestamp and actor together', async () => {
  const channelId = '00000000-0000-4000-8000-000000000011';
  const queueId = '00000000-0000-4000-8000-000000000021';
  const userId = '00000000-0000-4000-8000-000000000001';
  const fake = fakeSql((query) => {
    if (query.includes("set_config('app.user_id'")) return [];
    if (query.includes('update alert_queues')) return [{ id: queueId, channel_id: channelId, name: 'Main', is_paused: true, closed_at: null }];
    throw new Error(`unexpected query: ${query}`);
  });

  const queue = await createSqlChannelStore(fake.sql).updateQueue(userId, channelId, queueId, { paused: true });
  assert.equal(queue?.paused, true);

  const updateCall = fake.calls.find((call) => call.query.includes('update alert_queues'));
  assert.ok(updateCall, 'expected an update alert_queues call');
  // The alert_queues_pause_reason_consistency check requires paused_reason
  // and paused_at to be set together with is_paused — this asserts the
  // three parameterised conditions (is_paused, the 'manual' branch guard,
  // the updated_by branch guard) were all evaluated true for a pause, and
  // that 'manual'/current_timestamp are literal SQL, not parameters an
  // attacker-controlled input could ever override.
  assert.equal(updateCall!.query.includes(`then 'manual' else null end`), true);
  assert.equal(updateCall!.query.includes('then current_timestamp else null end'), true);
  assert.deepEqual(updateCall!.values, [null, true, true, true, true, true, true, `user:${userId}`, false, false, queueId, channelId]);
});

test('resuming a queue clears the pause reason, timestamp and stamps the resuming actor', async () => {
  const channelId = '00000000-0000-4000-8000-000000000011';
  const queueId = '00000000-0000-4000-8000-000000000021';
  const userId = '00000000-0000-4000-8000-000000000001';
  const fake = fakeSql((query) => {
    if (query.includes("set_config('app.user_id'")) return [];
    if (query.includes('update alert_queues')) return [{ id: queueId, channel_id: channelId, name: 'Main', is_paused: false, closed_at: null }];
    throw new Error(`unexpected query: ${query}`);
  });

  const queue = await createSqlChannelStore(fake.sql).updateQueue(userId, channelId, queueId, { paused: false });
  assert.equal(queue?.paused, false);

  const updateCall = fake.calls.find((call) => call.query.includes('update alert_queues'));
  assert.deepEqual(updateCall!.values, [null, false, false, false, false, false, false, `user:${userId}`, false, false, queueId, channelId]);
});

test('omitting paused leaves is_paused/paused_reason/paused_at/updated_by unchanged', async () => {
  const channelId = '00000000-0000-4000-8000-000000000011';
  const queueId = '00000000-0000-4000-8000-000000000021';
  const userId = '00000000-0000-4000-8000-000000000001';
  const fake = fakeSql((query) => {
    if (query.includes("set_config('app.user_id'")) return [];
    if (query.includes('update alert_queues')) return [{ id: queueId, channel_id: channelId, name: 'Renamed', is_paused: true, closed_at: null }];
    throw new Error(`unexpected query: ${query}`);
  });

  await createSqlChannelStore(fake.sql).updateQueue(userId, channelId, queueId, { name: 'Renamed' });

  const updateCall = fake.calls.find((call) => call.query.includes('update alert_queues'));
  // input.paused is undefined throughout: coalesce(null, is_paused) keeps
  // is_paused, and every "when ... is null" branch guard is null (true) so
  // paused_reason/paused_at/updated_by all resolve to their own prior
  // column value in SQL — the trailing 'user:...'/false/false parameters
  // are still bound (JS evaluates them unconditionally) but the CASE
  // expressions never select them for this call.
  assert.deepEqual(updateCall!.values, ['Renamed', null, null, false, null, false, null, `user:${userId}`, false, false, queueId, channelId]);
});
