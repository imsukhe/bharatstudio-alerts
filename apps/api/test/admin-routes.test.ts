import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AdminStore, ChannelEntitlementAdminView, DlqEntry } from '../src/domain/admin.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };
const adminUserId = '00000000-0000-4000-8000-000000000901';
const nonAdminUserId = '00000000-0000-4000-8000-000000000902';
const deliveryId = '00000000-0000-4000-8000-000000000951';

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) {
    if (token === 'a'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000003', userId: adminUserId, expiresAt: '2026-08-17T00:00:00.000Z' };
    if (token === 'b'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000004', userId: nonAdminUserId, expiresAt: '2026-08-17T00:00:00.000Z' };
    return null;
  },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const entry: DlqEntry = {
  deliveryId, eventId: '00000000-0000-4000-8000-000000000931', channelId: '00000000-0000-4000-8000-000000000911',
  channelHandle: 'dlq_channel_a', queueId: '00000000-0000-4000-8000-000000000921', status: 'held', holdReason: 'moderation',
  attemptCount: 0, lastErrorCode: null, createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
};

const entitlementView: ChannelEntitlementAdminView = {
  channelId: '00000000-0000-4000-8000-000000000911', channelHandle: 'dlq_channel_a', version: 2, tier: 'creator',
  source: 'admin_override', values: { queueCount: 8, adminOverrideReason: 'support case #123' }, effectiveAt: '2026-08-16T00:00:00.000Z',
};

function adminOnlyStore(overrides: Partial<AdminStore> = {}): AdminStore {
  return {
    async isPlatformAdmin(userId) { return userId === adminUserId; },
    async listDlq() { return [entry]; },
    async replayDlqDelivery() { return { deliveryId, status: 'ready' }; },
    async discardDlqDelivery() { return { deliveryId, status: 'discarded' }; },
    async getChannelEntitlement() { return entitlementView; },
    async listChannelEntitlementHistory() { return [{ version: 1, tier: entitlementView.tier, source: entitlementView.source, values: entitlementView.values, effectiveAt: entitlementView.effectiveAt, createdAt: entitlementView.effectiveAt }]; },
    async overrideChannelEntitlement() { return entitlementView; },
    ...overrides,
  };
}

test('the admin DLQ list is reachable only by a platform admin, never a plain authenticated user', async () => {
  const app = await buildApp(config, { sessions, admin: adminOnlyStore() });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
  const asAdmin = await app.inject({ method: 'GET', url: '/v1/admin/dlq', headers });
  assert.equal(asAdmin.statusCode, 200);
  assert.deepEqual(asAdmin.json().entries, [entry]);

  const asNonAdmin = await app.inject({ method: 'GET', url: '/v1/admin/dlq', headers: { authorization: `Bearer ${'b'.repeat(48)}` } });
  assert.equal(asNonAdmin.statusCode, 403);
  assert.equal(asNonAdmin.json().errorCode, 'platform_admin_required');

  const unauthenticated = await app.inject({ method: 'GET', url: '/v1/admin/dlq' });
  assert.equal(unauthenticated.statusCode, 401);
  await app.close();
});

test('the admin DLQ endpoints fail closed as 503 without a configured store, never letting an authenticated caller through unchecked', async () => {
  const app = await buildApp(config, { sessions });
  const response = await app.inject({ method: 'GET', url: '/v1/admin/dlq', headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'admin_unavailable');
  await app.close();
});

test('replay forwards the reason and maps a non-replayable delivery to 404, not a 500', async () => {
  let seenReason: string | null | undefined;
  const store = adminOnlyStore({
    async replayDlqDelivery(_userId, _id, reason) { seenReason = reason; return { deliveryId, status: 'ready' }; },
  });
  const app = await buildApp(config, { sessions, admin: store });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };

  const replayed = await app.inject({ method: 'POST', url: `/v1/admin/dlq/${deliveryId}/replay`, headers, payload: { reason: 'ops review: false positive' } });
  assert.equal(replayed.statusCode, 200);
  assert.equal(seenReason, 'ops review: false positive');

  const notReplayableStore = adminOnlyStore({ async replayDlqDelivery() { return null; } });
  const notReplayableApp = await buildApp(config, { sessions, admin: notReplayableStore });
  const notReplayable = await notReplayableApp.inject({ method: 'POST', url: `/v1/admin/dlq/${deliveryId}/replay`, headers, payload: {} });
  assert.equal(notReplayable.statusCode, 404);
  assert.equal(notReplayable.json().errorCode, 'not_replayable');

  await app.close();
  await notReplayableApp.close();
});

test('discard requires a non-empty reason and maps a non-discardable delivery to 404', async () => {
  const app = await buildApp(config, { sessions, admin: adminOnlyStore() });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };

  const missingReason = await app.inject({ method: 'POST', url: `/v1/admin/dlq/${deliveryId}/discard`, headers, payload: {} });
  assert.equal(missingReason.statusCode, 400);

  const discarded = await app.inject({ method: 'POST', url: `/v1/admin/dlq/${deliveryId}/discard`, headers, payload: { reason: 'confirmed spam' } });
  assert.equal(discarded.statusCode, 200);
  assert.equal(discarded.json().status, 'discarded');

  const notDiscardableStore = adminOnlyStore({ async discardDlqDelivery() { return null; } });
  const notDiscardableApp = await buildApp(config, { sessions, admin: notDiscardableStore });
  const notDiscardable = await notDiscardableApp.inject({ method: 'POST', url: `/v1/admin/dlq/${deliveryId}/discard`, headers, payload: { reason: 'already handled' } });
  assert.equal(notDiscardable.statusCode, 404);
  assert.equal(notDiscardable.json().errorCode, 'not_discardable');

  await app.close();
  await notDiscardableApp.close();
});

test('a store failure never leaks provider/database detail through the admin routes', async () => {
  const store = adminOnlyStore({
    async replayDlqDelivery() { throw new Error('connection string contains a secret: postgres://user:pw@host'); },
  });
  const app = await buildApp(config, { sessions, admin: store });
  const response = await app.inject({ method: 'POST', url: `/v1/admin/dlq/${deliveryId}/replay`, headers: { authorization: `Bearer ${'a'.repeat(48)}` }, payload: {} });
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.stringify(response.json()).includes('postgres://'), false);
  await app.close();
});

