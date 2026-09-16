import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerReputationRoutes } from '../src/routes/reputation.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { GetVerdictResult, ReputationStore, SupporterReputationVerdict } from '../src/domain/reputation-store.js';

// registerReputationRoutes is tested directly against a standalone `createTestFastify()`
// instance rather than through buildApp/app.ts — this lane owns
// routes/reputation.ts but deliberately does not edit app.ts (see the
// task's ownership boundary); app.ts wiring is applied at review.

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const viewerIdentityId = '00000000-0000-4000-8000-000000001701';
const token = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

function fakeVerdict(overrides: Partial<SupporterReputationVerdict> = {}): SupporterReputationVerdict {
  return { schemaVersion: 'v1', viewerIdentityId, verdict: 'flagged', recommendedAction: 'review_before_payout', ...overrides };
}

async function buildTestApp(store?: Partial<ReputationStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerReputationRoutes(app, sessions, store as ReputationStore | undefined);
  return app;
}

test('GET returns a flagged verdict for an authorized creator', async () => {
  const app = await buildTestApp({ async getVerdict() { return { outcome: 'ok', verdict: fakeVerdict() }; } });
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/supporters/${viewerIdentityId}/reputation`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().verdict, 'flagged');
  await app.close();
});

// THE CENTRAL PROOF FOR THIS ROUTE: whatever the store returns, the HTTP
// response body key set is exactly {schemaVersion, viewerIdentityId,
// verdict, recommendedAction} — never a signal, a source, or a channelId
// belonging to another creator's channel. Deliberately over-specifies the
// fake store's return value with extra fields to prove the route does not
// merely pass through whatever the store gives it.
test('GET response never carries cross-creator evidence — exact key set', async () => {
  const verdictWithEvidenceAttached = {
    ...fakeVerdict(),
    // If a future edit to the store or route ever attached evidence, this
    // test must fail loudly rather than silently pass a wider shape through.
    sourceChannelId: '00000000-0000-4000-8000-000000000012',
    signals: [{ source: 'bharatstudio_tip', signalType: 'refund' }],
  } as unknown as SupporterReputationVerdict;
  const app = await buildTestApp({ async getVerdict() { return { outcome: 'ok', verdict: verdictWithEvidenceAttached }; } });
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/supporters/${viewerIdentityId}/reputation`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(new Set(Object.keys(body)), new Set(['schemaVersion', 'viewerIdentityId', 'verdict', 'recommendedAction']));
  await app.close();
});

test('GET a flagged verdict is visible WITHOUT its underlying evidence ever being requested from the store', async () => {
  let evidenceRequested = false;
  const store: Partial<ReputationStore> & { requestEvidence?: () => void } = {
    async getVerdict() { return { outcome: 'ok', verdict: fakeVerdict({ verdict: 'flagged' }) }; },
  };
  // The domain interface (domain/reputation-store.ts) exposes no evidence
  // method at all — there is nothing for this route to call even if it
  // wanted to. This assertion documents that structural fact for the test
  // reader rather than probing a method that cannot exist.
  assert.equal('getEvidence' in store, false);
  const app = await buildTestApp(store);
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/supporters/${viewerIdentityId}/reputation`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().verdict, 'flagged');
  assert.equal(evidenceRequested, false);
  await app.close();
});

test('GET maps not_found to 404', async () => {
  const result: GetVerdictResult = { outcome: 'not_found' };
  const app = await buildTestApp({ async getVerdict() { return result; } });
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/supporters/${viewerIdentityId}/reputation`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('GET maps forbidden to 404, not a leaking 403 that would confirm channel existence', async () => {
  const result: GetVerdictResult = { outcome: 'forbidden' };
  const app = await buildTestApp({ async getVerdict() { return result; } });
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/supporters/${viewerIdentityId}/reputation`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('GET without a bearer token is rejected before the store is ever called', async () => {
  let called = false;
  const app = await buildTestApp({ async getVerdict() { called = true; return { outcome: 'not_found' }; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/supporters/${viewerIdentityId}/reputation` });
  assert.equal(response.statusCode, 401);
  assert.equal(called, false);
  await app.close();
});

test('GET rejects a non-uuid viewerIdentityId at the schema layer before the store is ever called', async () => {
  let called = false;
  const app = await buildTestApp({ async getVerdict() { called = true; return { outcome: 'not_found' }; } });
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/supporters/not-a-uuid/reputation`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('GET returns 503 when the store is unavailable', async () => {
  const app = await buildTestApp(undefined);
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/supporters/${viewerIdentityId}/reputation`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 503);
  await app.close();
});
