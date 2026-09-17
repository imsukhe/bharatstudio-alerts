import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AdminStore } from '../src/domain/admin.js';
import {
  CapabilityKillEventError,
  type CapabilityKillEvent,
  type CapabilityKillEventStore,
  type KillExtensionRequest,
} from '../src/domain/capability-kill-events.js';

/*
 * Migration 0155, Job 2. Route-layer proof only -- the SQL layer's own
 * proof (every §20.6.1 row, read-time auto-revert, the append-only log,
 * the review-blocks-next-kill rule, the never-a-tier-or-pricing-change
 * structural guarantee) lives in packages/db/tests/
 * ctl_emergency_kill_and_owner.sql. This file proves: the platform-admin
 * gate, request-schema validation, the CapabilityKillEventError -> HTTP
 * status mapping, and that an unwired store degrades to a safe 503,
 * never a crash.
 */

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4106, appOrigin: 'http://localhost:3106', paymentEnvironment: 'test' };
const adminUserId = '00000000-0000-4000-8000-000000000931';
const nonAdminUserId = '00000000-0000-4000-8000-000000000932';
const headers = { authorization: `Bearer ${'g'.repeat(48)}` };
const nonAdminHeaders = { authorization: `Bearer ${'h'.repeat(48)}` };
const killEventId = '00000000-0000-4000-8000-000000000940';
const extensionRequestId = '00000000-0000-4000-8000-000000000941';

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) {
    if (token === 'g'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000009', userId: adminUserId, expiresAt: '2026-09-17T00:00:00.000Z' };
    if (token === 'h'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-00000000000a', userId: nonAdminUserId, expiresAt: '2026-09-17T00:00:00.000Z' };
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

const sampleEvent: CapabilityKillEvent = {
  schemaVersion: 'v1', id: killEventId, capabilityKey: 'ctl_probe', firedBy: adminUserId,
  firedAt: '2026-09-17T09:00:00.000Z', reason: 'incident', affectedChannelCount: 10, liveChannelCount: 2,
  expiresAt: '2026-09-18T09:00:00.000Z', ratifiedBy: null, ratifiedAt: null, escalatedToOwner: false,
  reverted: false, reviewed: false, reviewedBy: null, reviewedAt: null, reviewText: null,
};

const sampleExtension: KillExtensionRequest = {
  id: extensionRequestId, killEventId, requestedBy: adminUserId, requestedAt: '2026-09-17T10:00:00.000Z',
  newExpiresAt: '2026-09-18T11:00:00.000Z', reason: 'still active',
};

function fakeStore(overrides: Partial<CapabilityKillEventStore> = {}): CapabilityKillEventStore {
  return {
    async fireKill() { return sampleEvent; },
    async ratifyKill() { return { ...sampleEvent, ratifiedBy: adminUserId, ratifiedAt: '2026-09-17T09:30:00.000Z' }; },
    async proposeExtension() { return sampleExtension; },
    async approveExtension() { return sampleEvent; },
    async fileReview() { return { ...sampleEvent, reviewed: true, reviewedBy: adminUserId, reviewText: 'contained' }; },
    async getKillEvent() { return sampleEvent; },
    async listKillEvents() { return [sampleEvent]; },
    ...overrides,
  };
}

test('capability kill events: platform-admin gate, same posture as every other admin surface', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityKillEvents: fakeStore() });

  const asAdmin = await app.inject({ method: 'GET', url: '/v1/admin/emergency-kills', headers });
  assert.equal(asAdmin.statusCode, 200);
  assert.deepEqual(asAdmin.json(), { schemaVersion: 'v1', events: [sampleEvent] });

  const asNonAdmin = await app.inject({ method: 'GET', url: '/v1/admin/emergency-kills', headers: nonAdminHeaders });
  assert.equal(asNonAdmin.statusCode, 403);

  const unauthenticated = await app.inject({ method: 'GET', url: '/v1/admin/emergency-kills' });
  assert.equal(unauthenticated.statusCode, 401);
  await app.close();
});

test('capability kill events: every route fails closed (503) with no configured store', async () => {
  const app = await buildApp(config, { sessions, admin });
  const routes: Array<{ method: 'GET' | 'POST'; url: string; payload?: Record<string, unknown> }> = [
    { method: 'POST', url: '/v1/admin/capability-registry/ctl_probe/emergency-kill', payload: { reason: 'x', affectedChannelCount: 1, liveChannelCount: 1 } },
    { method: 'POST', url: `/v1/admin/emergency-kills/${killEventId}/ratify` },
    { method: 'POST', url: `/v1/admin/emergency-kills/${killEventId}/extensions`, payload: { newExpiresAt: '2026-09-18T11:00:00.000Z', reason: 'x' } },
    { method: 'POST', url: `/v1/admin/emergency-kills/extensions/${extensionRequestId}/approve` },
    { method: 'POST', url: `/v1/admin/emergency-kills/${killEventId}/review`, payload: { reviewText: 'contained' } },
    { method: 'GET', url: `/v1/admin/emergency-kills/${killEventId}` },
    { method: 'GET', url: '/v1/admin/emergency-kills' },
  ];
  for (const route of routes) {
    const response = await app.inject({ method: route.method, url: route.url, headers, payload: route.payload });
    assert.equal(response.statusCode, 503, `${route.method} ${route.url}`);
    assert.equal(response.json().errorCode, 'capability_kill_events_unavailable');
  }
  await app.close();
});

