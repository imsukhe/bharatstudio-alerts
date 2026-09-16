import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerAssistRoutes } from '../src/routes/assist.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import type { AssistConfirmation, AssistStore, AssistSuggestion, CreateAssistSuggestionResult, DecideAssistSuggestionResult } from '../src/domain/assist-types.js';
import type { AssistGenerationRequest, AssistSuggestionProvider } from '../src/domain/assist-provider.js';

// registerAssistRoutes is tested directly against a standalone `createTestFastify()` instance
// rather than through buildApp/app.ts — this lane owns routes/assist.ts but
// deliberately does not edit app.ts (see the task's ownership boundary),
// same pattern as l17-challenges-routes.test.ts's own note for
// registerChallengeRoutes. app.ts wiring is applied at review.

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const suggestionId = '00000000-0000-4000-8000-000000000091';
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

function fakeSuggestion(overrides: Partial<AssistSuggestion> = {}): AssistSuggestion {
  return {
    schemaVersion: 'v1', suggestionId, channelId, surface: 'config', status: 'pending',
    suggestedPayload: { suggestedQueueMode: 'auto_advance' }, basis: 'rule: idle > 90s',
    requestedByUserId: userId, createdAt: '2026-09-01T00:00:00.000Z', decidedAt: null,
    ...overrides,
  };
}

function fakeConfirmation(overrides: Partial<AssistConfirmation> = {}): AssistConfirmation {
  return {
    schemaVersion: 'v1', confirmationId: '00000000-0000-4000-8000-000000000099', suggestionId,
    decision: 'accepted', decidedByUserId: userId, decidedByRole: 'owner',
    appliedPayload: { suggestedQueueMode: 'auto_advance' }, decidedAt: '2026-09-01T00:05:00.000Z',
    ...overrides,
  };
}

async function buildTestApp(store?: Partial<AssistStore>, provider?: AssistSuggestionProvider) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerAssistRoutes(app, sessions, store as AssistStore | undefined, account, provider);
  return app;
}

