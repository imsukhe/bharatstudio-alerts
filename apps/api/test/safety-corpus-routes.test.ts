import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerSafetyCorpusRoutes } from '../src/routes/safety-corpus.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { CreateSafetyCorpusTermResult, DeleteSafetyCorpusTermResult, SafetyCorpusStore, SafetyCorpusTerm } from '../src/domain/safety-corpus-store.js';

/*
 * SAF phase 1 (migration 0151). registerSafetyCorpusRoutes is tested
 * directly against a standalone createTestFastify() instance, the same
 * shape apps/api/test/l16-goals-routes.test.ts uses. This file only
 * proves the route layer -- auth required, outcome-to-status mapping, a
 * store failure degrading to a retryable 503, an unwired store staying
 * safe, and schema-level input rejection before the store is ever
 * called. The pipeline's own correctness (normalisation, matching,
 * per-surface decisions) is proven in apps/api/test/safety-pipeline.test.ts;
 * the database layer's own guarantees are proven in
 * packages/db/tests/saf_pipeline_spine.sql.
 */

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const termId = '00000000-0000-4000-8000-0000000000a1';
const token = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-09-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

function fakeTerm(overrides: Partial<SafetyCorpusTerm> = {}): SafetyCorpusTerm {
  return {
    schemaVersion: 'v1', termId, scope: 'channel', term: 'zzzexampleterm', wholeWord: true,
    displayDecision: 'mask', ttsDecision: 'block', moderatorReviewDecision: 'hold',
    createdAt: '2026-09-17T10:00:00.000Z', ...overrides,
  };
}

async function buildTestApp(store?: Partial<SafetyCorpusStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerSafetyCorpusRoutes(app, sessions, store as SafetyCorpusStore | undefined);
  return app;
}

test('GET lists the corpus for an authenticated caller', async () => {
  const app = await buildTestApp({ async list() { return [fakeTerm(), fakeTerm({ termId: 'g1', scope: 'global' })]; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/safety/corpus-terms`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items.length, 2);
  assert.deepEqual(response.json().items.map((t: SafetyCorpusTerm) => t.scope).sort(), ['channel', 'global']);
  await app.close();
});

test('GET requires authentication', async () => {
  const app = await buildTestApp({ async list() { return []; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/safety/corpus-terms` });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('POST creates a term and maps every outcome to the right status', async () => {
  const outcomes: Record<string, CreateSafetyCorpusTermResult> = {
    created: { outcome: 'created', term: fakeTerm() },
    forbidden: { outcome: 'forbidden' },
    duplicate: { outcome: 'duplicate' },
    invalid: { outcome: 'invalid' },
  };
  for (const [key, result] of Object.entries(outcomes)) {
    const app = await buildTestApp({ async create() { return result; } });
    const response = await app.inject({
      method: 'POST', url: `/v1/channels/${channelId}/safety/corpus-terms`,
      headers: { authorization: `Bearer ${token}` },
      payload: { term: 'zzzexampleterm', displayDecision: 'mask', ttsDecision: 'block', moderatorReviewDecision: 'hold' },
    });
    const expected: Record<string, number> = { created: 201, forbidden: 404, duplicate: 409, invalid: 400 };
    assert.equal(response.statusCode, expected[key], `outcome ${key}`);
    await app.close();
  }
});

test('POST passes the exact body through to the store and rejects an invalid decision value at the schema layer', async () => {
  let seen: unknown;
  const app = await buildTestApp({
    async create(_u, _c, input) { seen = input; return { outcome: 'created', term: fakeTerm() }; },
  });
  const ok = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/safety/corpus-terms`,
    headers: { authorization: `Bearer ${token}` },
    payload: { term: 'zzzexampleterm', wholeWord: false, displayDecision: 'block', ttsDecision: 'hold', moderatorReviewDecision: 'allow' },
  });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(seen, { term: 'zzzexampleterm', wholeWord: false, displayDecision: 'block', ttsDecision: 'hold', moderatorReviewDecision: 'allow' });

  const bad = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/safety/corpus-terms`,
    headers: { authorization: `Bearer ${token}` },
    payload: { term: 'zzzexampleterm', displayDecision: 'not-a-real-decision', ttsDecision: 'block', moderatorReviewDecision: 'hold' },
  });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

test('DELETE removes a term and maps every outcome to the right status', async () => {
  const outcomes: Record<string, DeleteSafetyCorpusTermResult> = {
    ok: { outcome: 'ok' },
    forbidden: { outcome: 'forbidden' },
    not_found: { outcome: 'not_found' },
  };
  for (const [key, result] of Object.entries(outcomes)) {
    const app = await buildTestApp({ async remove() { return result; } });
    const response = await app.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/safety/corpus-terms/${termId}`, headers: { authorization: `Bearer ${token}` } });
    const expected: Record<string, number> = { ok: 204, forbidden: 404, not_found: 404 };
    assert.equal(response.statusCode, expected[key], `outcome ${key}`);
    await app.close();
  }
});

test('a store failure degrades to a retryable 503, never a crash, on every route', async () => {
  const failing: SafetyCorpusStore = {
    async list() { throw new Error('synthetic db failure'); },
    async create() { throw new Error('synthetic db failure'); },
    async remove() { throw new Error('synthetic db failure'); },
  };
  const app = await buildTestApp(failing);

  const list = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/safety/corpus-terms`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(list.statusCode, 503);
  assert.equal(list.json().retryable, true);

  const create = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/safety/corpus-terms`, headers: { authorization: `Bearer ${token}` },
    payload: { term: 'zzzexampleterm', displayDecision: 'mask', ttsDecision: 'block', moderatorReviewDecision: 'hold' },
  });
  assert.equal(create.statusCode, 503);

  const del = await app.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/safety/corpus-terms/${termId}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(del.statusCode, 503);
  await app.close();
});

test('unavailable-but-safe (503, not a thrown error) when no store is wired', async () => {
  const app = await buildTestApp(undefined);
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/safety/corpus-terms`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 503);
  await app.close();
});

test('rejects an invalid channelId at the schema layer before the store is ever called', async () => {
  let called = false;
  const app = await buildTestApp({ async list() { called = true; return []; } });
  const response = await app.inject({ method: 'GET', url: '/v1/channels/not-a-uuid/safety/corpus-terms', headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});
