import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerCompanionLiveOpsRoutes } from '../src/routes/companion-live-ops.js';
import type { CompanionLiveOpsStore } from '../src/domain/companion-live-ops.js';
import type { SessionStore } from '../src/auth/session-store.js';

/*
 * CMP-94/CMP-22/CMP-30 (migration 0161) -- handler-level cases for the
 * Companion live-ops routes: stream markers, Recent Actions, Wrap
 * Stream. The SQL layer's own proof of role gates, the cap mechanism,
 * the closed reversible set and the structural prepare-not-fire
 * guarantee lives in packages/db/tests/
 * cmp_live_ops_recent_actions_markers_wrap.sql -- this file is the
 * route boundary only: status codes, schema validation, and that this
 * file forwards store results without inventing behavior of its own.
 */

const channelId = '00000000-0000-4000-8000-000000006201';
const markerId = '00000000-0000-4000-8000-000000006202';
const wrapSessionId = '00000000-0000-4000-8000-000000006203';
const userId = '00000000-0000-4000-8000-000000000001';
const token = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-09-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const authHeaders = { authorization: `Bearer ${token}` };

async function buildTestApp(store?: Partial<CompanionLiveOpsStore>, authed = true) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerCompanionLiveOpsRoutes(app, authed ? sessions : undefined, store as CompanionLiveOpsStore | undefined);
  return app;
}

// --- unauthenticated -------------------------------------------------

test('companion live-ops: every route rejects an unauthenticated caller', async () => {
  const app = await buildTestApp({}, false);
  const calls: Array<[string, string, Record<string, unknown>?]> = [
    ['POST', `/v1/channels/${channelId}/companion/stream-markers`, { label: 'x' }],
    ['DELETE', `/v1/channels/${channelId}/companion/stream-markers/${markerId}`],
    ['GET', `/v1/channels/${channelId}/companion/stream-markers`],
    ['GET', `/v1/channels/${channelId}/companion/recent-actions`],
    ['POST', `/v1/channels/${channelId}/companion/wrap-stream`],
    ['POST', `/v1/channels/${channelId}/companion/wrap-stream/${wrapSessionId}/confirm-stop`, { obsStoppedConfirmed: true, broadcastCompleteConfirmed: true }],
    ['POST', `/v1/channels/${channelId}/companion/wrap-stream/${wrapSessionId}/summary`],
    ['GET', `/v1/channels/${channelId}/companion/wrap-stream/${wrapSessionId}`],
  ];
  for (const [method, url, payload] of calls) {
    const response = await app.inject({ method: method as 'GET' | 'POST' | 'DELETE', url, payload });
    assert.notEqual(response.statusCode, 200, `${method} ${url} must not succeed unauthenticated`);
    assert.notEqual(response.statusCode, 201, `${method} ${url} must not succeed unauthenticated`);
  }
  await app.close();
});

// --- create marker -----------------------------------------------------

test('companion live-ops: creating a marker returns 201 with the store value, unknown body fields are a 400', async () => {
  const marker = { markerId, markerType: 'note' as const, label: 'great clutch', markerAt: '2026-09-18T00:00:00.000Z', createdAt: '2026-09-18T00:00:00.000Z' };
  const app = await buildTestApp({
    async createStreamMarker() { return { outcome: 'ok', value: marker }; },
  });

  const ok = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/stream-markers`, headers: authHeaders, payload: { label: 'great clutch' } });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(ok.json(), { schemaVersion: 'v1', marker });

  const badBody = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/stream-markers`, headers: authHeaders,
    payload: { label: 'x', maxActiveMarkers: 999 },
  });
  assert.equal(badBody.statusCode, 400, 'a client must never be able to smuggle an unknown field, like a cap, into the request body');
  await app.close();
});

test('companion live-ops: a cap-rejected marker create is a 409, a non-member channel is a 404', async () => {
  const rejectedApp = await buildTestApp({
    async createStreamMarker() { return { outcome: 'rejected', message: 'stream marker cap reached for this channel' }; },
  });
  const rejected = await rejectedApp.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/stream-markers`, headers: authHeaders, payload: { label: 'x' } });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().errorCode, 'stream_marker_rejected');
  await rejectedApp.close();

  const notFoundApp = await buildTestApp({ async createStreamMarker() { return { outcome: 'not_found' }; } });
  const notFound = await notFoundApp.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/stream-markers`, headers: authHeaders, payload: { label: 'x' } });
  assert.equal(notFound.statusCode, 404);
  await notFoundApp.close();
});

// --- delete marker (the CMP-94 undo path) -------------------------------