test('POST generates and persists a suggestion for an entitled, authorized caller', async () => {
  const created: CreateAssistSuggestionResult = { outcome: 'created', suggestion: fakeSuggestion() };
  const app = await buildTestApp({ async create() { return created; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/assist/suggestions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { surface: 'config', tier: 'creator', signal: { averageQueueIdleSeconds: 97 } },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().suggestionId, suggestionId);
  assert.equal(response.json().status, 'pending');
  await app.close();
});

test('POST maps a tier_not_entitled outcome to 403 (an unentitled tier cannot generate suggestions)', async () => {
  const app = await buildTestApp({ async create() { return { outcome: 'tier_not_entitled' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/assist/suggestions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { surface: 'config', tier: 'free' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'assist_not_entitled');
  await app.close();
});

test('a suggestion cannot become an action without an explicit accept: creating one never calls decide, and the response carries only a pending suggestion object, never an "applied" field', async () => {
  let decideCalled = false;
  const created: CreateAssistSuggestionResult = { outcome: 'created', suggestion: fakeSuggestion() };
  const app = await buildTestApp({
    async create() { return created; },
    async decide() { decideCalled = true; return { outcome: 'decided', confirmation: fakeConfirmation() }; },
  });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/assist/suggestions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { surface: 'config', tier: 'creator' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().status, 'pending');
  assert.equal('appliedPayload' in response.json(), false);
  assert.equal(decideCalled, false);
  await app.close();
});

test('POST /decide with an accepted decision returns the recorded confirmation (the human gate)', async () => {
  const app = await buildTestApp({ async decide() { return { outcome: 'decided', confirmation: fakeConfirmation() }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/assist/suggestions/${suggestionId}/decide`,
    headers: { authorization: `Bearer ${token}` },
    payload: { decision: 'accepted' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().decision, 'accepted');
  assert.equal(response.json().decidedByUserId, userId);
  await app.close();
});

test('rejection is recorded, not just discarded: a rejected decision still returns a confirmation object with a null appliedPayload', async () => {
  const rejected: DecideAssistSuggestionResult = { outcome: 'decided', confirmation: fakeConfirmation({ decision: 'rejected', appliedPayload: null }) };
  const app = await buildTestApp({ async decide() { return rejected; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/assist/suggestions/${suggestionId}/decide`,
    headers: { authorization: `Bearer ${token}` },
    payload: { decision: 'rejected' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().decision, 'rejected');
  assert.equal(response.json().appliedPayload, null);
  await app.close();
});

test('a viewer/moderator role cannot accept on the creator\'s behalf: the store\'s forbidden outcome maps to 403, never a silent success', async () => {
  const app = await buildTestApp({ async decide() { return { outcome: 'forbidden' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/assist/suggestions/${suggestionId}/decide`,
    headers: { authorization: `Bearer ${token}` },
    payload: { decision: 'accepted' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'assist_decision_forbidden');
  await app.close();
});

test('deciding an already-decided suggestion is rejected with 409, not silently re-applied', async () => {
  const app = await buildTestApp({ async decide() { return { outcome: 'already_decided' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/assist/suggestions/${suggestionId}/decide`,
    headers: { authorization: `Bearer ${token}` },
    payload: { decision: 'accepted' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().errorCode, 'assist_already_decided');
  await app.close();
});

test('GET audit reconstructs the full lifecycle: suggested payload, basis, requester, decision, decider role, applied payload, and timestamps', async () => {
  const audit = {
    ...fakeSuggestion({ status: 'accepted', decidedAt: '2026-09-01T00:05:00.000Z' }),
    confirmation: fakeConfirmation(),
  };
  const app = await buildTestApp({ async getAudit() { return audit; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/assist/suggestions/${suggestionId}/audit`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, 'accepted');
  assert.equal(body.basis, 'rule: idle > 90s');
  assert.equal(body.requestedByUserId, userId);
  assert.equal(body.confirmation.decision, 'accepted');
  assert.equal(body.confirmation.decidedByRole, 'owner');
  assert.deepEqual(body.confirmation.appliedPayload, { suggestedQueueMode: 'auto_advance' });
  await app.close();
});

test('the provider seam receives only surface, tier and a flat non-identifying signal — no donor name, message, or payment data can cross it', async () => {
  let captured: AssistGenerationRequest | undefined;
  const spyProvider: AssistSuggestionProvider = {
    async generate(request) { captured = request; return { suggestedPayload: { ok: true }, basis: 'test' }; },
  };
  const app = await buildTestApp({ async create(_userId, _channelId, input) {
    return { outcome: 'created', suggestion: fakeSuggestion({ suggestedPayload: input.suggestedPayload, basis: input.basis }) };
  } }, spyProvider);
  await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/assist/suggestions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { surface: 'moderation', tier: 'creator', signal: { matchedFlaggedTerm: true } },
  });
  assert.ok(captured);
  assert.deepEqual(Object.keys(captured!).sort(), ['signal', 'surface', 'tier']);
  assert.deepEqual(captured!.signal, { matchedFlaggedTerm: true });
  const capturedText = JSON.stringify(captured);
  for (const forbidden of ['donorName', 'donor_name', 'message', 'email', 'payment', 'viewerId', 'phone']) {
    assert.equal(capturedText.toLowerCase().includes(forbidden.toLowerCase()), false, `provider request leaked a ${forbidden}-shaped field`);
  }
  await app.close();
});

test('a signal value outside the flat string/number/boolean contract is rejected at the schema layer before the store or provider ever run', async () => {
  let providerCalled = false;
  const spyProvider: AssistSuggestionProvider = { async generate() { providerCalled = true; return { suggestedPayload: {}, basis: '' }; } };
  const app = await buildTestApp({ async create() { throw new Error('should not be called'); } }, spyProvider);
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/assist/suggestions`,
    // A nested object (e.g. an accidental { message: { text, authorName } } passthrough)
    // fails schema validation instead of silently reaching the provider seam.
    headers: { authorization: `Bearer ${token}` },
    payload: { surface: 'moderation', tier: 'creator', signal: { donorMessage: { text: 'hi', authorName: 'Someone' } } },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(providerCalled, false);
  await app.close();
});

// CORRECTED 2026-09-16 (review: 2026-09-16-api-test-harness-validation-divergence).
// This test previously ran on a bare `Fastify()` and asserted that the request
// SUCCEEDED and the provider was called with the unrecognised `donorMessage`
// stripped out (`assert.ok(captured)` plus an exact key-set check on the
// forwarded request). That was Fastify's AJV default `removeAdditional: true`,
// not this API: `src/fastify-ajv-options.ts` sets `removeAdditional: false`,
// so the request is REJECTED with 400 and the provider seam is never reached
// at all. The stated property ("not silently forwarded") still holds — it
// holds by rejection rather than by stripping.
test('an unrecognised top-level body field is rejected, never reaching the provider seam', async () => {
  let captured: AssistGenerationRequest | undefined;
  const spyProvider: AssistSuggestionProvider = { async generate(request) { captured = request; return { suggestedPayload: {}, basis: '' }; } };
  const app = await buildTestApp({ async create(_userId, _channelId, input) { return { outcome: 'created', suggestion: fakeSuggestion({ suggestedPayload: input.suggestedPayload, basis: input.basis }) }; } }, spyProvider);
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/assist/suggestions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { surface: 'moderation', tier: 'creator', signal: { matchedFlaggedTerm: true }, donorMessage: 'hi there' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'FST_ERR_VALIDATION');
  assert.equal(captured, undefined);
  await app.close();
});

test('assist store outages return a redacted retryable 503', async () => {
  const outage = async () => { throw new Error('synthetic database outage'); };
  const app = await buildTestApp({ list: outage, decide: outage, getAudit: outage });
  const requests = [
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/assist/suggestions`, headers: { authorization: `Bearer ${token}` } }),
    app.inject({ method: 'POST', url: `/v1/channels/${channelId}/assist/suggestions/${suggestionId}/decide`, headers: { authorization: `Bearer ${token}` }, payload: { decision: 'accepted' } }),
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/assist/suggestions/${suggestionId}/audit`, headers: { authorization: `Bearer ${token}` } }),
  ];
  for (const response of await Promise.all(requests)) {
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.stringify(response.json()).includes('database outage'), false);
  }
  await app.close();
});
