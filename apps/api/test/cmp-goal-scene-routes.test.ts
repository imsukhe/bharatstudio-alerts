import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerCompanionGoalSceneRoutes } from '../src/routes/companion-goal-scene.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import type { AlertStore, CompanionState } from '../src/domain/alert-store.js';
import type { CompanionEntitlementStore, CompanionGrantPolicy } from '../src/domain/companion-entitlement-policy.js';
import type { CompanionGoalControlStore, GoalControlOutcome } from '../src/domain/companion-goal-control-store.js';
import type {
  AddScenePresetActionResult,
  CompanionScenePresetStore,
  ScenePreset,
  ScenePresetAction,
  UpsertScenePresetResult,
} from '../src/domain/companion-scene-preset-store.js';

// CMP-21 (goal controls) + CMP-20 (scene presets), packages/db/migrations/
// 0162. Route-layer proof only -- SQL-level behaviour (role gate, control-
// session lease, prepare-not-fire structural enforcement, idempotent
// retry, forced-completion freeze) is covered by
// packages/db/tests/cmp_goal_controls.sql and cmp_scene_presets.sql.
// registerCompanionGoalSceneRoutes is exercised directly against a
// standalone createTestFastify() instance, the same shape l16-goals-
// routes.test.ts uses for goals.ts, not through buildApp/app.ts.

const userId = '00000000-0000-4000-8000-000000000c01';
const channelId = '00000000-0000-4000-8000-000000000c11';
const goalId = '00000000-0000-4000-8000-000000000c21';
const presetId = '00000000-0000-4000-8000-000000000c31';
const sessionId = '00000000-0000-4000-8000-000000000c41';
const token = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000c51', userId, expiresAt: '2026-09-18T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const account = {
  async hasAcceptedActiveDocuments() { return true; },
} as unknown as AccountStore;

function fakeAlerts(overlayConnected: boolean): AlertStore {
  return {
    async createTestAlert() { throw new Error('not used'); },
    async listHistory() { throw new Error('not used'); },
    async moderate() { throw new Error('not used'); },
    async getBilling() { throw new Error('not used'); },
    async getEntitlements(_userId, chId) {
      return { schemaVersion: 'v1', channelId: chId, tier: 'creator', source: 'individual_plan', entitlementVersion: 1, values: {} };
    },
    async getCompanionState(_userId, chId): Promise<CompanionState> {
      return {
        schemaVersion: 'v1', channelId: chId, overlayConnected, pendingAlerts: 0, lastUpdatedAt: '2026-09-18T10:00:00.000Z',
        helperPaired: true, obsConnected: true, obsStatusReportedAt: null, paymentAccountConnected: true,
        mirrorReachable: false, streamPaired: false,
      };
    },
    async getCompanionLayout() { throw new Error('not used'); },
    async updateCompanionLayout() { throw new Error('not used'); },
    async acquireCompanionControlSession() { throw new Error('not used'); },
    async revokeCompanionControlSession() { throw new Error('not used'); },
    async executeCompanionAction() { throw new Error('not used'); },
    async reportCompanionObsConnection() { throw new Error('not used'); },
  };
}

function fakeEntitlement(granted: boolean): CompanionEntitlementStore {
  return {
    async getCompanionGrantPolicy(_userId, chId): Promise<CompanionGrantPolicy> {
      return { schemaVersion: 'v1', channelId: chId, sourceKey: 'alerts:creator', granted, actionLimit: 100, actionGroups: granted ? ['alerts', 'obs', 'mirror', 'stream'] : [] };
    },
  };
}

async function buildTestApp(
  goalControls?: Partial<CompanionGoalControlStore>,
  scenePresets?: Partial<CompanionScenePresetStore>,
  alerts: AlertStore = fakeAlerts(true),
  companionEntitlement: CompanionEntitlementStore = fakeEntitlement(true),
) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerCompanionGoalSceneRoutes(
    app, sessions, account,
    goalControls as CompanionGoalControlStore | undefined,
    scenePresets as CompanionScenePresetStore | undefined,
    alerts, companionEntitlement,
  );
  return app;
}

const okOutcome: GoalControlOutcome = { outcome: 'ok' };
const controlBody = { sessionId, idempotencyKey: 'test-idempotency-key-0001' };

