import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AdminStore } from '../src/domain/admin.js';
import { PlatformOwnerError, type PlatformOwnerChange, type PlatformOwnerStore } from '../src/domain/platform-owner.js';

/*
 * Migration 0155, Job 1. Route-layer proof only -- the SQL layer's own
 * proof (the singleton index, self-conferral blocked, audited, the
 * owner+admin conjoint requirement on capability-change approval) lives
 * in packages/db/tests/ctl_emergency_kill_and_owner.sql. This file
 * proves: the platform-admin gate, request-schema validation, the
 * PlatformOwnerError -> HTTP status mapping, and that an unwired store
 * degrades to a safe 503, never a crash.
 */

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4105, appOrigin: 'http://localhost:3105', paymentEnvironment: 'test' };
const adminUserId = '00000000-0000-4000-8000-000000000921';
const nonAdminUserId = '00000000-0000-4000-8000-000000000922';
const targetUserId = '00000000-0000-4000-8000-000000000923';
const headers = { authorization: `Bearer ${'e'.repeat(48)}` };
const nonAdminHeaders = { authorization: `Bearer ${'f'.repeat(48)}` };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) {
    if (token === 'e'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000007', userId: adminUserId, expiresAt: '2026-09-17T00:00:00.000Z' };
    if (token === 'f'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000008', userId: nonAdminUserId, expiresAt: '2026-09-17T00:00:00.000Z' };
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

const sampleChange: PlatformOwnerChange = {
  schemaVersion: 'v1', userId: targetUserId, isPlatformOwner: true, changedBy: adminUserId, changedAt: '2026-09-17T09:00:00.000Z', reason: 'promoting to owner',
};

function fakeStore(overrides: Partial<PlatformOwnerStore> = {}): PlatformOwnerStore {
  return { async setOwner() { return sampleChange; }, ...overrides };
}

test('platform owner: platform-admin gate', async () => {
  const app = await buildApp(config, { sessions, admin, platformOwner: fakeStore() });

  const asAdmin = await app.inject({ method: 'PUT', url: `/v1/admin/platform-owner/${targetUserId}`, headers, payload: { isPlatformOwner: true, reason: 'promoting' } });
  assert.equal(asAdmin.statusCode, 200);
  assert.deepEqual(asAdmin.json(), sampleChange);

  const asNonAdmin = await app.inject({ method: 'PUT', url: `/v1/admin/platform-owner/${targetUserId}`, headers: nonAdminHeaders, payload: { isPlatformOwner: true, reason: 'promoting' } });
  assert.equal(asNonAdmin.statusCode, 403);
  assert.equal(asNonAdmin.json().errorCode, 'platform_admin_required');

  const unauthenticated = await app.inject({ method: 'PUT', url: `/v1/admin/platform-owner/${targetUserId}`, payload: { isPlatformOwner: true, reason: 'promoting' } });
  assert.equal(unauthenticated.statusCode, 401);
  await app.close();
});

test('platform owner: fails closed (503) with no configured store', async () => {
  const app = await buildApp(config, { sessions, admin });
  const response = await app.inject({ method: 'PUT', url: `/v1/admin/platform-owner/${targetUserId}`, headers, payload: { isPlatformOwner: true, reason: 'promoting' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'platform_owner_unavailable');
  await app.close();
});

test('platform owner: request schema -- a missing reason or an undeclared field is rejected (400)', async () => {
  const app = await buildApp(config, { sessions, admin, platformOwner: fakeStore() });

  const missingReason = await app.inject({ method: 'PUT', url: `/v1/admin/platform-owner/${targetUserId}`, headers, payload: { isPlatformOwner: true } });
  assert.equal(missingReason.statusCode, 400);

  const badField = await app.inject({ method: 'PUT', url: `/v1/admin/platform-owner/${targetUserId}`, headers, payload: { isPlatformOwner: true, reason: 'x', notAllowed: true } });
  assert.equal(badField.statusCode, 400);
  await app.close();
});

test('platform owner: PlatformOwnerError reasons map to the documented HTTP status', async () => {
  const cases: Array<{ reason: ConstructorParameters<typeof PlatformOwnerError>[0]; expected: number }> = [
    { reason: 'target_not_found', expected: 404 },
    { reason: 'self_conferral_forbidden', expected: 403 },
    { reason: 'singleton_violation', expected: 409 },
    { reason: 'invalid_input', expected: 400 },
  ];
  for (const { reason, expected } of cases) {
    const app = await buildApp(config, {
      sessions, admin,
      platformOwner: fakeStore({ async setOwner() { throw new PlatformOwnerError(reason, `synthetic ${reason}`); } }),
    });
    const response = await app.inject({ method: 'PUT', url: `/v1/admin/platform-owner/${targetUserId}`, headers, payload: { isPlatformOwner: true, reason: 'promoting' } });
    assert.equal(response.statusCode, expected, reason);
    assert.equal(response.json().errorCode, reason);
    await app.close();
  }
});

test('platform owner: an unexpected store failure degrades to a clean, retryable 503, never a crash', async () => {
  const app = await buildApp(config, {
    sessions, admin,
    platformOwner: fakeStore({ async setOwner() { throw new Error('synthetic db failure'); } }),
  });
  const response = await app.inject({ method: 'PUT', url: `/v1/admin/platform-owner/${targetUserId}`, headers, payload: { isPlatformOwner: true, reason: 'promoting' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});
