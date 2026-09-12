import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AlertStore, CompanionAction, CompanionState } from '../src/domain/alert-store.js';

// L24 activation (migration 0093): proof that the 'obs' action group is now
// gated by a real server-side liveness signal (CompanionState.helperPaired
// + obsConnected), not entitlement alone -- the gap this task's PROBLEM
// statement identified in apps/api/src/routes/companion.ts. Every request
// goes straight at the HTTP route via app.inject, independent of any
// client's own picker/UI.

const config: RuntimeConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 4102,
  appOrigin: 'http://localhost:3102',
  paymentEnvironment: 'live',
};

const BEARER = 'b'.repeat(48);
const headers = { authorization: `Bearer ${BEARER}` };
const CHANNEL_ID = '00000000-0000-4000-8000-000000000c11';
const OTHER_CHANNEL_ID = '00000000-0000-4000-8000-000000000c12';
const SESSION_ID = '00000000-0000-4000-8000-000000000c21';

function fakeSessions(): SessionStore {
  return {
    async create() {
      return { accessToken: BEARER, principal: { sessionId: '00000000-0000-4000-8000-000000000c41', userId: '00000000-0000-4000-8000-000000000c01', expiresAt: '2026-09-13T10:00:00Z' } };
    },
    async lookup(token) {
      return token === BEARER
        ? { sessionId: '00000000-0000-4000-8000-000000000c41', userId: '00000000-0000-4000-8000-000000000c01', expiresAt: '2026-09-13T10:00:00Z' }
        : null;
    },
    async getCurrentUser(userId) { return { schemaVersion: 'v1', userId, displayName: 'Synthetic Activation Creator', channels: [] }; },
    async list() { return []; },
    async revoke() { return true; },
  };
}

type FakeAlertsOptions = {
  entitledGroups: string[] | null; // null => getEntitlements resolves to null (no entitlement row)
  companionState: Partial<CompanionState>;
  reportResult?: boolean;
};

function baseState(overrides: Partial<CompanionState>): CompanionState {
  return {
    schemaVersion: 'v1', channelId: CHANNEL_ID, overlayConnected: true, pendingAlerts: 0, lastUpdatedAt: '2026-09-06T10:00:00.000Z',
    helperPaired: true, obsConnected: true, obsStatusReportedAt: '2026-09-06T10:00:00.000Z',
    paymentAccountConnected: true, mirrorReachable: false, streamPaired: false,
    ...overrides,
  };
}

function fakeAlerts(opts: FakeAlertsOptions): AlertStore {
  return {
    async createTestAlert() { throw new Error('not used'); },
    async listHistory() { throw new Error('not used'); },
    async moderate() { throw new Error('not used'); },
    async getBilling() { throw new Error('not used'); },
    async getEntitlements(_userId, channelId) {
      if (opts.entitledGroups === null) return null;
      return { schemaVersion: 'v1', channelId, tier: 'creator', source: 'individual_plan', entitlementVersion: 1, values: { companionActionGroups: opts.entitledGroups } };
    },
    async getCompanionState(_userId, channelId) {
      return { ...baseState(opts.companionState), channelId };
    },
    async getCompanionLayout() { throw new Error('not used'); },
    async updateCompanionLayout() { throw new Error('not used'); },
    async acquireCompanionControlSession() { throw new Error('not used'); },
    async revokeCompanionControlSession() { throw new Error('not used'); },
    async executeCompanionAction(_userId, channelId, action: CompanionAction, targetId, idempotencyKey) {
      return { schemaVersion: 'v1', commandId: `command-${idempotencyKey}`, status: 'accepted', acceptedAt: '2026-09-06T10:00:01.000Z' };
    },
    async reportCompanionObsConnection(channelId, sessionId, _connected) {
      if (opts.reportResult !== undefined) return opts.reportResult;
      return channelId === CHANNEL_ID && sessionId === SESSION_ID;
    },
  };
}

async function postObsAction(app: Awaited<ReturnType<typeof buildApp>>, idempotencyKey: string) {
  return await app.inject({
    method: 'POST',
    url: `/v1/channels/${CHANNEL_ID}/companion/actions`,
    headers: { ...headers, 'idempotency-key': idempotencyKey },
    payload: { action: 'obs_toggle_mute', targetId: CHANNEL_ID, targetLabel: 'Mic' },
  });
}