test('POST increase-target: entitled + active + ok -> 202 with controlType', async () => {
  const app = await buildTestApp({ async increaseTarget() { return okOutcome; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/goals/${goalId}/increase-target`,
    headers: { authorization: `Bearer ${token}` },
    payload: { ...controlBody, newTargetAmountPaise: 200_000 },
  });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().controlType, 'increase_target');
  assert.equal(response.json().accepted, true);
  await app.close();
});

test('POST increase-target: not entitled -> 403, store never called', async () => {
  let called = false;
  const app = await buildTestApp(
    { async increaseTarget() { called = true; return okOutcome; } },
    undefined, fakeAlerts(true), fakeEntitlement(false),
  );
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/goals/${goalId}/increase-target`,
    headers: { authorization: `Bearer ${token}` },
    payload: { ...controlBody, newTargetAmountPaise: 200_000 },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'companion_action_group_not_entitled');
  assert.equal(called, false);
  await app.close();
});

test('POST start-timer: entitled but overlay not active -> 409, store never called', async () => {
  let called = false;
  const app = await buildTestApp(
    { async startTimer() { called = true; return okOutcome; } },
    undefined, fakeAlerts(false), fakeEntitlement(true),
  );
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/goals/${goalId}/start-timer`,
    headers: { authorization: `Bearer ${token}` },
    payload: controlBody,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().errorCode, 'companion_action_not_active');
  assert.equal(called, false);
  await app.close();
});

test('POST mark-complete: store reports session_inactive -> 409 companion_control_session_inactive', async () => {
  const outcome: GoalControlOutcome = { outcome: 'session_inactive' };
  const app = await buildTestApp({ async markComplete() { return outcome; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/goals/${goalId}/mark-complete`,
    headers: { authorization: `Bearer ${token}` },
    payload: controlBody,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().errorCode, 'companion_control_session_inactive');
  await app.close();
});

test('POST mark-complete: store reports not_found -> 404', async () => {
  const outcome: GoalControlOutcome = { outcome: 'not_found' };
  const app = await buildTestApp({ async markComplete() { return outcome; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/goals/${goalId}/mark-complete`,
    headers: { authorization: `Bearer ${token}` },
    payload: controlBody,
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('POST trigger-celebration: ok -> 202, controlType trigger_celebration, never a different status', async () => {
  const app = await buildTestApp({ async prepareCelebration() { return okOutcome; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/goals/${goalId}/trigger-celebration`,
    headers: { authorization: `Bearer ${token}` },
    payload: controlBody,
  });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().controlType, 'trigger_celebration');
  await app.close();
});

test('POST increase-target: newTargetAmountPaise below schema minimum is rejected before the store is called', async () => {
  let called = false;
  const app = await buildTestApp({ async increaseTarget() { called = true; return okOutcome; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/goals/${goalId}/increase-target`,
    headers: { authorization: `Bearer ${token}` },
    payload: { ...controlBody, newTargetAmountPaise: 10 },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

// ---- CMP-20: scene presets ----

test('POST scene-presets: ok -> 200 with presetId', async () => {
  const result: UpsertScenePresetResult = { outcome: 'ok', presetId };
  const app = await buildTestApp(undefined, { async upsert() { return result; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/scene-presets`,
    headers: { authorization: `Bearer ${token}` },
    payload: { presetName: 'gameplay' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().presetId, presetId);
  await app.close();
});

test('POST scene-presets: unrecognised name is rejected by the schema before the store is called', async () => {
  let called = false;
  const app = await buildTestApp(undefined, { async upsert() { called = true; return { outcome: 'ok', presetId }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/scene-presets`,
    headers: { authorization: `Bearer ${token}` },
    payload: { presetName: 'main_camera' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('POST scene-presets: forbidden -> 404 (non-leaking, same shape as goals.ts)', async () => {
  const result: UpsertScenePresetResult = { outcome: 'forbidden' };
  const app = await buildTestApp(undefined, { async upsert() { return result; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/scene-presets`,
    headers: { authorization: `Bearer ${token}` },
    payload: { presetName: 'brb' },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('GET scene-presets: returns the store\'s list', async () => {
  const items: ScenePreset[] = [
    { schemaVersion: 'v1', presetId, channelId, presetName: 'gameplay', createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' },
  ];
  const app = await buildTestApp(undefined, { async list() { return items; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/companion/scene-presets`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items.length, 1);
  await app.close();
});

test('POST scene-preset action: not_found -> 404', async () => {
  const result: AddScenePresetActionResult = { outcome: 'not_found' };
  const app = await buildTestApp(undefined, { async addAction() { return result; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/scene-presets/${presetId}/actions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { stepOrder: 0, actionType: 'obs_set_scene', targetLabel: 'Gameplay Scene' },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('POST scene-preset action: an unlisted actionType is rejected by the schema (no new OBS verb reaches the store)', async () => {
  let called = false;
  const app = await buildTestApp(undefined, { async addAction() { called = true; return { outcome: 'ok', actionId: 'x' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/scene-presets/${presetId}/actions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { stepOrder: 0, actionType: 'obs_do_something_new', targetLabel: 'Gameplay Scene' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('GET scene-preset actions (resolution): null -> 404', async () => {
  const app = await buildTestApp(undefined, { async listActions() { return null; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/companion/scene-presets/${presetId}/actions`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('GET scene-preset actions (resolution): returns the ordered action list', async () => {
  const actions: ScenePresetAction[] = [
    { schemaVersion: 'v1', actionId: 'a1', stepOrder: 0, actionType: 'obs_set_scene', targetLabel: 'Gameplay Scene' },
    { schemaVersion: 'v1', actionId: 'a2', stepOrder: 1, actionType: 'obs_toggle_mute', targetLabel: 'Mic' },
  ];
  const app = await buildTestApp(undefined, { async listActions() { return actions; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/companion/scene-presets/${presetId}/actions`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().actions.length, 2);
  assert.equal(response.json().actions[0].actionType, 'obs_set_scene');
  await app.close();
});