test('admin entitlement routes are platform-admin-only and return the current view, history and override result', async () => {
  const app = await buildApp(config, { sessions, admin: adminOnlyStore() });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
  const channelId = entitlementView.channelId;

  const current = await app.inject({ method: 'GET', url: `/v1/admin/channels/${channelId}/entitlement`, headers });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().tier, 'creator');

  const history = await app.inject({ method: 'GET', url: `/v1/admin/channels/${channelId}/entitlement/history`, headers });
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().history.length, 1);

  const notAdmin = await app.inject({ method: 'GET', url: `/v1/admin/channels/${channelId}/entitlement`, headers: { authorization: `Bearer ${'b'.repeat(48)}` } });
  assert.equal(notAdmin.statusCode, 403);
  await app.close();
});

test('the entitlement override endpoint forwards queueCount/reason, rejects an out-of-range value, and maps a missing channel to 404', async () => {
  let seen: { channelId: string; queueCount: number; reason: string } | undefined;
  const store = adminOnlyStore({
    async overrideChannelEntitlement(userId, channelId, queueCount, reason) { seen = { channelId, queueCount, reason }; return entitlementView; },
  });
  const app = await buildApp(config, { sessions, admin: store });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
  const channelId = entitlementView.channelId;

  const overridden = await app.inject({ method: 'POST', url: `/v1/admin/channels/${channelId}/entitlement/override`, headers, payload: { queueCount: 8, reason: 'support case #123' } });
  assert.equal(overridden.statusCode, 200);
  assert.deepEqual(seen, { channelId, queueCount: 8, reason: 'support case #123' });

  const outOfRange = await app.inject({ method: 'POST', url: `/v1/admin/channels/${channelId}/entitlement/override`, headers, payload: { queueCount: 0, reason: 'x' } });
  assert.equal(outOfRange.statusCode, 400);

  const missingReason = await app.inject({ method: 'POST', url: `/v1/admin/channels/${channelId}/entitlement/override`, headers, payload: { queueCount: 5 } });
  assert.equal(missingReason.statusCode, 400);
  await app.close();

  const notFoundStore = adminOnlyStore({ async overrideChannelEntitlement() { return null; } });
  const notFoundApp = await buildApp(config, { sessions, admin: notFoundStore });
  const notFound = await notFoundApp.inject({ method: 'POST', url: `/v1/admin/channels/${channelId}/entitlement/override`, headers, payload: { queueCount: 5, reason: 'x' } });
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.json().errorCode, 'channel_not_found');
  await notFoundApp.close();
});