test('entitled + active: an obs action succeeds when the channel is entitled and a helper reports OBS connected', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitledGroups: ['alerts', 'obs', 'mirror', 'stream'], companionState: { helperPaired: true, obsConnected: true } }) });
  const res = await postObsAction(app, 'companion-activation-active-0001');
  assert.equal(res.statusCode, 202);
});

test('entitled + inactive (no helper paired): rejected with a distinguishable not-active error, not the entitlement error', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitledGroups: ['alerts', 'obs', 'mirror', 'stream'], companionState: { helperPaired: false, obsConnected: false } }) });
  const res = await postObsAction(app, 'companion-activation-inactive-0001');
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.equal(body.errorCode, 'companion_action_not_active');
  assert.match(body.message, /helper/i);
});

test('entitled + inactive (helper paired but OBS not connected): rejected with the same not-active error, distinct message', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitledGroups: ['alerts', 'obs', 'mirror', 'stream'], companionState: { helperPaired: true, obsConnected: false } }) });
  const res = await postObsAction(app, 'companion-activation-inactive-0002');
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.equal(body.errorCode, 'companion_action_not_active');
  assert.match(body.message, /OBS/);
});

test('unentitled: rejected regardless of how live/active the channel is, with the entitlement error (not the activation error)', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitledGroups: ['alerts'], companionState: { helperPaired: true, obsConnected: true } }) });
  const res = await postObsAction(app, 'companion-activation-unentitled-0001');
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_group_not_entitled');
});

test('a stale heartbeat (obsConnected already resolved to false by the domain layer\'s 45s staleness window) reads as disconnected, same as no heartbeat at all', async () => {
  // The 45s staleness computation itself lives in migration 0093's SQL
  // (app_private.get_companion_state) and is proven directly by
  // packages/db/tests/companion_activation_signals.sql. At the route layer,
  // a stale heartbeat and a missing one are indistinguishable -- both
  // arrive as obsConnected: false -- and must produce the identical
  // rejection.
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitledGroups: ['alerts', 'obs', 'mirror', 'stream'], companionState: { helperPaired: true, obsConnected: false, obsStatusReportedAt: '2020-01-01T00:00:00.000Z' } }) });
  const res = await postObsAction(app, 'companion-activation-stale-0001');
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_not_active');
});

test('mirror/stream have no liveness signal today: an entitled channel still gets the not-active rejection for those groups', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitledGroups: ['alerts', 'obs', 'mirror', 'stream'], companionState: {} }) });
  const res = await app.inject({
    method: 'POST',
    url: `/v1/channels/${CHANNEL_ID}/companion/actions`,
    headers: { ...headers, 'idempotency-key': 'companion-activation-mirror-0001' },
    payload: { action: 'mirror_start', targetId: CHANNEL_ID },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_not_active');
});

test('helper obs-status report: succeeds for its own channel/session and returns 204', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitledGroups: ['obs'], companionState: {} }) });
  const res = await app.inject({
    method: 'PUT',
    url: `/v1/channels/${CHANNEL_ID}/companion/control-session/${SESSION_ID}/obs-status`,
    payload: { connected: true },
  });
  assert.equal(res.statusCode, 204);
});

test('helper obs-status report: a helper cannot report for a channel it has no session on', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitledGroups: ['obs'], companionState: {} }) });
  const res = await app.inject({
    method: 'PUT',
    url: `/v1/channels/${OTHER_CHANNEL_ID}/companion/control-session/${SESSION_ID}/obs-status`,
    payload: { connected: true },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_helper_session_invalid');
});

test('helper obs-status report: requires no bearer/account auth at all -- the session id is the sole credential', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitledGroups: ['obs'], companionState: {} }) });
  const res = await app.inject({
    method: 'PUT',
    url: `/v1/channels/${CHANNEL_ID}/companion/control-session/${SESSION_ID}/obs-status`,
    // Deliberately no Authorization header.
    payload: { connected: false },
  });
  assert.equal(res.statusCode, 204);
});

test('helper obs-status report: rejects a malformed body (additional properties, wrong type)', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitledGroups: ['obs'], companionState: {} }) });
  const res = await app.inject({
    method: 'PUT',
    url: `/v1/channels/${CHANNEL_ID}/companion/control-session/${SESSION_ID}/obs-status`,
    payload: { connected: 'yes', sceneCommand: 'set_scene' },
  });
  assert.equal(res.statusCode, 400);
});