test('capability kill events: fire/ratify/extend/review happy paths', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityKillEvents: fakeStore() });

  const fired = await app.inject({ method: 'POST', url: '/v1/admin/capability-registry/ctl_probe/emergency-kill', headers, payload: { reason: 'incident', affectedChannelCount: 10, liveChannelCount: 2 } });
  assert.equal(fired.statusCode, 201);
  assert.equal(fired.json().capabilityKey, 'ctl_probe');

  const ratified = await app.inject({ method: 'POST', url: `/v1/admin/emergency-kills/${killEventId}/ratify`, headers });
  assert.equal(ratified.statusCode, 200);
  assert.equal(ratified.json().ratifiedBy, adminUserId);

  const proposed = await app.inject({ method: 'POST', url: `/v1/admin/emergency-kills/${killEventId}/extensions`, headers, payload: { newExpiresAt: '2026-09-18T11:00:00.000Z', reason: 'still active' } });
  assert.equal(proposed.statusCode, 201);
  assert.equal(proposed.json().killEventId, killEventId);

  const approved = await app.inject({ method: 'POST', url: `/v1/admin/emergency-kills/extensions/${extensionRequestId}/approve`, headers });
  assert.equal(approved.statusCode, 200);

  const reviewed = await app.inject({ method: 'POST', url: `/v1/admin/emergency-kills/${killEventId}/review`, headers, payload: { reviewText: 'contained' } });
  assert.equal(reviewed.statusCode, 200);
  assert.equal(reviewed.json().reviewed, true);

  const got = await app.inject({ method: 'GET', url: `/v1/admin/emergency-kills/${killEventId}`, headers });
  assert.equal(got.statusCode, 200);
  await app.close();
});

test('capability kill events: get returns 404 when not found', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityKillEvents: fakeStore({ async getKillEvent() { return null; } }) });
  const response = await app.inject({ method: 'GET', url: `/v1/admin/emergency-kills/${killEventId}`, headers });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().errorCode, 'kill_event_not_found');
  await app.close();
});

test('capability kill events: request schema rejects a missing reason and an undeclared field', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityKillEvents: fakeStore() });

  const missingReason = await app.inject({ method: 'POST', url: '/v1/admin/capability-registry/ctl_probe/emergency-kill', headers, payload: { affectedChannelCount: 1, liveChannelCount: 1 } });
  assert.equal(missingReason.statusCode, 400);

  const badField = await app.inject({ method: 'POST', url: '/v1/admin/capability-registry/ctl_probe/emergency-kill', headers, payload: { reason: 'x', affectedChannelCount: 1, liveChannelCount: 1, notAllowed: true } });
  assert.equal(badField.statusCode, 400);
  await app.close();
});

test('capability kill events: CapabilityKillEventError reasons map to the documented HTTP status', async () => {
  const cases: Array<{ reason: ConstructorParameters<typeof CapabilityKillEventError>[0]; expected: number }> = [
    { reason: 'capability_not_found', expected: 404 },
    { reason: 'kill_event_not_found', expected: 404 },
    { reason: 'extension_request_not_found', expected: 404 },
    { reason: 'duplicate_action', expected: 409 },
    { reason: 'blocked_on_missing_review', expected: 409 },
    { reason: 'self_action_forbidden', expected: 403 },
    { reason: 'invalid_input', expected: 400 },
  ];
  for (const { reason, expected } of cases) {
    const app = await buildApp(config, {
      sessions, admin,
      capabilityKillEvents: fakeStore({ async fireKill() { throw new CapabilityKillEventError(reason, `synthetic ${reason}`); } }),
    });
    const response = await app.inject({ method: 'POST', url: '/v1/admin/capability-registry/ctl_probe/emergency-kill', headers, payload: { reason: 'x', affectedChannelCount: 1, liveChannelCount: 1 } });
    assert.equal(response.statusCode, expected, reason);
    assert.equal(response.json().errorCode, reason);
    await app.close();
  }
});

test('capability kill events: an unexpected store failure degrades to a clean, retryable 503, never a crash', async () => {
  const app = await buildApp(config, {
    sessions, admin,
    capabilityKillEvents: fakeStore({ async fireKill() { throw new Error('synthetic db failure'); } }),
  });
  const response = await app.inject({ method: 'POST', url: '/v1/admin/capability-registry/ctl_probe/emergency-kill', headers, payload: { reason: 'x', affectedChannelCount: 1, liveChannelCount: 1 } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});