test('companion live-ops: deleting a marker returns 200, an already-deleted marker is a 409', async () => {
  const okApp = await buildTestApp({
    async deleteStreamMarker() { return { outcome: 'ok', value: { markerId, deletedAt: '2026-09-18T00:05:00.000Z' } }; },
  });
  const ok = await okApp.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/companion/stream-markers/${markerId}`, headers: authHeaders });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { schemaVersion: 'v1', markerId, deletedAt: '2026-09-18T00:05:00.000Z' });
  await okApp.close();

  const rejectedApp = await buildTestApp({
    async deleteStreamMarker() { return { outcome: 'rejected', message: 'stream marker already removed' }; },
  });
  const rejected = await rejectedApp.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/companion/stream-markers/${markerId}`, headers: authHeaders });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().errorCode, 'stream_marker_delete_rejected');
  await rejectedApp.close();
});

// --- Recent Actions ------------------------------------------------------

test('companion live-ops: recent actions forwards the store projection verbatim, and validates the limit', async () => {
  const action = {
    actionId: '00000000-0000-4000-8000-000000006210', action: 'companion.stream_marker.create', category: 'operational' as const,
    targetType: 'companion_stream_marker', targetId: markerId, actorUserId: userId, occurredAt: '2026-09-18T00:00:00.000Z',
    reversible: true, reason: null,
  };
  const app = await buildTestApp({ async getRecentActions() { return { outcome: 'ok', value: [action] }; } });

  const ok = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/companion/recent-actions`, headers: authHeaders });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { schemaVersion: 'v1', channelId, actions: [action] });

  const badLimit = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/companion/recent-actions?limit=999`, headers: authHeaders });
  assert.equal(badLimit.statusCode, 400, 'the route must not accept a limit above the projection\'s own 50-row ceiling');
  await app.close();
});

// --- Wrap Stream -----------------------------------------------------

test('companion live-ops: begin/confirm-stop/summary/read wrap stream forward store outcomes', async () => {
  const session = {
    wrapSessionId, status: 'summary_ready' as const, obsStoppedConfirmed: true, broadcastCompleteConfirmed: true,
    confirmedStopAt: '2026-09-18T00:10:00.000Z', windowSince: '2026-09-17T00:00:00.000Z', windowUntil: '2026-09-18T00:10:00.000Z',
    summary: { markerCount: 1 }, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:10:00.000Z',
  };
  const app = await buildTestApp({
    async beginWrapStream() { return { outcome: 'ok', value: { wrapSessionId, status: 'confirming_stop', createdAt: '2026-09-18T00:00:00.000Z' } }; },
    async confirmWrapStreamStop() { return { outcome: 'ok', value: { wrapSessionId, status: 'stop_confirmed', confirmedStopAt: '2026-09-18T00:10:00.000Z' } }; },
    async generateWrapStreamSummary() { return { outcome: 'ok', value: session }; },
    async getWrapStreamSession() { return { outcome: 'ok', value: { session, preparedItems: [] } }; },
  });

  const begin = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/wrap-stream`, headers: authHeaders });
  assert.equal(begin.statusCode, 201);
  assert.equal(begin.json().status, 'confirming_stop');

  const confirm = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/wrap-stream/${wrapSessionId}/confirm-stop`, headers: authHeaders,
    payload: { obsStoppedConfirmed: true, broadcastCompleteConfirmed: true },
  });
  assert.equal(confirm.statusCode, 200);
  assert.equal(confirm.json().status, 'stop_confirmed');

  const confirmBadBody = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/companion/wrap-stream/${wrapSessionId}/confirm-stop`, headers: authHeaders,
    payload: { obsStoppedConfirmed: 'yes', broadcastCompleteConfirmed: true },
  });
  assert.equal(confirmBadBody.statusCode, 400, 'confirm-stop flags must be real booleans, matching safe-mode\'s own enum-not-type-boolean posture');

  const summary = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/wrap-stream/${wrapSessionId}/summary`, headers: authHeaders });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json().session.status, 'summary_ready');

  const read = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/companion/wrap-stream/${wrapSessionId}`, headers: authHeaders });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), { schemaVersion: 'v1', session, preparedItems: [] });

  await app.close();
});

test('companion live-ops: a wrap-stream summary generated before stop is confirmed is a 409', async () => {
  const app = await buildTestApp({
    async generateWrapStreamSummary() { return { outcome: 'rejected', message: 'wrap session must have a confirmed stop before generating a summary' }; },
  });
  const response = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/wrap-stream/${wrapSessionId}/summary`, headers: authHeaders });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().errorCode, 'wrap_stream_summary_rejected');
  await app.close();
});

test('companion live-ops: a missing store is a retryable 503, never a fabricated empty success', async () => {
  const app = await buildTestApp(undefined, true);
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/companion/recent-actions`, headers: authHeaders });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});
