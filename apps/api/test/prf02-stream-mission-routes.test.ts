import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerStreamMissionRoutes } from '../src/routes/stream-mission.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import {
  isValidStreamMissionObjective,
  STREAM_MISSION_OBJECTIVE_MAX_LENGTH,
  STREAM_MISSION_OBJECTIVE_MIN_LENGTH,
} from '../src/domain/stream-mission-store.js';
import type {
  StreamMission,
  StreamMissionOverlayStore,
  StreamMissionStore,
} from '../src/domain/stream-mission-store.js';

// PRF-02 slice 5, §6 catalogue module #9 (Stream Mission Card).
// registerStreamMissionRoutes is tested directly against a bare Fastify
// instance, matching prf02-master-canvas-routes.test.ts's own convention
// for a routes file that does not itself own app.ts.

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const missionId = '00000000-0000-4000-8000-000000002301';
const overlayId = '00000000-0000-4000-8000-000000000091';
const token = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-09-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const account = {
  async hasAcceptedActiveDocuments() { return true; },
} as unknown as AccountStore;

function fakeMission(overrides: Partial<StreamMission> = {}): StreamMission {
  return {
    schemaVersion: 'v1',
    missionId,
    objective: 'Reach Diamond rank tonight',
    startedAt: '2026-09-16T10:00:00.000Z',
    endedAt: null,
    createdAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

async function buildTestApp(store?: Partial<StreamMissionStore>, overlayMission?: StreamMissionOverlayStore) {
  // `removeAdditional: false` mirrors apps/api/src/app.ts:205 exactly, and
  // it is load-bearing for the "no clock-bound field on the wire" case
  // below. Fastify's DEFAULT ajv options silently STRIP a property that
  // `additionalProperties: false` forbids instead of rejecting the request;
  // the real app turns that off so the request is a 400. A bare Fastify()
  // here would therefore have tested a different server than the one this
  // codebase ships -- found by running the negative case, not by reading.
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerStreamMissionRoutes(app, sessions, store as StreamMissionStore | undefined, account, overlayMission);
  return app;
}

test('the objective bound is exactly 1-120, the same bound migration 0109 line 67 already decided for a challenge title', () => {
  assert.equal(STREAM_MISSION_OBJECTIVE_MIN_LENGTH, 1);
  assert.equal(STREAM_MISSION_OBJECTIVE_MAX_LENGTH, 120);
  assert.equal(isValidStreamMissionObjective('a'.repeat(120)), true);
  assert.equal(isValidStreamMissionObjective('a'.repeat(121)), false);
  assert.equal(isValidStreamMissionObjective(''), false);
  assert.equal(isValidStreamMissionObjective(42), false);
});

test('GET the creator-facing current mission returns the store\'s mission', async () => {
  const app = await buildTestApp({ async getCurrent() { return fakeMission(); } });
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/stream-mission`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mission.objective, 'Reach Diamond rank tonight');
  assert.equal(response.json().mission.missionId, missionId);
  await app.close();
});

test('GET with no mission running returns mission: null, never a fabricated one', async () => {
  const app = await buildTestApp({ async getCurrent() { return null; } });
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/stream-mission`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mission, null);
  await app.close();
});

test('GET without a valid session is 401, and the store is never called', async () => {
  let called = false;
  const app = await buildTestApp({ async getCurrent() { called = true; return null; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/stream-mission` });
  assert.equal(response.statusCode, 401);
  assert.equal(called, false);
  await app.close();
});

test('GET without a configured store is a retryable 503, never a 200 with fabricated data', async () => {
  const app = await buildTestApp(undefined);
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/stream-mission`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'stream_mission_store_unavailable');
  assert.equal(response.json().retryable, true);
  await app.close();
});

test('POST starts a mission and returns 201 with the created mission, passing the objective through unchanged', async () => {
  let receivedArgs: unknown[] = [];
  const app = await buildTestApp({
    async start(...args) { receivedArgs = args; return { outcome: 'ok', mission: fakeMission({ objective: 'Beat the boss with no deaths' }) }; },
  });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/stream-mission`,
    headers: { authorization: `Bearer ${token}` },
    payload: { objective: 'Beat the boss with no deaths' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().mission.objective, 'Beat the boss with no deaths');
  assert.deepEqual(receivedArgs, [userId, channelId, 'Beat the boss with no deaths']);
  await app.close();
});

test('POST accepts a 120-character objective and rejects a 121-character one at the schema layer, before the store is ever called', async () => {
  let called = 0;
  const app = await buildTestApp({
    async start() { called += 1; return { outcome: 'ok', mission: fakeMission() }; },
  });

  const atBound = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/stream-mission`,
    headers: { authorization: `Bearer ${token}` },
    payload: { objective: 'a'.repeat(120) },
  });
  assert.equal(atBound.statusCode, 201);
  assert.equal(called, 1);

  const overBound = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/stream-mission`,
    headers: { authorization: `Bearer ${token}` },
    payload: { objective: 'a'.repeat(121) },
  });
  assert.equal(overBound.statusCode, 400);
  assert.equal(called, 1, 'a 121-character objective must never reach the store');

  const empty = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/stream-mission`,
    headers: { authorization: `Bearer ${token}` },
    payload: { objective: '' },
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(called, 1, 'an empty objective must never reach the store');
  await app.close();
});

test('POST rejects any clock-bound field on the wire — the mission is session-bounded, not clock-bounded (owner decision, §6 row 9)', async () => {
  let called = 0;
  const app = await buildTestApp({
    async start() { called += 1; return { outcome: 'ok', mission: fakeMission() }; },
  });
  for (const extra of [{ durationSeconds: 900 }, { endsAt: '2026-09-16T12:00:00.000Z' }, { expiresAt: '2026-09-16T12:00:00.000Z' }]) {
    const response = await app.inject({
      method: 'POST', url: `/v1/channels/${channelId}/stream-mission`,
      headers: { authorization: `Bearer ${token}` },
      payload: { objective: 'Valid objective', ...extra },
    });
    assert.equal(response.statusCode, 400, `${Object.keys(extra)[0]} must be rejected by the route schema`);
  }
  assert.equal(called, 0, 'a body carrying a duration/end field must never reach the store');
  await app.close();
});

test('POST maps a conflict (a mission is already running) to 409, never a silent supersede and never a 500', async () => {
  const app = await buildTestApp({ async start() { return { outcome: 'conflict' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/stream-mission`,
    headers: { authorization: `Bearer ${token}` },
    payload: { objective: 'A second mission' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().errorCode, 'stream_mission_already_running');
  await app.close();
});

test('POST maps a forbidden outcome (non-owner/admin) to 404, never a leaking 403', async () => {
  const app = await buildTestApp({ async start() { return { outcome: 'forbidden' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/stream-mission`,
    headers: { authorization: `Bearer ${token}` },
    payload: { objective: 'Not my channel' },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().errorCode, 'not_found');
  await app.close();
});

test('POST maps an invalid outcome to 400 and a thrown store error to a retryable 503, never a 500', async () => {
  const invalidApp = await buildTestApp({ async start() { return { outcome: 'invalid' }; } });
  const invalid = await invalidApp.inject({
    method: 'POST', url: `/v1/channels/${channelId}/stream-mission`,
    headers: { authorization: `Bearer ${token}` }, payload: { objective: 'Valid on the wire' },
  });
  assert.equal(invalid.statusCode, 400);
  await invalidApp.close();

  const throwingApp = await buildTestApp({ async start() { throw new Error('db down'); } });
  const thrown = await throwingApp.inject({
    method: 'POST', url: `/v1/channels/${channelId}/stream-mission`,
    headers: { authorization: `Bearer ${token}` }, payload: { objective: 'Valid on the wire' },
  });
  assert.equal(thrown.statusCode, 503);
  assert.equal(thrown.json().retryable, true);
  await throwingApp.close();
});

test('POST .../end returns 204 and passes the mission id through — the write is addressed, not ambient', async () => {
  let receivedArgs: unknown[] = [];
  const app = await buildTestApp({ async end(...args) { receivedArgs = args; return { outcome: 'ok' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/stream-mission/${missionId}/end`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(receivedArgs, [userId, channelId, missionId]);
  await app.close();
});

test('POST .../end maps not_found (missing, already ended, another channel\'s, or not authorised) to 404, and a thrown error to a retryable 503', async () => {
  const notFoundApp = await buildTestApp({ async end() { return { outcome: 'not_found' }; } });
  const notFound = await notFoundApp.inject({
    method: 'POST', url: `/v1/channels/${channelId}/stream-mission/${missionId}/end`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(notFound.statusCode, 404);
  await notFoundApp.close();

  const throwingApp = await buildTestApp({ async end() { throw new Error('db down'); } });
  const thrown = await throwingApp.inject({
    method: 'POST', url: `/v1/channels/${channelId}/stream-mission/${missionId}/end`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(thrown.statusCode, 503);
  assert.equal(thrown.json().retryable, true);
  await throwingApp.close();
});

test('the overlay-facing read has no session auth chain — a missing bearer token is 401 and the store is never called', async () => {
  let called = false;
  const app = await buildTestApp(undefined, { async getForOverlay() { called = true; return null; } });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/stream-mission` });
  assert.equal(response.statusCode, 401);
  assert.equal(called, false);
  await app.close();
});

test('the overlay-facing read returns exactly missionId/objective/startedAt — no identity, no end-shaped field (§12.7)', async () => {
  let receivedToken: string | undefined;
  const app = await buildTestApp(undefined, {
    async getForOverlay(t) {
      receivedToken = t;
      return { schemaVersion: 'v1', missionId, objective: 'Reach Diamond rank tonight', startedAt: '2026-09-16T10:00:00.000Z' };
    },
  });
  const response = await app.inject({
    method: 'GET', url: `/v1/overlay-widgets/${overlayId}/stream-mission`,
    headers: { authorization: 'Bearer overlay-session-token-xyz' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['mission', 'schemaVersion']);
  assert.deepEqual(Object.keys(body.mission).sort(), ['missionId', 'objective', 'schemaVersion', 'startedAt']);
  assert.equal(receivedToken, 'overlay-session-token-xyz', 'the raw bearer token reaches the store, which fingerprints it');
  await app.close();
});

test('the overlay-facing read returns mission: null when no mission is running', async () => {
  const app = await buildTestApp(undefined, { async getForOverlay() { return null; } });
  const response = await app.inject({
    method: 'GET', url: `/v1/overlay-widgets/${overlayId}/stream-mission`,
    headers: { authorization: 'Bearer overlay-session-token-xyz' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mission, null);
  await app.close();
});

test('the overlay-facing read degrades to a retryable 503 on a thrown store error, and on a missing store — never a 200 with mission: null masquerading as "no mission"', async () => {
  const throwingApp = await buildTestApp(undefined, { async getForOverlay() { throw new Error('db down'); } });
  const thrown = await throwingApp.inject({
    method: 'GET', url: `/v1/overlay-widgets/${overlayId}/stream-mission`,
    headers: { authorization: 'Bearer overlay-session-token-xyz' },
  });
  assert.equal(thrown.statusCode, 503);
  assert.equal(thrown.json().retryable, true);
  await throwingApp.close();

  const missingApp = await buildTestApp(undefined, undefined);
  const missing = await missingApp.inject({
    method: 'GET', url: `/v1/overlay-widgets/${overlayId}/stream-mission`,
    headers: { authorization: 'Bearer overlay-session-token-xyz' },
  });
  assert.equal(missing.statusCode, 503);
  await missingApp.close();
});
