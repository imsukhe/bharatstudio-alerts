import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerGoalTriggerRoutes } from '../src/routes/goal-triggers.js';
import type {
  AddGoalTriggerActionInput,
  AddGoalTriggerConditionInput,
  CreateGoalTriggerRuleInput,
  GoalTriggerAction,
  GoalTriggerActionRun,
  GoalTriggerCondition,
  GoalTriggerRule,
  GoalTriggerStore,
} from '../src/domain/goal-trigger-store.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';

/*
 * GOA-04/GOA-09/GOA-18/GOA-19/GOA-20/GOA-21 (migration 0158): the goal
 * trigger engine spine's route layer. The SQL layer's own proof -- the
 * GOA-20 structural scan, the GOA-21 unconfigured-outbound-does-not-fire
 * proof, the GOA-18 ordering/delay proof, and the GOA-19 fail-safe proof
 * -- lives in packages/db/tests/goa_trigger_engine.sql. This file is the
 * route layer's own, narrower surface: request validation (the
 * fireMode/actionType and threshold/triggerType couplings are rejected
 * BEFORE the store is ever called) and the non-leaking 404 mapping.
 */

const channelId = '00000000-0000-4000-8000-000000007210';
const goalId = '00000000-0000-4000-8000-000000007211';
const ruleId = '00000000-0000-4000-8000-000000007212';
const evaluationId = '00000000-0000-4000-8000-000000007213';
const userId = '00000000-0000-4000-8000-000000000001';
const rulesUrl = `/v1/channels/${channelId}/goals/${goalId}/triggers`;
const ruleUrl = `/v1/channels/${channelId}/goal-triggers/${ruleId}`;
const conditionsUrl = `/v1/channels/${channelId}/goal-triggers/${ruleId}/conditions`;
const actionsUrl = `/v1/channels/${channelId}/goal-triggers/${ruleId}/actions`;
const runsUrl = `/v1/channels/${channelId}/goal-trigger-runs/${evaluationId}`;

const token = 'a'.repeat(48);
const authHeaders = { authorization: `Bearer ${token}` };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-09-18T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const account = {
  async hasAcceptedActiveDocuments() { return true; },
} as unknown as AccountStore;

async function buildApp(store?: Partial<GoalTriggerStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerGoalTriggerRoutes(app, sessions, store as GoalTriggerStore | undefined, account);
  return app;
}

const rule: GoalTriggerRule = {
  schemaVersion: 'v1',
  ruleId,
  goalId,
  triggerType: 'threshold_percentage',
  enabled: true,
  thresholdPercentage: 50,
  thresholdAmountPaise: null,
  repeatMode: 'once_per_stream',
  createdAt: '2026-09-17T10:00:00.000Z',
  updatedAt: '2026-09-17T10:00:00.000Z',
};

const condition: GoalTriggerCondition = {
  schemaVersion: 'v1',
  conditionId: '00000000-0000-4000-8000-000000007214',
  conditionType: 'not_in_clutch',
  conditionValue: null,
  createdAt: '2026-09-17T10:00:00.000Z',
};

const action: GoalTriggerAction = {
  schemaVersion: 'v1',
  actionId: '00000000-0000-4000-8000-000000007215',
  stepOrder: 0,
  delayMs: 0,
  actionType: 'noop_local_quiet',
  fireMode: 'prepare',
  createdAt: '2026-09-17T10:00:00.000Z',
  updatedAt: '2026-09-17T10:00:00.000Z',
};

const actionRun: GoalTriggerActionRun = {
  schemaVersion: 'v1',
  runId: '00000000-0000-4000-8000-000000007216',
  actionId: action.actionId,
  stepOrder: 0,
  delayMs: 0,
  status: 'blocked_interlock',
  blockedReason: 'loud_or_fullscreen actions are suppressed (GOA-20)',
  createdAt: '2026-09-17T10:00:00.000Z',
};

// =====================================================================
// Auth / availability, matching every other config route file.
// =====================================================================

test('no bearer token is 401, and a missing store is a retryable 503', async () => {
  const app = await buildApp({ async listRules() { return [rule]; } });
  const noToken = await app.inject({ method: 'GET', url: rulesUrl });
  assert.equal(noToken.statusCode, 401);

  const noStore = await buildApp(undefined);
  const unavailable = await noStore.inject({ method: 'GET', url: rulesUrl, headers: authHeaders });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().retryable, true);
  await app.close();
  await noStore.close();
});

// =====================================================================
// Rules.
// =====================================================================

