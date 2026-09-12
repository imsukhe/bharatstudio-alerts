import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerGoalRoutes } from '../src/routes/goals.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import type { CreateGoalResult, GoalStore, MutateGoalResult, SupportGoal } from '../src/domain/goal-store.js';
import type { OverlayGoalStore } from '../src/domain/goal-store.js';

// registerGoalRoutes is tested directly against a bare Fastify instance
// rather than through buildApp/app.ts — this lane owns routes/goals.ts but
// deliberately does not edit app.ts (see the task's ownership boundary);
// app.ts wiring is applied at review.

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const goalId = '00000000-0000-4000-8000-000000000091';
const token = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const account = {
  async hasAcceptedActiveDocuments() { return true; },
} as unknown as AccountStore;

function fakeGoal(overrides: Partial<SupportGoal> = {}): SupportGoal {
  return {
    schemaVersion: 'v1', goalId, channelId, title: 'New PC fund', targetAmountPaise: 1_000_000,
    window: 'open', isPublic: true, progressPaise: 250_000, reached: false, ended: false,
    startedAt: '2026-09-01T00:00:00.000Z', endedAt: null, ...overrides,
  };
}

async function buildTestApp(store?: Partial<GoalStore>, overlayGoals?: OverlayGoalStore) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerGoalRoutes(app, sessions, store as GoalStore | undefined, account, overlayGoals);
  return app;
}

test('POST creates a goal for an entitled, authorized caller', async () => {
  const created: CreateGoalResult = { outcome: 'created', goal: fakeGoal() };
  const app = await buildTestApp({ async create() { return created; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/goals`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'New PC fund', targetAmountPaise: 1_000_000, window: 'open' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().goalId, goalId);
  await app.close();
});

test('POST maps a tier limit outcome to 403 goal_limit_reached', async () => {
  const app = await buildTestApp({ async create() { return { outcome: 'tier_limit_reached' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/goals`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'Fund', targetAmountPaise: 1_000_000, window: 'open' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'goal_limit_reached');
  await app.close();
});

test('POST maps a forbidden outcome (non-member / role too low) to 404, not a leaking 403', async () => {
  const app = await buildTestApp({ async create() { return { outcome: 'forbidden' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/goals`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'Fund', targetAmountPaise: 1_000_000, window: 'open' },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('POST rejects an out-of-enum window at the schema layer before the store is ever called', async () => {
  let called = false;
  const app = await buildTestApp({ async create() { called = true; return { outcome: 'invalid' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/goals`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'Fund', targetAmountPaise: 1_000_000, window: 'weekly' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('GET list returns items for an authenticated caller', async () => {
  const app = await buildTestApp({ async list() { return [fakeGoal()]; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/goals`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items.length, 1);
  await app.close();
});

test('goal management and overlay read outages return redacted retryable 503', async () => {
  const outage = async () => { throw new Error('synthetic database outage'); };
  const management = await buildTestApp({ list: outage, get: outage });
  const requests = [
    management.inject({ method: 'GET', url: `/v1/channels/${channelId}/goals`, headers: { authorization: `Bearer ${token}` } }),
    management.inject({ method: 'GET', url: `/v1/channels/${channelId}/goals/${goalId}`, headers: { authorization: `Bearer ${token}` } }),
  ];
  for (const response of await Promise.all(requests)) {
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().errorCode, 'goal_store_unavailable');
    assert.equal(JSON.stringify(response.json()).includes('database outage'), false);
  }
  await management.close();

  const overlay = await buildTestApp(undefined, { async getForOverlay() { throw new Error('synthetic database outage'); } });
  const response = await overlay.inject({ method: 'GET', url: `/v1/overlay-goals/${goalId}`, headers: { authorization: 'Bearer overlay-token' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'goal_store_unavailable');
  assert.equal(response.json().retryable, true);
  await overlay.close();
});

test('PATCH on an ended goal is rejected with 409 goal_ended', async () => {
  const result: MutateGoalResult = { outcome: 'ended' };
  const app = await buildTestApp({ async update() { return result; } });
  const response = await app.inject({
    method: 'PATCH', url: `/v1/channels/${channelId}/goals/${goalId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'Renamed' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().errorCode, 'goal_ended');
  await app.close();
});

test('POST /end reports 200 with the ended goal on success', async () => {
  const result: MutateGoalResult = { outcome: 'ok', goal: fakeGoal({ ended: true, endedAt: '2026-09-07T00:00:00.000Z' }) };
  const app = await buildTestApp({ async end() { return result; } });
  const response = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/goals/${goalId}/end`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ended, true);
  await app.close();
});

test('every management route fails closed without authentication', async () => {
  const app = await buildTestApp({});
  const responses = await Promise.all([
    app.inject({ method: 'POST', url: `/v1/channels/${channelId}/goals`, payload: { title: 'x', targetAmountPaise: 1000, window: 'open' } }),
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/goals` }),
    app.inject({ method: 'PATCH', url: `/v1/channels/${channelId}/goals/${goalId}`, payload: { title: 'x' } }),
    app.inject({ method: 'POST', url: `/v1/channels/${channelId}/goals/${goalId}/end` }),
  ]);
  for (const response of responses) assert.equal(response.statusCode, 401);
  await app.close();
});

test('the overlay widget read requires a bearer token and never falls into the session-cookie auth chain', async () => {
  const app = await buildTestApp({}, { async getForOverlay() { return null; } });
  const noAuth = await app.inject({ method: 'GET', url: '/v1/overlay-goals/00000000-0000-4000-8000-000000000099' });
  assert.equal(noAuth.statusCode, 401);
  assert.equal(noAuth.json().errorCode, 'overlay_unauthorized');
  await app.close();
});

test('the overlay widget read returns { goal: null } when there is no live public goal, never an error', async () => {
  const app = await buildTestApp({}, { async getForOverlay() { return null; } });
  const response = await app.inject({
    method: 'GET', url: '/v1/overlay-goals/00000000-0000-4000-8000-000000000099',
    headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().goal, null);
  await app.close();
});

test('the overlay widget read returns goal progress when one is live', async () => {
  const overlayGoal = { schemaVersion: 'v1' as const, goalId, title: 'PC fund', targetAmountPaise: 1_000_000, window: 'open' as const, progressPaise: 400_000, reached: false, channelId, paymentId: 'private-payment', accessToken: 'private-token' };
  const app = await buildTestApp({}, { async getForOverlay() { return overlayGoal; } });
  const response = await app.inject({
    method: 'GET', url: '/v1/overlay-goals/00000000-0000-4000-8000-000000000099',
    headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', goal: { schemaVersion: 'v1', goalId, title: 'PC fund', targetAmountPaise: 1_000_000, window: 'open', progressPaise: 400_000, reached: false } });
  await app.close();
});

test('the overlay goal route reports a missing dependency as 503, not a misleading 401', async () => {
  const app = await buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/v1/overlay-goals/00000000-0000-4000-8000-000000000099', headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' } });
  assert.equal(response.statusCode, 503);
  await app.close();
});
