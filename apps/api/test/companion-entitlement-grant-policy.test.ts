import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerCompanionRoutes } from '../src/routes/companion.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AlertStore, CompanionAction, CompanionActionResult, CompanionState } from '../src/domain/alert-store.js';
import type { CompanionEntitlementStore, CompanionGrantPolicy } from '../src/domain/companion-entitlement-policy.js';

// L24 Companion separation (migration 0100, master plan 3.7): the /actions
// route's Layer-1 gate, wired against the new CompanionEntitlementStore.
// This suite uses a standalone `createTestFastify()` instance to isolate policy precedence. The
// normal `buildApp`/production composition now wires the SQL entitlement
// store; this test deliberately supplies a fake live policy and exercises
// the same HTTP route handler.

const BEARER = 'e'.repeat(48);
const headers = { authorization: `Bearer ${BEARER}` };
const CHANNEL_ID = '00000000-0000-4000-8000-000000000e11';
const QUEUE_ID = '00000000-0000-4000-8000-000000000e21';

function fakeSessions(): SessionStore {
  return {
    async create() { return { accessToken: BEARER, principal: { sessionId: 'sess', userId: 'user-e01', expiresAt: '2026-09-13T10:00:00Z' } }; },
    async lookup(token) { return token === BEARER ? { sessionId: 'sess', userId: 'user-e01', expiresAt: '2026-09-13T10:00:00Z' } : null; },
    async getCurrentUser(userId) { return { schemaVersion: 'v1', userId, displayName: 'Synthetic L24-Sep Creator', channels: [] }; },
    async list() { return []; },
    async revoke() { return true; },
  };
}

function baseState(): CompanionState {
  return {
    schemaVersion: 'v1', channelId: CHANNEL_ID, overlayConnected: true, pendingAlerts: 0, lastUpdatedAt: '2026-09-06T10:00:00.000Z',
    helperPaired: true, obsConnected: true, obsStatusReportedAt: '2026-09-06T10:00:00.000Z',
    paymentAccountConnected: true, mirrorReachable: false, streamPaired: false,
  };
}

// entitlementValues === null means "no channel_entitlement_versions row at
// all" -- a Companion-only signup, exactly like
// apps/api/test/l24-companion-action-catalogue.test.ts's own convention.
function fakeAlerts(entitlementValues: Record<string, unknown> | null): AlertStore {
  return {
    async createTestAlert() { throw new Error('not used'); },
    async listHistory() { throw new Error('not used'); },
    async moderate() { throw new Error('not used'); },
    async getBilling() { throw new Error('not used'); },
    async getEntitlements(_userId, channelId) {
      if (entitlementValues === null) return null;
      return { schemaVersion: 'v1', channelId, tier: 'free', source: 'individual_plan', entitlementVersion: 1, values: entitlementValues };
    },
    async getCompanionState() { return baseState(); },
    async getCompanionLayout() { throw new Error('not used'); },
    async updateCompanionLayout() { throw new Error('not used'); },
    async acquireCompanionControlSession() { throw new Error('not used'); },
    async revokeCompanionControlSession() { throw new Error('not used'); },
    async executeCompanionAction(_userId, _channelId, action: CompanionAction, _targetId, idempotencyKey) {
      const result: CompanionActionResult = { schemaVersion: 'v1', commandId: `command-${idempotencyKey}`, status: 'accepted', acceptedAt: '2026-09-06T10:00:01.000Z' };
      return result;
    },
    async reportCompanionObsConnection() { return true; },
  };
}

function fakeEntitlement(policy: CompanionGrantPolicy | null): CompanionEntitlementStore {
  return { async getCompanionGrantPolicy() { return policy; } };
}

function policy(overrides: Partial<CompanionGrantPolicy>): CompanionGrantPolicy {
  return { schemaVersion: 'v1', channelId: CHANNEL_ID, sourceKey: 'standalone', granted: true, actionGroups: ['obs', 'mirror', 'stream'], actionLimit: 8, ...overrides };
}

async function buildTestApp(entitlementValues: Record<string, unknown> | null, entitlementStore: CompanionEntitlementStore | undefined) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerCompanionRoutes(app, fakeSessions(), fakeAlerts(entitlementValues), undefined, undefined, entitlementStore);
  await app.ready();
  return app;
}

function postAction(app: Awaited<ReturnType<typeof buildTestApp>>, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: `/v1/channels/${CHANNEL_ID}/companion/actions`, headers: { ...headers, 'idempotency-key': 'l24-sep-test-key-0001' }, payload: body,
  });
}