test('listing rules for a channel/goal the caller cannot see is 404, never 403', async () => {
  const app = await buildApp({ async listRules() { return null; } });
  const response = await app.inject({ method: 'GET', url: rulesUrl, headers: authHeaders });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('a valid rule list round-trips', async () => {
  const app = await buildApp({ async listRules() { return [rule]; } });
  const response = await app.inject({ method: 'GET', url: rulesUrl, headers: authHeaders });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', rules: [rule] });
  await app.close();
});

test('GOA-04: mismatched trigger type and threshold fields are rejected before the store is called', async () => {
  let called = false;
  const app = await buildApp({ async createRule() { called = true; return { outcome: 'ok', rule }; } });
  const response = await app.inject({
    method: 'POST', url: rulesUrl, headers: authHeaders,
    payload: { triggerType: 'reached_100', thresholdPercentage: 50, thresholdAmountPaise: null, repeatMode: 'once_per_stream' } satisfies CreateGoalTriggerRuleInput,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('a valid create request round-trips as 201', async () => {
  const app = await buildApp({ async createRule() { return { outcome: 'ok', rule }; } });
  const response = await app.inject({
    method: 'POST', url: rulesUrl, headers: authHeaders,
    payload: { triggerType: 'threshold_percentage', thresholdPercentage: 50, thresholdAmountPaise: null, repeatMode: 'once_per_stream' } satisfies CreateGoalTriggerRuleInput,
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', rule });
  await app.close();
});

test('toggling enabled on a rule that does not belong to this channel is 404', async () => {
  const app = await buildApp({ async setRuleEnabled() { return { outcome: 'not_found' }; } });
  const response = await app.inject({ method: 'PATCH', url: ruleUrl, headers: authHeaders, payload: { enabled: false } });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('a valid enabled toggle is 204', async () => {
  const app = await buildApp({ async setRuleEnabled() { return { outcome: 'ok' }; } });
  const response = await app.inject({ method: 'PATCH', url: ruleUrl, headers: authHeaders, payload: { enabled: false } });
  assert.equal(response.statusCode, 204);
  await app.close();
});

// =====================================================================
// Conditions (GOA-19).
// =====================================================================

test('named_scene without a conditionValue is rejected before the store is called', async () => {
  let called = false;
  const app = await buildApp({ async addCondition() { called = true; return { outcome: 'ok', condition }; } });
  const response = await app.inject({
    method: 'POST', url: conditionsUrl, headers: authHeaders,
    payload: { conditionType: 'named_scene', conditionValue: null } satisfies AddGoalTriggerConditionInput,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('a non-named_scene condition carrying a conditionValue is rejected', async () => {
  let called = false;
  const app = await buildApp({ async addCondition() { called = true; return { outcome: 'ok', condition }; } });
  const response = await app.inject({
    method: 'POST', url: conditionsUrl, headers: authHeaders,
    payload: { conditionType: 'not_in_clutch', conditionValue: 'main' } satisfies AddGoalTriggerConditionInput,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('a valid condition add round-trips as 201', async () => {
  const app = await buildApp({ async addCondition() { return { outcome: 'ok', condition }; } });
  const response = await app.inject({
    method: 'POST', url: conditionsUrl, headers: authHeaders,
    payload: { conditionType: 'not_in_clutch', conditionValue: null } satisfies AddGoalTriggerConditionInput,
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', condition });
  await app.close();
});

// =====================================================================
// Actions (GOA-18/GOA-21) -- THIS IS THE PROHIBITION SURFACE.
// =====================================================================

test('GOA-21: requesting fireMode = fire for an outbound action is rejected before the store is called', async () => {
  let called = false;
  const app = await buildApp({ async addAction() { called = true; return { outcome: 'ok', action }; } });
  const response = await app.inject({
    method: 'POST', url: actionsUrl, headers: authHeaders,
    payload: { stepOrder: 0, delayMs: 0, actionType: 'noop_outbound', fireMode: 'fire' } satisfies AddGoalTriggerActionInput,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('GOA-21: an outbound action with fireMode omitted as null reaches the store as null (defaults to prepare downstream)', async () => {
  let receivedFireMode: unknown = 'unset';
  const app = await buildApp({
    async addAction(_u, _c, _r, input) { receivedFireMode = input.fireMode; return { outcome: 'ok', action }; },
  });
  const response = await app.inject({
    method: 'POST', url: actionsUrl, headers: authHeaders,
    payload: { stepOrder: 0, delayMs: 0, actionType: 'noop_outbound', fireMode: null } satisfies AddGoalTriggerActionInput,
  });
  assert.equal(response.statusCode, 201);
  assert.equal(receivedFireMode, null);
  await app.close();
});

test('a local action may explicitly request fireMode = fire', async () => {
  const app = await buildApp({ async addAction() { return { outcome: 'ok', action: { ...action, fireMode: 'fire' } }; } });
  const response = await app.inject({
    method: 'POST', url: actionsUrl, headers: authHeaders,
    payload: { stepOrder: 0, delayMs: 0, actionType: 'noop_local_quiet', fireMode: 'fire' } satisfies AddGoalTriggerActionInput,
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().action.fireMode, 'fire');
  await app.close();
});

test('GOA-18: stepOrder and delayMs round-trip exactly as sent, not defaulted or reordered', async () => {
  let received: { stepOrder: number; delayMs: number } | undefined;
  const app = await buildApp({
    async addAction(_u, _c, _r, input) { received = { stepOrder: input.stepOrder, delayMs: input.delayMs }; return { outcome: 'ok', action }; },
  });
  const response = await app.inject({
    method: 'POST', url: actionsUrl, headers: authHeaders,
    payload: { stepOrder: 3, delayMs: 12500, actionType: 'noop_local_quiet', fireMode: null } satisfies AddGoalTriggerActionInput,
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(received, { stepOrder: 3, delayMs: 12500 });
  await app.close();
});

test('listing actions for a rule that does not belong to this channel is 404', async () => {
  const app = await buildApp({ async listActions() { return null; } });
  const response = await app.inject({ method: 'GET', url: actionsUrl, headers: authHeaders });
  assert.equal(response.statusCode, 404);
  await app.close();
});

// =====================================================================
// Action runs -- read-only reflection of a system-driven dispatch.
// =====================================================================

test('a blocked_interlock run is returned with its reason intact, never summarised away', async () => {
  const app = await buildApp({ async listActionRuns() { return [actionRun]; } });
  const response = await app.inject({ method: 'GET', url: runsUrl, headers: authHeaders });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', runs: [actionRun] });
  await app.close();
});

test('runs for an evaluation outside this channel are 404', async () => {
  const app = await buildApp({ async listActionRuns() { return null; } });
  const response = await app.inject({ method: 'GET', url: runsUrl, headers: authHeaders });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('a store failure on any route is a retryable 503', async () => {
  const app = await buildApp({ async listRules() { throw new Error('boom'); } });
  const response = await app.inject({ method: 'GET', url: rulesUrl, headers: authHeaders });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});
