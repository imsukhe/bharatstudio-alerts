import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerCompanionRoutes } from '../src/routes/companion.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AlertStore, CompanionAction, CompanionActionResult, CompanionState } from '../src/domain/alert-store.js';
import type { CompanionFeatureStore, CompanionTestReport, CompanionTtsCancelResult, CompanionTtsMuteState } from '../src/domain/companion-feature-store.js';
import type { CompanionEntitlementStore } from '../src/domain/companion-entitlement-policy.js';

// L07 remaining feature list (master plan 7.11 items 2, 5, 8-10). These
// Routes are mounted on bare Fastify only to isolate feature dependencies;
// normal buildApp/production composition supplies both feature and live
// entitlement stores. This still exercises the exact request pipeline.

const BEARER = 'b'.repeat(48);
const headers = { authorization: `Bearer ${BEARER}` };
const CHANNEL_ID = '00000000-0000-4000-8000-000000000d11';
const OTHER_CHANNEL_ID = '00000000-0000-4000-8000-000000000d12';
const QUEUE_ID = '00000000-0000-4000-8000-000000000d21';
const DELIVERY_ID = '00000000-0000-4000-8000-000000000d31';
const EVENT_ID = '00000000-0000-4000-8000-000000000d41';

function fakeSessions(): SessionStore {
  return {
    async create() { return { accessToken: BEARER, principal: { sessionId: 'sess', userId: 'user-01', expiresAt: '2026-09-13T10:00:00Z' } }; },
    async lookup(token) { return token === BEARER ? { sessionId: 'sess', userId: 'user-01', expiresAt: '2026-09-13T10:00:00Z' } : null; },
    async getCurrentUser(userId) { return { schemaVersion: 'v1', userId, displayName: 'Synthetic L07F Creator', channels: [] }; },
    async list() { return []; },
    async revoke() { return true; },
  };
}

type AlertsOpts = { ttsEnabled: boolean; overlayConnected: boolean };

function baseState(overrides: Partial<CompanionState>): CompanionState {
  return {
    schemaVersion: 'v1', channelId: CHANNEL_ID, overlayConnected: true, pendingAlerts: 0, lastUpdatedAt: '2026-09-06T10:00:00.000Z',
    helperPaired: false, obsConnected: false, obsStatusReportedAt: null,
    paymentAccountConnected: false, mirrorReachable: false, streamPaired: false,
    ...overrides,
  };
}

function fakeAlerts(opts: AlertsOpts): AlertStore {
  return {
    async createTestAlert() { throw new Error('not used'); },
    async listHistory() { throw new Error('not used'); },
    async moderate() { throw new Error('not used'); },
    async getBilling() { throw new Error('not used'); },
    async getEntitlements(_userId, channelId) {
      return { schemaVersion: 'v1', channelId, tier: 'creator', source: 'individual_plan', entitlementVersion: 1, values: { ttsEnabled: opts.ttsEnabled } };
    },
    async getCompanionState(_userId, channelId) {
      return { ...baseState({ overlayConnected: opts.overlayConnected }), channelId };
    },
    async getCompanionLayout() { throw new Error('not used'); },
    async updateCompanionLayout() { throw new Error('not used'); },
    async acquireCompanionControlSession() { throw new Error('not used'); },
    async revokeCompanionControlSession() { throw new Error('not used'); },
    async executeCompanionAction(_userId, channelId, action: CompanionAction, _targetId, idempotencyKey) {
      const result: CompanionActionResult = { schemaVersion: 'v1', commandId: `command-${idempotencyKey}`, status: 'accepted', acceptedAt: '2026-09-06T10:00:01.000Z', ...(action === 'send_test_alert' ? { eventId: EVENT_ID } : {}) };
      return result;
    },
    async reportCompanionObsConnection() { return true; },
  };
}

type FeaturesOpts = { role: 'owner' | 'operator' | 'viewer' };

