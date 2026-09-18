import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp as rawBuildApp, type AppDependencies } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AdminStore } from '../src/domain/admin.js';
import type { AdminPasskeyStore } from '../src/domain/admin-passkeys.js';
import type { CapabilityMatrixAdminStore, CapabilityMatrixSnapshotSummary } from '../src/domain/capability-matrix-admin.js';
import type { MarketingRevalidateResult, MarketingRevalidateWebhook } from '../src/domain/marketing-revalidate-webhook.js';

/*
 * CTL-10/CTL-11 (migration 0160). Route-layer proof only -- the SQL
 * layer's own proof lives in packages/db/tests/
 * ctl_public_capability_matrix.sql. This file proves: the platform-admin
 * gate, request-schema validation, that a publish succeeds and returns a
 * snapshot summary regardless of webhook outcome (CTL-11: a webhook
 * failure must never fail the publish), and that an unwired store
 * degrades to a safe 503, never a crash.
 */

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4106, appOrigin: 'http://localhost:3106', paymentEnvironment: 'test' };
const adminUserId = '00000000-0000-4000-8000-000000000921';
const nonAdminUserId = '00000000-0000-4000-8000-000000000922';
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
const mfa: AdminPasskeyStore = { async list() { return []; }, async begin() {}, async finishRegistration() {}, async finishAssertion() { return '2026-09-18T00:00:00.000Z'; }, async isVerified() { return true; }, async requestRecovery() { return '00000000-0000-4000-8000-00000000aa01'; }, async listPendingRecoveries() { return []; }, async approveRecovery() { return { status: 'awaiting_second_approval' as const, completedAt: null }; } };
function buildApp(testConfig: RuntimeConfig, dependencies: AppDependencies) { return rawBuildApp(testConfig, { ...dependencies, adminPasskeys: mfa, adminWebAuthn: { rpId: 'admin.test', origins: ['http://localhost:3106'], challengeTtlSeconds: 60, mfaMaxAgeSeconds: 60 } }); }

const sampleSnapshot: CapabilityMatrixSnapshotSummary = {
  schemaVersion: 'v1',
  id: '00000000-0000-4000-8000-000000007499',
  version: 4,
  publishedAt: '2026-09-17T09:00:00.000Z',
  publishedBy: adminUserId,
  reason: 'route-test publish',
  rowCount: 2,
};

function fakeStore(overrides: Partial<CapabilityMatrixAdminStore> = {}): CapabilityMatrixAdminStore {
  return {
    async publish() { return sampleSnapshot; },
    async listSnapshots() { return [sampleSnapshot]; },
    ...overrides,
  };
}

function fakeWebhook(result: MarketingRevalidateResult): MarketingRevalidateWebhook {
  return { async notify() { return result; } };
}

test('capability matrix admin: platform-admin gate, same posture as capability registry admin', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityMatrixAdmin: fakeStore(), marketingRevalidateWebhook: fakeWebhook({ attempted: true, delivered: true, statusCode: 200 }) });

  const asAdmin = await app.inject({ method: 'GET', url: '/v1/admin/capability-matrix/snapshots', headers });
  assert.equal(asAdmin.statusCode, 200);

  const asNonAdmin = await app.inject({ method: 'GET', url: '/v1/admin/capability-matrix/snapshots', headers: nonAdminHeaders });
  assert.equal(asNonAdmin.statusCode, 403);
  assert.equal(asNonAdmin.json().errorCode, 'platform_admin_required');

  const unauthenticated = await app.inject({ method: 'GET', url: '/v1/admin/capability-matrix/snapshots' });
  assert.equal(unauthenticated.statusCode, 401);

  const publishAsNonAdmin = await app.inject({ method: 'POST', url: '/v1/admin/capability-matrix/publish', headers: nonAdminHeaders, payload: { reason: 'x' } });
  assert.equal(publishAsNonAdmin.statusCode, 403);
  await app.close();
});