// === Companion without Alerts: OBS yes, Alerts no ===
test('a Companion-only channel (no entitlement row) gets Companion actions and zero Alerts actions', async () => {
  const app = await buildTestApp(null, fakeEntitlement(policy({ sourceKey: 'standalone', granted: true, actionGroups: ['obs', 'mirror', 'stream'] })));
  const obsRes = await postAction(app, { action: 'obs_start_stream', targetId: CHANNEL_ID, targetLabel: 'Main Scene' });
  assert.equal(obsRes.statusCode, 202);
  const alertsRes = await postAction(app, { action: 'pause_queue', targetId: QUEUE_ID });
  assert.equal(alertsRes.statusCode, 403);
  assert.equal(JSON.parse(alertsRes.body).errorCode, 'companion_action_group_not_entitled');
});

// === Backwards compatibility: an entitled Alerts channel keeps today's access ===
test('an Alerts channel with an explicit companionActionGroups override keeps that override, unaffected by the live policy', async () => {
  const app = await buildTestApp({ companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] }, fakeEntitlement(policy({ sourceKey: 'alerts:free', granted: false, actionGroups: [] })));
  const alertsRes = await postAction(app, { action: 'pause_queue', targetId: QUEUE_ID });
  assert.equal(alertsRes.statusCode, 202);
});

test('an explicit empty or malformed companionActionGroups override fails closed instead of falling back to a permissive live policy', async () => {
  const permissivePolicy = fakeEntitlement(policy({ sourceKey: 'alerts:free', granted: true, actionGroups: ['alerts', 'obs', 'mirror', 'stream'] }));

  const emptyOverrideApp = await buildTestApp({ companionActionGroups: [] }, permissivePolicy);
  const emptyOverride = await postAction(emptyOverrideApp, { action: 'obs_start_stream', targetId: CHANNEL_ID, targetLabel: 'Main Scene' });
  assert.equal(emptyOverride.statusCode, 403);
  assert.equal(JSON.parse(emptyOverride.body).errorCode, 'companion_action_group_not_entitled');

  const malformedOverrideApp = await buildTestApp({ companionActionGroups: ['obs', 'not-a-real-group'] }, permissivePolicy);
  const malformedOverride = await postAction(malformedOverrideApp, { action: 'obs_start_stream', targetId: CHANNEL_ID, targetLabel: 'Main Scene' });
  assert.equal(malformedOverride.statusCode, 403);
  assert.equal(JSON.parse(malformedOverride.body).errorCode, 'companion_action_group_not_entitled');
});

// === Flip is data: the live policy governs when no per-channel override exists ===
test('flipping the live grant policy changes access for a channel with no explicit override, with no code change', async () => {
  const grantedApp = await buildTestApp({}, fakeEntitlement(policy({ sourceKey: 'alerts:free', granted: true, actionGroups: ['alerts', 'obs', 'mirror', 'stream'] })));
  const before = await postAction(grantedApp, { action: 'obs_start_stream', targetId: CHANNEL_ID, targetLabel: 'Main Scene' });
  assert.equal(before.statusCode, 202);

  const revokedApp = await buildTestApp({}, fakeEntitlement(policy({ sourceKey: 'alerts:free', granted: false, actionGroups: [] })));
  const after = await postAction(revokedApp, { action: 'obs_start_stream', targetId: CHANNEL_ID, targetLabel: 'Main Scene' });
  assert.equal(after.statusCode, 403);
  assert.equal(JSON.parse(after.body).errorCode, 'companion_action_group_not_entitled');
});

// === Unwired fallback: today's exact shipped behavior, byte for byte ===
test('with no CompanionEntitlementStore wired, behavior is identical to before this task (no entitlement row = no alerts, obs still works)', async () => {
  const app = await buildTestApp(null, undefined);
  const obsRes = await postAction(app, { action: 'obs_start_stream', targetId: CHANNEL_ID, targetLabel: 'Main Scene' });
  assert.equal(obsRes.statusCode, 202);
  const alertsRes = await postAction(app, { action: 'pause_queue', targetId: QUEUE_ID });
  assert.equal(alertsRes.statusCode, 403);
});

// === Two-layer gate still intact: entitled but not active is a distinct failure ===
test('entitled via the live policy but not activated still 409s, distinct from the 403 not-entitled case', async () => {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  const alerts: AlertStore = {
    ...fakeAlerts({}),
    async getCompanionState() { return { ...baseState(), helperPaired: false, obsConnected: false }; },
  };
  await registerCompanionRoutes(app, fakeSessions(), alerts, undefined, undefined, fakeEntitlement(policy({ sourceKey: 'alerts:free', granted: true, actionGroups: ['alerts', 'obs', 'mirror', 'stream'] })));
  await app.ready();
  const res = await postAction(app, { action: 'obs_start_stream', targetId: CHANNEL_ID, targetLabel: 'Main Scene' });
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_not_active');
});