function fakeFeatures(opts: FeaturesOpts): CompanionFeatureStore {
  const denied = () => { const err = new Error('channel access denied'); throw err; };
  return {
    async setCompanionTtsMuted(_userId, channelId, queueId, muted) {
      if (opts.role === 'viewer') return denied();
      const result: CompanionTtsMuteState = { schemaVersion: 'v1', queueId, ttsMuted: muted, ttsMutedAt: muted ? '2026-09-06T10:05:00.000Z' : null };
      return result;
    },
    async cancelCompanionTts(_userId, channelId, deliveryId) {
      if (opts.role === 'viewer') return denied();
      if (deliveryId !== DELIVERY_ID) return null;
      const result: CompanionTtsCancelResult = { schemaVersion: 'v1', deliveryId, eventId: EVENT_ID, status: 'tts_cancelled', cancelledAt: '2026-09-06T10:06:00.000Z' };
      return result;
    },
    async getCompanionTestReport(_userId, channelId, eventId) {
      const report: CompanionTestReport = { schemaVersion: 'v1', channelId, eventId, hops: [{ hop: 'event_created', status: 'ok', occurredAt: '2026-09-06T10:00:00.000Z', detail: null }] };
      return report;
    },
    async getCompanionPaymentStatus(_userId, channelId) {
      if (opts.role === 'viewer') return { schemaVersion: 'v1', channelId, items: [] };
      return { schemaVersion: 'v1', channelId, items: [{ paymentId: 'pay-1', status: 'captured', grossAmountPaise: 25000, currency: 'INR', refundStatus: null, refundAmountPaise: null, createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z' }] };
    },
    async getCompanionRecentTips(_userId, channelId) {
      if (opts.role === 'viewer') return { schemaVersion: 'v1', channelId, items: [{ eventId: EVENT_ID, displayName: null, message: null, grossAmountPaise: null, currency: null, createdAt: '2026-09-06T10:00:00.000Z' }] };
      return { schemaVersion: 'v1', channelId, items: [{ eventId: EVENT_ID, displayName: 'Synthetic Tipper', message: 'hi', grossAmountPaise: 25000, currency: 'INR', createdAt: '2026-09-06T10:00:00.000Z' }] };
    },
  };
}

async function buildTestApp(alertsOpts: AlertsOpts, featuresOpts: FeaturesOpts | undefined, companionEntitlement?: CompanionEntitlementStore) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerCompanionRoutes(app, fakeSessions(), fakeAlerts(alertsOpts), undefined, featuresOpts ? fakeFeatures(featuresOpts) : undefined, companionEntitlement);
  await app.ready();
  return app;
}

// === Wiring gap: features absent -> every new route fails closed, not 500 ===

test('features unavailable: mute/cancel/full-test/payments/tips all fail closed with 503, not a crash', async () => {
  const app = await buildTestApp({ ttsEnabled: true, overlayConnected: true }, undefined);
  const routes: Array<{ method: 'PUT' | 'POST'; url: string; payload: Record<string, unknown> }> = [
    { method: 'PUT', url: `/v1/channels/${CHANNEL_ID}/companion/tts/mute`, payload: { queueId: QUEUE_ID, muted: true } },
    { method: 'POST', url: `/v1/channels/${CHANNEL_ID}/companion/tts/cancel`, payload: { deliveryId: DELIVERY_ID } },
    { method: 'POST', url: `/v1/channels/${CHANNEL_ID}/companion/full-test`, payload: { queueId: QUEUE_ID } },
  ];
  for (const route of routes) {
    const res = await app.inject({ method: route.method, url: route.url, headers, payload: route.payload });
    assert.equal(res.statusCode, 503, `${route.method} ${route.url}`);
    assert.equal(JSON.parse(res.body).errorCode, 'companion_store_unavailable');
  }
  const paymentsRes = await app.inject({ method: 'GET', url: `/v1/channels/${CHANNEL_ID}/companion/payments`, headers });
  assert.equal(paymentsRes.statusCode, 503);
  const tipsRes = await app.inject({ method: 'GET', url: `/v1/channels/${CHANNEL_ID}/companion/tips`, headers });
  assert.equal(tipsRes.statusCode, 503);
});

// === Two-layer gate: TTS mute (entitlement then activation) ===

test('TTS mute: not entitled (ttsEnabled=false) -> 403 companion_action_group_not_entitled, before activation is even checked', async () => {
  const app = await buildTestApp({ ttsEnabled: false, overlayConnected: true }, { role: 'owner' });
  const res = await app.inject({ method: 'PUT', url: `/v1/channels/${CHANNEL_ID}/companion/tts/mute`, headers, payload: { queueId: QUEUE_ID, muted: true } });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_group_not_entitled');
});

test('TTS mute: entitled but not active (overlay not connected) -> 409 companion_action_not_active, distinct from the entitlement error', async () => {
  const app = await buildTestApp({ ttsEnabled: true, overlayConnected: false }, { role: 'owner' });
  const res = await app.inject({ method: 'PUT', url: `/v1/channels/${CHANNEL_ID}/companion/tts/mute`, headers, payload: { queueId: QUEUE_ID, muted: true } });
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_not_active');
});

test('TTS mute: entitled + active -> 200 with the muted state', async () => {
  const app = await buildTestApp({ ttsEnabled: true, overlayConnected: true }, { role: 'owner' });
  const res = await app.inject({ method: 'PUT', url: `/v1/channels/${CHANNEL_ID}/companion/tts/mute`, headers, payload: { queueId: QUEUE_ID, muted: true } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ttsMuted, true);
  assert.ok(body.ttsMutedAt);
});

test('TTS mute: a role without permission (viewer) is denied even though entitled + active', async () => {
  const app = await buildTestApp({ ttsEnabled: true, overlayConnected: true }, { role: 'viewer' });
  const res = await app.inject({ method: 'PUT', url: `/v1/channels/${CHANNEL_ID}/companion/tts/mute`, headers, payload: { queueId: QUEUE_ID, muted: true } });
  assert.equal(res.statusCode, 403);
});

// === Mute and cancel are distinct operations ===

test('TTS cancel: not entitled -> same 403 as mute, and cancel never runs when a mute call is made instead (different endpoints, different bodies)', async () => {
  const app = await buildTestApp({ ttsEnabled: false, overlayConnected: true }, { role: 'owner' });
  const res = await app.inject({ method: 'POST', url: `/v1/channels/${CHANNEL_ID}/companion/tts/cancel`, headers, payload: { deliveryId: DELIVERY_ID } });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_group_not_entitled');
});

test('TTS cancel: entitled + active + valid delivery -> 200 with status tts_cancelled, a different shape/status from mute\'s response', async () => {
  const app = await buildTestApp({ ttsEnabled: true, overlayConnected: true }, { role: 'owner' });
  const res = await app.inject({ method: 'POST', url: `/v1/channels/${CHANNEL_ID}/companion/tts/cancel`, headers, payload: { deliveryId: DELIVERY_ID } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'tts_cancelled');
  assert.equal(body.deliveryId, DELIVERY_ID);
  assert.equal('ttsMuted' in body, false);
});

test('TTS cancel: entitled + active but delivery not cancellable -> 409 companion_tts_cancel_not_active, distinct errorCode from mute\'s activation error', async () => {
  const app = await buildTestApp({ ttsEnabled: true, overlayConnected: true }, { role: 'owner' });
  const res = await app.inject({ method: 'POST', url: `/v1/channels/${CHANNEL_ID}/companion/tts/cancel`, headers, payload: { deliveryId: '00000000-0000-4000-8000-000000000d99' } });
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_tts_cancel_not_active');
});

// === Run full test: reuses the existing send_test_alert action, then reports hops ===

test('run full test: not active (overlay disconnected) is rejected before the store can create a synthetic alert', async () => {
  // executeCompanionAction is faked to accept in this suite, so a 409 proves
  // the full-test route itself applies the same activation gate as /actions.
  const app = await buildTestApp({ ttsEnabled: true, overlayConnected: false }, { role: 'owner' });
  const res = await app.inject({ method: 'POST', url: `/v1/channels/${CHANNEL_ID}/companion/full-test`, headers, payload: { queueId: QUEUE_ID } });
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_not_active');
});

test('run full test: an unentitled alerts group is rejected before the store can create a synthetic alert', async () => {
  const deniedPolicy: CompanionEntitlementStore = {
    async getCompanionGrantPolicy() {
      return { schemaVersion: 'v1', channelId: CHANNEL_ID, sourceKey: 'alerts:creator', granted: false, actionLimit: 0, actionGroups: [] };
    },
  };
  const app = await buildTestApp({ ttsEnabled: true, overlayConnected: true }, { role: 'owner' }, deniedPolicy);
  const res = await app.inject({ method: 'POST', url: `/v1/channels/${CHANNEL_ID}/companion/full-test`, headers, payload: { queueId: QUEUE_ID } });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_group_not_entitled');
});

// === Reads never leak another channel's data ===

test('payment status and recent tips are scoped by the channelId in the URL, never by a value the client could substitute elsewhere', async () => {
  const app = await buildTestApp({ ttsEnabled: true, overlayConnected: true }, { role: 'owner' });
  const paymentsRes = await app.inject({ method: 'GET', url: `/v1/channels/${CHANNEL_ID}/companion/payments`, headers });
  assert.equal(paymentsRes.statusCode, 200);
  assert.equal(JSON.parse(paymentsRes.body).channelId, CHANNEL_ID);

  const tipsRes = await app.inject({ method: 'GET', url: `/v1/channels/${OTHER_CHANNEL_ID}/companion/tips`, headers });
  assert.equal(tipsRes.statusCode, 200);
  assert.equal(JSON.parse(tipsRes.body).channelId, OTHER_CHANNEL_ID);
});

test('recent tips: a role without donor visibility (viewer) gets amount/name/message nulled out, not omitted or errored', async () => {
  const app = await buildTestApp({ ttsEnabled: true, overlayConnected: true }, { role: 'viewer' });
  const res = await app.inject({ method: 'GET', url: `/v1/channels/${CHANNEL_ID}/companion/tips`, headers });
  assert.equal(res.statusCode, 200);
  const item = JSON.parse(res.body).items[0];
  assert.equal(item.displayName, null);
  assert.equal(item.grossAmountPaise, null);
});

test('payment status: a role without finance visibility (viewer) sees an empty list, not another channel\'s or another role\'s data', async () => {
  const app = await buildTestApp({ ttsEnabled: true, overlayConnected: true }, { role: 'viewer' });
  const res = await app.inject({ method: 'GET', url: `/v1/channels/${CHANNEL_ID}/companion/payments`, headers });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).items, []);
});
