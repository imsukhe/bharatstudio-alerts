import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AlertStore, CompanionAction } from '../src/domain/alert-store.js';

// L24 Companion action catalogue: server-side two-layer gate proof for
// apps/api/src/routes/companion.ts, independent of any client picker. Every
// request below goes straight at the HTTP route via app.inject, bypassing
// any web/mobile/desktop UI entirely -- this is the "direct-API bypass the
// client picker" evidence the L24 task requires.

const config: RuntimeConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 4101,
  appOrigin: 'http://localhost:3101',
  paymentEnvironment: 'live',
};

const BEARER = 'a'.repeat(48);
const headers = { authorization: `Bearer ${BEARER}` };
const CHANNEL_ID = '00000000-0000-4000-8000-000000000b11';
const QUEUE_ID = '00000000-0000-4000-8000-000000000b21';

function fakeSessions(): SessionStore {
  return {
    async create() {
      return { accessToken: BEARER, principal: { sessionId: '00000000-0000-4000-8000-000000000b41', userId: '00000000-0000-4000-8000-000000000b01', expiresAt: '2026-09-13T10:00:00Z' } };
    },
    async lookup(token) {
      return token === BEARER
        ? { sessionId: '00000000-0000-4000-8000-000000000b41', userId: '00000000-0000-4000-8000-000000000b01', expiresAt: '2026-09-13T10:00:00Z' }
        : null;
    },
    async getCurrentUser(userId) { return { schemaVersion: 'v1', userId, displayName: 'Synthetic L24 Creator', channels: [] }; },
    async list() { return []; },
    async revoke() { return true; },
  };
}

type FakeAlertsOptions = {
  entitlementValues: Record<string, unknown> | null; // null => getEntitlements resolves to null (no entitlement row)
  overlayConnected: boolean;
  // L24 activation (migration 0093). Default true so this file's
  // pre-existing "obs works" assertions, written before activation was
  // enforced for obs, keep exercising the same intent (entitled + a live
  // helper). mirror/stream have no such knob: 0093 models them as always
  // false, honestly, so every mirror_*/stream_* action is now activation-
  // gated regardless of what a fixture claims -- see the tests below that
  // were updated for this file's original (pre-0093) assumption that
  // activation never blocked those two groups.
  helperPaired?: boolean;
  obsConnected?: boolean;
};

function fakeAlerts(opts: FakeAlertsOptions): AlertStore {
  const executed: { action: CompanionAction; targetId: string | null }[] = [];
  return {
    async createTestAlert() { throw new Error('not used'); },
    async listHistory() { throw new Error('not used'); },
    async moderate() { throw new Error('not used'); },
    async getBilling() { throw new Error('not used'); },
    async getEntitlements(_userId, channelId) {
      if (opts.entitlementValues === null) return null;
      return { schemaVersion: 'v1', channelId, tier: 'creator', source: 'individual_plan', entitlementVersion: 1, values: opts.entitlementValues };
    },
    async getCompanionState(_userId, channelId) {
      return {
        schemaVersion: 'v1', channelId, overlayConnected: opts.overlayConnected, pendingAlerts: 0, lastUpdatedAt: '2026-09-06T10:00:00.000Z',
        helperPaired: opts.helperPaired ?? true, obsConnected: opts.obsConnected ?? true, obsStatusReportedAt: '2026-09-06T10:00:00.000Z',
        paymentAccountConnected: true, mirrorReachable: false, streamPaired: false,
      };
    },
    async getCompanionLayout() { throw new Error('not used'); },
    async updateCompanionLayout() { throw new Error('not used'); },
    async acquireCompanionControlSession() { throw new Error('not used'); },
    async revokeCompanionControlSession() { throw new Error('not used'); },
    async executeCompanionAction(_userId, channelId, action, targetId, idempotencyKey) {
      executed.push({ action, targetId });
      return { schemaVersion: 'v1', commandId: `command-${idempotencyKey}`, status: 'accepted', acceptedAt: '2026-09-06T10:00:01.000Z' };
    },
    async reportCompanionObsConnection() { throw new Error('not used'); },
  };
}

async function postAction(
  app: Awaited<ReturnType<typeof buildApp>>,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  // `await` here selects app.inject's promise overload; returning the call
  // unawaited resolves to the chainable-builder overload instead, whose type
  // has no statusCode/body and makes every call site fail to typecheck.
  return await app.inject({
    method: 'POST',
    url: `/v1/channels/${CHANNEL_ID}/companion/actions`,
    headers: { ...headers, 'idempotency-key': idempotencyKey },
    payload: body,
  });
}

test('an action outside the catalogue is rejected at the JSON-schema layer, before entitlement or activation is ever checked', async () => {
  // Fastify/AJV's `enum` on the request body already rejects this before
  // the handler runs (400 bad_request) -- a stronger guarantee than the
  // handler's own ACTION_GROUPS lookup, which exists as defense in depth
  // for any caller that could somehow reach the handler with an
  // unrecognised action (see companion.ts's own "Layer 0" comment).
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitlementValues: { companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] }, overlayConnected: true }) });
  const res = await postAction(app, { action: 'delete_everything', targetId: CHANNEL_ID }, 'l24-unsupported-catalogue-0001');
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).errorCode, 'bad_request');
});

