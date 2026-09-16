import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerChallengeRoutes } from '../src/routes/challenges.js';
import { CHALLENGE_FAILURE_COPY } from '../src/domain/challenge-store.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import type { Challenge, ChallengeStore, CreateChallengeResult, OverlayChallengeStore, TransitionChallengeResult } from '../src/domain/challenge-store.js';

// registerChallengeRoutes is tested directly against a standalone `createTestFastify()`
// instance rather than through buildApp/app.ts — this lane owns
// routes/challenges.ts but deliberately does not edit app.ts (see the
// task's ownership boundary); app.ts wiring is applied at review, exactly
// like l16-goals-routes.test.ts's own note for registerGoalRoutes.

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const challengeId = '00000000-0000-4000-8000-000000000091';
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

function fakeChallenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    schemaVersion: 'v1', challengeId, channelId, title: 'Shave my head at target', description: null,
    kind: 'stake', targetAmountPaise: 500_000, state: 'draft', isPublic: true,
    progressPaise: 0, targetReached: false, startedAt: null, endedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z', ...overrides,
  };
}

async function buildTestApp(store?: Partial<ChallengeStore>, overlayChallenges?: OverlayChallengeStore) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerChallengeRoutes(app, sessions, store as ChallengeStore | undefined, account, overlayChallenges);
  return app;
}

