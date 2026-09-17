import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AdminStore } from '../src/domain/admin.js';
import { PlatformAdminError, type PlatformAdminChange, type PlatformAdminListEntry, type PlatformAdminStore } from '../src/domain/platform-admin.js';

/*
 * Migration 0156 (ADM-07). Route-layer proof only -- the SQL layer's own
 * proof (self-conferral blocked in both directions, audited,
 * append-only, the bootstrap posture, and every 0149-0155 staff function
 * still authorising) lives in packages/db/tests/adm_admin_registry.sql.
 * This file proves: the platform-admin gate on both new routes plus
 * /v1/admin/whoami, request-schema validation, the
 * PlatformAdminError -> HTTP status mapping, and that an unwired store
 * degrades to a safe 503, never a crash. Modelled directly on
 * platform-owner-routes.test.ts (migration 0155, Job 1).
 */

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4106, appOrigin: 'http://localhost:3106', paymentEnvironment: 'test' };
const adminUserId = '00000000-0000-4000-8000-000000000931';
const nonAdminUserId = '00000000-0000-4000-8000-000000000932';
const targetUserId = '00000000-0000-4000-8000-000000000933';
const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
const nonAdminHeaders = { authorization: `Bearer ${'b'.repeat(48)}` };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) {
    if (token === 'a'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000009', userId: adminUserId, expiresAt: '2026-09-17T00:00:00.000Z' };
    if (token === 'b'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-00000000000a', userId: nonAdminUserId, expiresAt: '2026-09-17T00:00:00.000Z' };
    return null;
  },
  async getCurrentUser() { throw new Error('not used'); }, async list() { return []; }, async revoke() { return false; },
};

const admin: AdminStore = {
  async isPlatformAdmin(userId) { return userId === adminUserId; },
  async listDlq() { return []; },
  async replayDlqDelivery() { return null; },
  async discardDlqDelivery() { return null; },
  async getChannelEntitlement() { return null; },
  async listChannelEntitlementHistory() { return []; },
  async overrideChannelEntitlement() { return null; },
};

const sampleChange: PlatformAdminChange = {
  schemaVersion: 'v1', userId: targetUserId, isPlatformAdmin: true, changedBy: adminUserId, changedAt: '2026-09-17T09:00:00.000Z', reason: 'promoting to admin',
};
const sampleList: PlatformAdminListEntry[] = [
  { userId: adminUserId, displayName: 'Existing Admin', isPlatformAdmin: true, isPlatformOwner: false, grantedBy: null, grantedAt: null, reason: null },
];

function fakeStore(overrides: Partial<PlatformAdminStore> = {}): PlatformAdminStore {
  return { async setAdmin() { return sampleChange; }, async listAdmins() { return sampleList; }, ...overrides };
}

test('platform admin: platform-admin gate on grant/revoke', async () => {
  const app = await buildApp(config, { sessions, admin, platformAdmin: fakeStore() });

  const asAdmin = await app.inject({ method: 'PUT', url: `/v1/admin/platform-admins/${targetUserId}`, headers, payload: { isPlatformAdmin: true, reason: 'promoting' } });
  assert.equal(asAdmin.statusCode, 200);
  assert.deepEqual(asAdmin.json(), sampleChange);

  const asNonAdmin = await app.inject({ method: 'PUT', url: `/v1/admin/platform-admins/${targetUserId}`, headers: nonAdminHeaders, payload: { isPlatformAdmin: true, reason: 'promoting' } });
  assert.equal(asNonAdmin.statusCode, 403);
  assert.equal(asNonAdmin.json().errorCode, 'platform_admin_required');

  const unauthenticated = await app.inject({ method: 'PUT', url: `/v1/admin/platform-admins/${targetUserId}`, payload: { isPlatformAdmin: true, reason: 'promoting' } });
  assert.equal(unauthenticated.statusCode, 401);
  await app.close();
});

test('platform admin: list gated the same way', async () => {
  const app = await buildApp(config, { sessions, admin, platformAdmin: fakeStore() });

  const asAdmin = await app.inject({ method: 'GET', url: '/v1/admin/platform-admins', headers });
  assert.equal(asAdmin.statusCode, 200);
  assert.deepEqual(asAdmin.json(), { schemaVersion: 'v1', admins: sampleList });

  const asNonAdmin = await app.inject({ method: 'GET', url: '/v1/admin/platform-admins', headers: nonAdminHeaders });
  assert.equal(asNonAdmin.statusCode, 403);
  await app.close();
});

test('platform admin: /v1/admin/whoami reflects the durable registry, not a client-side claim', async () => {
  const app = await buildApp(config, { sessions, admin });

  const asAdmin = await app.inject({ method: 'GET', url: '/v1/admin/whoami', headers });
  assert.equal(asAdmin.statusCode, 200);
  assert.deepEqual(asAdmin.json(), { schemaVersion: 'v1', userId: adminUserId, isPlatformAdmin: true });

  const asNonAdmin = await app.inject({ method: 'GET', url: '/v1/admin/whoami', headers: nonAdminHeaders });
  assert.equal(asNonAdmin.statusCode, 403);

  const unauthenticated = await app.inject({ method: 'GET', url: '/v1/admin/whoami' });
  assert.equal(unauthenticated.statusCode, 401);
  await app.close();
});

test('platform admin: fails closed (503) with no configured store', async () => {
  const app = await buildApp(config, { sessions, admin });
  const put = await app.inject({ method: 'PUT', url: `/v1/admin/platform-admins/${targetUserId}`, headers, payload: { isPlatformAdmin: true, reason: 'promoting' } });
  assert.equal(put.statusCode, 503);
  assert.equal(put.json().errorCode, 'platform_admin_unavailable');

  const list = await app.inject({ method: 'GET', url: '/v1/admin/platform-admins', headers });
  assert.equal(list.statusCode, 503);
  await app.close();
});

test('platform admin: request schema -- a missing reason or an undeclared field is rejected (400)', async () => {
  const app = await buildApp(config, { sessions, admin, platformAdmin: fakeStore() });

  const missingReason = await app.inject({ method: 'PUT', url: `/v1/admin/platform-admins/${targetUserId}`, headers, payload: { isPlatformAdmin: true } });
  assert.equal(missingReason.statusCode, 400);

  const badField = await app.inject({ method: 'PUT', url: `/v1/admin/platform-admins/${targetUserId}`, headers, payload: { isPlatformAdmin: true, reason: 'x', notAllowed: true } });
  assert.equal(badField.statusCode, 400);
  await app.close();
});

test('platform admin: PlatformAdminError reasons map to the documented HTTP status', async () => {
  const cases: Array<{ reason: ConstructorParameters<typeof PlatformAdminError>[0]; expected: number }> = [
    { reason: 'target_not_found', expected: 404 },
    { reason: 'self_conferral_forbidden', expected: 403 },
    { reason: 'invalid_input', expected: 400 },
  ];
  for (const { reason, expected } of cases) {
    const app = await buildApp(config, {
      sessions, admin,
      platformAdmin: fakeStore({ async setAdmin() { throw new PlatformAdminError(reason, `synthetic ${reason}`); } }),
    });
    const response = await app.inject({ method: 'PUT', url: `/v1/admin/platform-admins/${targetUserId}`, headers, payload: { isPlatformAdmin: true, reason: 'promoting' } });
    assert.equal(response.statusCode, expected, reason);
    assert.equal(response.json().errorCode, reason);
    await app.close();
  }
});

test('platform admin: an unexpected store failure degrades to a clean, retryable 503, never a crash', async () => {
  const app = await buildApp(config, {
    sessions, admin,
    platformAdmin: fakeStore({ async setAdmin() { throw new Error('synthetic db failure'); } }),
  });
  const response = await app.inject({ method: 'PUT', url: `/v1/admin/platform-admins/${targetUserId}`, headers, payload: { isPlatformAdmin: true, reason: 'promoting' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});