test('entitlement gate: a Companion-only channel (no entitlement row) sees zero Alerts actions but a working OBS action', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitlementValues: null, overlayConnected: false }) });

  const alertsAttempt = await postAction(app, { action: 'pause_queue', targetId: QUEUE_ID }, 'l24-noent-alerts-0001');
  assert.equal(alertsAttempt.statusCode, 403);
  assert.equal(JSON.parse(alertsAttempt.body).errorCode, 'companion_action_group_not_entitled');

  const obsAttempt = await postAction(app, { action: 'obs_start_stream', targetId: CHANNEL_ID, targetLabel: 'Main Scene' }, 'l24-noent-obs-0001');
  assert.equal(obsAttempt.statusCode, 202);
});

test('entitlement gate: a channel entitled only to obs/mirror/stream rejects an alerts action even though a row exists', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitlementValues: { companionActionGroups: ['obs', 'mirror', 'stream'] }, overlayConnected: true }) });
  const res = await postAction(app, { action: 'resume_queue', targetId: QUEUE_ID }, 'l24-restricted-0001');
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_group_not_entitled');
});

test('activation gate: an Alerts action is rejected when Alerts is not live, independent of entitlement', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitlementValues: { companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] }, overlayConnected: false }) });
  const res = await postAction(app, { action: 'pause_queue', targetId: QUEUE_ID }, 'l24-inactive-0001');
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_not_active');
});

test('activation gate: obs is independent of Alerts liveness -- a live helper lets an OBS action through while Alerts is down', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitlementValues: { companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] }, overlayConnected: false, helperPaired: true, obsConnected: true }) });
  const res = await postAction(app, { action: 'obs_toggle_mute', targetId: CHANNEL_ID, targetLabel: 'Mic' }, 'l24-obs-independent-0001');
  assert.equal(res.statusCode, 202);
});

test('activation gate: obs is rejected, distinguishably from entitlement, when no helper is paired or OBS is not connected', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitlementValues: { companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] }, overlayConnected: true, helperPaired: false, obsConnected: false }) });
  const res = await postAction(app, { action: 'obs_toggle_mute', targetId: CHANNEL_ID, targetLabel: 'Mic' }, 'l24-obs-not-active-0001');
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_not_active');
});

test('activation gate: mirror/stream have no real liveness signal today (migration 0093), so every action in those groups is rejected as not-active even though entitled', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitlementValues: { companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] }, overlayConnected: true }) });
  const mirror = await postAction(app, { action: 'mirror_start', targetId: CHANNEL_ID }, 'l24-mirror-start-0001');
  assert.equal(mirror.statusCode, 409);
  assert.equal(JSON.parse(mirror.body).errorCode, 'companion_action_not_active');
  const stream = await postAction(app, { action: 'stream_go_live', targetId: CHANNEL_ID }, 'l24-stream-golive-0001');
  assert.equal(stream.statusCode, 409);
  assert.equal(JSON.parse(stream.body).errorCode, 'companion_action_not_active');
});

test('target-shape validation: an OBS action without a targetLabel is rejected', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitlementValues: { companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] }, overlayConnected: true }) });
  const res = await postAction(app, { action: 'obs_toggle_mute', targetId: CHANNEL_ID }, 'l24-shape-obs-0001');
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).errorCode, 'companion_action_target_shape_invalid');
});

test('target-shape validation: an alerts action with a targetLabel is rejected, and a non-UUID target is rejected', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitlementValues: { companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] }, overlayConnected: true }) });
  const withLabel = await postAction(app, { action: 'pause_queue', targetId: QUEUE_ID, targetLabel: 'nope' }, 'l24-shape-alerts-0001');
  assert.equal(withLabel.statusCode, 400);
  const badUuid = await postAction(app, { action: 'resume_queue', targetId: 'not-a-uuid' }, 'l24-shape-alerts-0002');
  assert.equal(badUuid.statusCode, 400);
});

test('the full 17-action catalogue is exactly what the route allows (schema enum), matching migration 0089 -- alerts/obs succeed with a live helper, mirror/stream are activation-gated (migration 0093)', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts({ entitlementValues: { companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] }, overlayConnected: true, helperPaired: true, obsConnected: true }) });
  const catalogue = [
    'pause_queue', 'resume_queue', 'send_test_alert',
    'obs_set_scene', 'obs_toggle_source', 'obs_toggle_mute',
    'obs_start_stream', 'obs_stop_stream', 'obs_start_record', 'obs_stop_record',
    'obs_save_replay_buffer', 'obs_set_transition',
    'mirror_start', 'mirror_stop', 'mirror_screenshot',
    'stream_go_live', 'stream_end',
  ];
  for (const action of catalogue) {
    const isMirrorOrStream = action.startsWith('mirror_') || action.startsWith('stream_');
    const body = action.startsWith('obs_')
      ? { action, targetId: CHANNEL_ID, targetLabel: 'Main Scene' }
      : { action, targetId: action === 'pause_queue' || action === 'resume_queue' || action === 'send_test_alert' ? QUEUE_ID : CHANNEL_ID };
    const res = await postAction(app, body, `l24-catalogue-${action}`);
    if (isMirrorOrStream) {
      assert.equal(res.statusCode, 409, `${action} has no liveness signal today and must be activation-rejected, got ${res.statusCode}: ${res.body}`);
      assert.equal(JSON.parse(res.body).errorCode, 'companion_action_not_active');
    } else {
      assert.equal(res.statusCode, 202, `${action} should be accepted, got ${res.statusCode}: ${res.body}`);
    }
  }
  const rejected = await postAction(app, { action: 'approve_alert', targetId: CHANNEL_ID }, 'l24-catalogue-legacy-rejected');
  assert.equal(rejected.statusCode, 400, 'a pre-0041 legacy action must still be rejected');
});