test('POST creates a challenge for an entitled, authorized caller', async () => {
  const created: CreateChallengeResult = { outcome: 'created', challenge: fakeChallenge() };
  const app = await buildTestApp({ async create() { return created; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/challenges`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'Shave my head at target', kind: 'stake', targetAmountPaise: 500_000 },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().challengeId, challengeId);
  await app.close();
});

test('POST maps a tier limit outcome to 403 challenge_limit_reached (unentitled tier cannot create one)', async () => {
  const app = await buildTestApp({ async create() { return { outcome: 'tier_limit_reached' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/challenges`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'Fund', kind: 'bounty', targetAmountPaise: 1_000_000 },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'challenge_limit_reached');
  await app.close();
});

test('POST maps a forbidden outcome (non-member / role too low) to 404, not a leaking 403', async () => {
  const app = await buildTestApp({ async create() { return { outcome: 'forbidden' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/challenges`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'Fund', kind: 'stake', targetAmountPaise: 1_000_000 },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('POST rejects an out-of-enum kind at the schema layer before the store is ever called', async () => {
  let called = false;
  const app = await buildTestApp({ async create() { called = true; return { outcome: 'invalid' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/challenges`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'Fund', kind: 'raffle', targetAmountPaise: 1_000_000 },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('GET list returns items and the locked failure copy verbatim', async () => {
  const app = await buildTestApp({ async list() { return [fakeChallenge()]; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/challenges`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.failureCopy, CHALLENGE_FAILURE_COPY);
  await app.close();
});

test('challenge management and overlay read outages return redacted retryable 503', async () => {
  const outage = async () => { throw new Error('synthetic database outage'); };
  const management = await buildTestApp({ list: outage, get: outage });
  const requests = [
    management.inject({ method: 'GET', url: `/v1/channels/${channelId}/challenges`, headers: { authorization: `Bearer ${token}` } }),
    management.inject({ method: 'GET', url: `/v1/channels/${channelId}/challenges/${challengeId}`, headers: { authorization: `Bearer ${token}` } }),
  ];
  for (const response of await Promise.all(requests)) {
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().errorCode, 'challenge_store_unavailable');
    assert.equal(JSON.stringify(response.json()).includes('database outage'), false);
  }
  await management.close();

  const overlay = await buildTestApp(undefined, { async getForOverlay() { throw new Error('synthetic database outage'); } });
  const response = await overlay.inject({ method: 'GET', url: `/v1/overlay-challenges/${challengeId}`, headers: { authorization: 'Bearer overlay-token' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'challenge_store_unavailable');
  assert.equal(response.json().retryable, true);
  await overlay.close();
});

test('GET one returns the failure copy alongside the challenge', async () => {
  const app = await buildTestApp({ async get() { return fakeChallenge({ state: 'active' }); } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/challenges/${challengeId}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().failureCopy, CHALLENGE_FAILURE_COPY);
  assert.equal(response.json().state, 'active');
  await app.close();
});

test('POST transition rejects an out-of-enum toState at the schema layer', async () => {
  let called = false;
  const app = await buildTestApp({ async transition() { called = true; return { outcome: 'invalid' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/challenges/${challengeId}/transition`,
    headers: { authorization: `Bearer ${token}` },
    payload: { toState: 'draft' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('POST transition maps invalid_transition to 409, never a 500', async () => {
  const result: TransitionChallengeResult = { outcome: 'invalid_transition' };
  const app = await buildTestApp({ async transition() { return result; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/challenges/${challengeId}/transition`,
    headers: { authorization: `Bearer ${token}` },
    payload: { toState: 'succeeded' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().errorCode, 'invalid_transition');
  await app.close();
});

test('POST transition maps forbidden (viewer/moderator role) to 404, not a leaking 403', async () => {
  const app = await buildTestApp({ async transition() { return { outcome: 'forbidden' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/challenges/${challengeId}/transition`,
    headers: { authorization: `Bearer ${token}` },
    payload: { toState: 'active' },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('POST transition reports 200 with the transitioned challenge on success', async () => {
  const result: TransitionChallengeResult = { outcome: 'ok', challenge: fakeChallenge({ state: 'active', startedAt: '2026-09-07T00:00:00.000Z' }) };
  const app = await buildTestApp({ async transition() { return result; } });
  const response = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/challenges/${challengeId}/transition`, headers: { authorization: `Bearer ${token}` }, payload: { toState: 'active' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().state, 'active');
  await app.close();
});

test('every management route fails closed without authentication', async () => {
  const app = await buildTestApp({});
  const responses = await Promise.all([
    app.inject({ method: 'POST', url: `/v1/channels/${channelId}/challenges`, payload: { title: 'x', kind: 'stake', targetAmountPaise: 1000 } }),
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/challenges` }),
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/challenges/${challengeId}` }),
    app.inject({ method: 'POST', url: `/v1/channels/${channelId}/challenges/${challengeId}/transition`, payload: { toState: 'active' } }),
  ]);
  for (const response of responses) assert.equal(response.statusCode, 401);
  await app.close();
});

test('the overlay widget read requires a bearer token and never falls into the session-cookie auth chain', async () => {
  const app = await buildTestApp({}, { async getForOverlay() { return null; } });
  const noAuth = await app.inject({ method: 'GET', url: '/v1/overlay-challenges/00000000-0000-4000-8000-000000000099' });
  assert.equal(noAuth.statusCode, 401);
  assert.equal(noAuth.json().errorCode, 'overlay_unauthorized');
  await app.close();
});

test('the overlay widget read returns { challenge: null } when there is no live public challenge, never an error', async () => {
  const app = await buildTestApp({}, { async getForOverlay() { return null; } });
  const response = await app.inject({
    method: 'GET', url: '/v1/overlay-challenges/00000000-0000-4000-8000-000000000099',
    headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().challenge, null);
  await app.close();
});

test('the overlay widget read returns challenge progress for every lifecycle state without throwing', async () => {
  const states: Array<Challenge['state']> = ['draft', 'active', 'succeeded', 'failed', 'cancelled'];
  for (const state of states) {
    const overlayChallenge = { schemaVersion: 'v1' as const, challengeId, title: 'Bounty', kind: 'bounty' as const, targetAmountPaise: 1_000_000, state, progressPaise: 400_000, targetReached: false, channelId, providerUserId: 'private-provider', refundId: 'private-refund' };
    const app = await buildTestApp({}, { async getForOverlay() { return overlayChallenge; } });
    const response = await app.inject({
      method: 'GET', url: '/v1/overlay-challenges/00000000-0000-4000-8000-000000000099',
      headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { schemaVersion: 'v1', challenge: { schemaVersion: 'v1', challengeId, title: 'Bounty', kind: 'bounty', targetAmountPaise: 1_000_000, state, progressPaise: 400_000, targetReached: false } });
    await app.close();
  }
});

test('the overlay challenge route reports a missing dependency as 503, not a misleading 401', async () => {
  const app = await buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/v1/overlay-challenges/00000000-0000-4000-8000-000000000099', headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' } });
  assert.equal(response.statusCode, 503);
  await app.close();
});