test('capability matrix admin: every route fails closed (503) with no configured store', async () => {
  const app = await buildApp(config, { sessions, admin });
  const publish = await app.inject({ method: 'POST', url: '/v1/admin/capability-matrix/publish', headers, payload: { reason: 'x' } });
  assert.equal(publish.statusCode, 503);
  assert.equal(publish.json().errorCode, 'capability_matrix_admin_unavailable');

  const list = await app.inject({ method: 'GET', url: '/v1/admin/capability-matrix/snapshots', headers });
  assert.equal(list.statusCode, 503);
  await app.close();
});

test('capability matrix admin: publish requires a non-empty reason; an undeclared field is rejected', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityMatrixAdmin: fakeStore() });

  const missingReason = await app.inject({ method: 'POST', url: '/v1/admin/capability-matrix/publish', headers, payload: {} });
  assert.equal(missingReason.statusCode, 400);

  const emptyReason = await app.inject({ method: 'POST', url: '/v1/admin/capability-matrix/publish', headers, payload: { reason: '' } });
  assert.equal(emptyReason.statusCode, 400);

  const extraField = await app.inject({ method: 'POST', url: '/v1/admin/capability-matrix/publish', headers, payload: { reason: 'ok', extra: true } });
  assert.equal(extraField.statusCode, 400);
  await app.close();
});

test('capability matrix admin: publish succeeds and reports webhook delivery when the webhook succeeds', async () => {
  const app = await buildApp(config, {
    sessions, admin, capabilityMatrixAdmin: fakeStore(),
    marketingRevalidateWebhook: fakeWebhook({ attempted: true, delivered: true, statusCode: 200 }),
  });
  const response = await app.inject({ method: 'POST', url: '/v1/admin/capability-matrix/publish', headers, payload: { reason: 'route-test publish' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.version, 4);
  assert.equal(body.rowCount, 2);
  assert.equal(body.webhookAttempted, true);
  assert.equal(body.webhookDelivered, true);
  await app.close();
});

test('capability matrix admin: CTL-11 -- a webhook failure never fails the publish', async () => {
  const app = await buildApp(config, {
    sessions, admin, capabilityMatrixAdmin: fakeStore(),
    marketingRevalidateWebhook: fakeWebhook({ attempted: true, delivered: false, statusCode: 500 }),
  });
  const response = await app.inject({ method: 'POST', url: '/v1/admin/capability-matrix/publish', headers, payload: { reason: 'route-test publish' } });
  assert.equal(response.statusCode, 200, 'the publish itself must still succeed');
  assert.equal(response.json().webhookAttempted, true);
  assert.equal(response.json().webhookDelivered, false);
  await app.close();
});

test('capability matrix admin: CTL-11 -- a webhook that throws is caught, never crashes the request', async () => {
  const app = await buildApp(config, {
    sessions, admin, capabilityMatrixAdmin: fakeStore(),
    marketingRevalidateWebhook: { async notify() { throw new Error('synthetic network failure'); } },
  });
  const response = await app.inject({ method: 'POST', url: '/v1/admin/capability-matrix/publish', headers, payload: { reason: 'route-test publish' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().webhookDelivered, false);
  await app.close();
});

test('capability matrix admin: publish succeeds even with no webhook configured at all', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityMatrixAdmin: fakeStore() });
  const response = await app.inject({ method: 'POST', url: '/v1/admin/capability-matrix/publish', headers, payload: { reason: 'route-test publish' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().webhookAttempted, false);
  assert.equal(response.json().webhookDelivered, false);
  await app.close();
});

test('capability matrix admin: list snapshots returns the store summaries', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityMatrixAdmin: fakeStore() });
  const response = await app.inject({ method: 'GET', url: '/v1/admin/capability-matrix/snapshots', headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', snapshots: [sampleSnapshot] });
  await app.close();
});

test('capability matrix admin: an unexpected store failure on publish degrades to a clean, retryable 503, never a crash', async () => {
  const app = await buildApp(config, {
    sessions, admin,
    capabilityMatrixAdmin: fakeStore({ async publish() { throw new Error('synthetic db failure'); } }),
  });
  const response = await app.inject({ method: 'POST', url: '/v1/admin/capability-matrix/publish', headers, payload: { reason: 'x' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});
