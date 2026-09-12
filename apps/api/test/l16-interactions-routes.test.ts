import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerInteractionRoutes } from '../src/routes/interactions.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import type {
  CreateDefinitionResult, HypeLifecycleResult, HypeModeState, HypeModeStore, InteractionDefinition,
  InteractionDefinitionStore, InteractionOverlayStore, Leaderboard, LeaderboardStore, MutateDefinitionResult,
  MutateWidgetResult, PublicVoteStore, SupportVoteStore, VoteTally, WidgetConfig, WidgetConfigStore,
} from '../src/domain/interaction-types.js';

// registerInteractionRoutes is tested directly against a bare Fastify
// instance rather than through buildApp/app.ts — this lane owns
// routes/interactions.ts but deliberately does not edit app.ts (ownership
// boundary); wiring is applied at review. Mirrors l16-goals-routes.test.ts.

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const definitionId = '00000000-0000-4000-8000-000000000091';
const widgetConfigId = '00000000-0000-4000-8000-000000000092';
const token = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const account = { async hasAcceptedActiveDocuments() { return true; } } as unknown as AccountStore;

function fakeDefinition(overrides: Partial<InteractionDefinition> = {}): InteractionDefinition {
  return {
    schemaVersion: 'v1', definitionId, channelId, interactionType: 'tip', label: 'Basic tip',
    amountPaise: 100000, queueId: '00000000-0000-4000-8000-000000000021', ttsEnabled: false,
    moderationRule: 'review', visual: {}, config: {}, isEnabled: true, closed: false,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...overrides,
  };
}

function fakeWidget(overrides: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    schemaVersion: 'v1', widgetConfigId, channelId, widgetType: 'recent_tips', placement: {}, style: {},
    dataSource: {}, privacyScope: 'private', isEnabled: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...overrides,
  };
}

async function buildTestApp(deps: {
  definitions?: Partial<InteractionDefinitionStore>;
  votes?: Partial<SupportVoteStore>;
  publicVotes?: Partial<PublicVoteStore>;
  hype?: Partial<HypeModeStore>;
  widgets?: Partial<WidgetConfigStore>;
  leaderboard?: Partial<LeaderboardStore>;
  overlay?: Partial<InteractionOverlayStore>;
} = {}) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerInteractionRoutes(
    app, sessions, account,
    deps.definitions as InteractionDefinitionStore | undefined,
    deps.votes as SupportVoteStore | undefined,
    deps.publicVotes as PublicVoteStore | undefined,
    deps.hype as HypeModeStore | undefined,
    deps.widgets as WidgetConfigStore | undefined,
    deps.leaderboard as LeaderboardStore | undefined,
    deps.overlay as InteractionOverlayStore | undefined,
  );
  return app;
}

// --- interaction_definitions: entitlement + role gating -------------------

test('POST creates an interaction definition for an entitled, authorized caller', async () => {
  const created: CreateDefinitionResult = { outcome: 'created', definition: fakeDefinition() };
  const app = await buildTestApp({ definitions: { async create() { return created; } } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/interactions`, headers: { authorization: `Bearer ${token}` },
    payload: { interactionType: 'tip', label: 'Basic tip', amountPaise: 100000, queueId: '00000000-0000-4000-8000-000000000021' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().definitionId, definitionId);
  await app.close();
});

test('POST maps a tier limit outcome to 403 interaction_limit_reached — the entitlement gate', async () => {
  const app = await buildTestApp({ definitions: { async create() { return { outcome: 'tier_limit_reached' }; } } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/interactions`, headers: { authorization: `Bearer ${token}` },
    payload: { interactionType: 'tip', label: 'Tip', queueId: '00000000-0000-4000-8000-000000000021' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'interaction_limit_reached');
  await app.close();
});

test('POST maps a forbidden outcome (viewer/moderator role too low) to 404, not a leaking 403', async () => {
  const app = await buildTestApp({ definitions: { async create() { return { outcome: 'forbidden' }; } } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/interactions`, headers: { authorization: `Bearer ${token}` },
    payload: { interactionType: 'tip', label: 'Tip', queueId: '00000000-0000-4000-8000-000000000021' },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('POST rejects an out-of-enum interactionType at the schema layer before the store is ever called', async () => {
  let called = false;
  const app = await buildTestApp({ definitions: { async create() { called = true; return { outcome: 'invalid' }; } } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/interactions`, headers: { authorization: `Bearer ${token}` },
    payload: { interactionType: 'paid_challenge', label: 'Tip', queueId: '00000000-0000-4000-8000-000000000021' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('every interaction-definition management route fails closed without authentication', async () => {
  const app = await buildTestApp({});
  const responses = await Promise.all([
    app.inject({ method: 'POST', url: `/v1/channels/${channelId}/interactions`, payload: { interactionType: 'tip', label: 'x', queueId: '00000000-0000-4000-8000-000000000021' } }),
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/interactions` }),
    app.inject({ method: 'PATCH', url: `/v1/channels/${channelId}/interactions/${definitionId}`, payload: { label: 'x' } }),
    app.inject({ method: 'POST', url: `/v1/channels/${channelId}/interactions/${definitionId}/close` }),
    app.inject({ method: 'POST', url: `/v1/channels/${channelId}/widgets`, payload: { widgetType: 'recent_tips' } }),
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/widgets` }),
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/leaderboard` }),
    app.inject({ method: 'POST', url: `/v1/channels/${channelId}/interactions/${definitionId}/hype/start`, payload: { durationSeconds: 60 } }),
  ]);
  for (const response of responses) assert.equal(response.statusCode, 401);
  await app.close();
});

test('authenticated interaction management maps every injected durable-store failure to a redacted retryable 503', async () => {
  const outage = async () => { throw new Error('synthetic database outage'); };
  const app = await buildTestApp({
    definitions: { list: outage },
    votes: { createOption: outage, tally: outage },
    hype: { start: outage, end: outage, get: outage },
    widgets: { list: outage, update: outage, remove: outage },
    leaderboard: { get: outage },
  });
  const header = { authorization: `Bearer ${token}` };
  const responses = await Promise.all([
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/interactions`, headers: header }),
    app.inject({ method: 'POST', url: `/v1/channels/${channelId}/interactions/${definitionId}/vote-options`, headers: header, payload: { optionKey: 'option-a', label: 'Option A' } }),
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/interactions/${definitionId}/vote-tally`, headers: header }),
    app.inject({ method: 'POST', url: `/v1/channels/${channelId}/interactions/${definitionId}/hype/start`, headers: header, payload: { durationSeconds: 60 } }),
    app.inject({ method: 'POST', url: `/v1/channels/${channelId}/interactions/${definitionId}/hype/end`, headers: header }),
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/interactions/${definitionId}/hype`, headers: header }),
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/widgets`, headers: header }),
    app.inject({ method: 'PATCH', url: `/v1/channels/${channelId}/widgets/${widgetConfigId}`, headers: header, payload: { isEnabled: false } }),
    app.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/widgets/${widgetConfigId}`, headers: header }),
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/leaderboard`, headers: header }),
  ]);
  for (const response of responses) {
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().errorCode, 'interaction_store_unavailable');
    assert.equal(response.json().retryable, true);
    assert.equal(JSON.stringify(response.json()).includes('database outage'), false);
  }
  await app.close();
});

// --- support votes: public cast + resolution ------------------------------

test('the public vote-cast route needs no session cookie and reports whether the vote was newly counted', async () => {
  const app = await buildTestApp({ publicVotes: { async cast() { return { outcome: 'counted' }; } } });
  const response = await app.inject({
    method: 'POST', url: `/v1/public/interactions/${definitionId}/votes`,
    payload: { optionKey: 'game-a', voterFingerprint: 'a'.repeat(16) },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().counted, true);
  await app.close();
});

test('a repeat cast from the same voter reports counted:false, not an error', async () => {
  const app = await buildTestApp({ publicVotes: { async cast() { return { outcome: 'already_voted' }; } } });
  const response = await app.inject({
    method: 'POST', url: `/v1/public/interactions/${definitionId}/votes`,
    payload: { optionKey: 'game-a', voterFingerprint: 'a'.repeat(16) },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().counted, false);
  await app.close();
});

test('a public vote-store outage returns redacted retryable 503, not invalid_vote or a raw 500', async () => {
  const app = await buildTestApp({ publicVotes: { async cast() { throw new Error('synthetic database outage'); } } });
  const response = await app.inject({
    method: 'POST', url: `/v1/public/interactions/${definitionId}/votes`,
    payload: { optionKey: 'game-a', voterFingerprint: 'a'.repeat(16) },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'interaction_store_unavailable');
  assert.equal(response.json().retryable, true);
  assert.equal(JSON.stringify(response.json()).includes('database outage'), false);
  await app.close();
});

test('the vote-tally read requires authentication and returns the resolved winner once closed', async () => {
  const tally: VoteTally = { schemaVersion: 'v1', options: [{ optionKey: 'game-a', label: 'Game A', voteCount: 2 }], resolved: true, resolvedOptionKey: 'game-a' };
  const app = await buildTestApp({ votes: { async tally() { return tally; } } });
  const noAuth = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/interactions/${definitionId}/vote-tally` });
  assert.equal(noAuth.statusCode, 401);
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/interactions/${definitionId}/vote-tally`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().tally.resolvedOptionKey, 'game-a');
  await app.close();
});

// --- hype mode lifecycle ----------------------------------------------

test('hype mode start/end/get round-trip through the route layer', async () => {
  const state: HypeModeState = { schemaVersion: 'v1', meterPaise: 400000, thresholdPaise: 500000, reached: false, startedAt: '2026-09-07T00:00:00.000Z', endsAt: '2026-09-07T00:05:00.000Z', ended: false };
  const startResult: HypeLifecycleResult = { outcome: 'ok' };
  const app = await buildTestApp({ hype: { async start() { return startResult; }, async end() { return startResult; }, async get() { return state; } } });
  const start = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/interactions/${definitionId}/hype/start`, headers: { authorization: `Bearer ${token}` }, payload: { durationSeconds: 300 } });
  assert.equal(start.statusCode, 200);
  const get = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/interactions/${definitionId}/hype`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().hype.meterPaise, 400000);
  const end = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/interactions/${definitionId}/hype/end`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(end.statusCode, 200);
  await app.close();
});

test('hype mode start rejects an out-of-range duration at the schema layer', async () => {
  let called = false;
  const app = await buildTestApp({ hype: { async start() { called = true; return { outcome: 'ok' }; } } });
  const response = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/interactions/${definitionId}/hype/start`, headers: { authorization: `Bearer ${token}` }, payload: { durationSeconds: 10000 } });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

// --- widget_configs entitlement + role gating ------------------------------

test('POST widget maps a tier limit outcome to 403 widget_limit_reached', async () => {
  const app = await buildTestApp({ widgets: { async create() { return { outcome: 'tier_limit_reached' }; } } });
  const response = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/widgets`, headers: { authorization: `Bearer ${token}` }, payload: { widgetType: 'recent_tips' } });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'widget_limit_reached');
  await app.close();
});

test('DELETE widget maps forbidden (viewer/moderator role too low) to 404', async () => {
  const result: MutateWidgetResult = { outcome: 'forbidden' };
  const app = await buildTestApp({ widgets: { async remove() { return result; } } });
  const response = await app.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/widgets/${widgetConfigId}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('GET widgets returns items for an authenticated caller', async () => {
  const app = await buildTestApp({ widgets: { async list() { return [fakeWidget()]; } } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/widgets`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items.length, 1);
  await app.close();
});

// --- leaderboard: never an exact amount --------------------------------

test('the leaderboard route returns rank/tier rows with no amount field in the store contract', async () => {
  const board: Leaderboard = { schemaVersion: 'v1', window: 'all', rows: [{ rank: 1, viewerRef: 'viewer_abcd1234', tierLabel: 'gold' }] };
  const app = await buildTestApp({ leaderboard: { async get() { return board; } } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/leaderboard?window=weekly`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  const row = response.json().rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['rank', 'tierLabel', 'viewerRef']);
  await app.close();
});

// --- overlay reads: bearer token, never the session-cookie chain ----------

test('every overlay-widget read requires a bearer token and never falls into the session-cookie auth chain', async () => {
  const app = await buildTestApp({ overlay: { async getWidgetConfig() { return null; }, async getVoteTally() { return null; }, async getHypeMode() { return null; }, async getLeaderboard() { return null; } } });
  const responses = await Promise.all([
    app.inject({ method: 'GET', url: `/v1/overlay-widgets/${definitionId}/config/recent_tips` }),
    app.inject({ method: 'GET', url: `/v1/overlay-widgets/${definitionId}/votes/${definitionId}` }),
    app.inject({ method: 'GET', url: `/v1/overlay-widgets/${definitionId}/hype/${definitionId}` }),
    app.inject({ method: 'GET', url: `/v1/overlay-widgets/${definitionId}/leaderboard` }),
  ]);
  for (const response of responses) {
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().errorCode, 'overlay_unauthorized');
  }
  await app.close();
});

test('overlay widget configuration separates authorization from dependency failure and strips top-level internal fields', async () => {
  const url = `/v1/overlay-widgets/${definitionId}/config/recent_tips`;
  const noStore = await buildTestApp({});
  const unavailable = await noStore.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().errorCode, 'interaction_store_unavailable');
  await noStore.close();

  const pollutedConfig = {
    widgetConfigId, widgetType: 'recent_tips', placement: { anchor: 'top' }, style: { color: 'gold' }, dataSource: { limit: 5 },
    channelId, accountId: userId, paymentId: 'payment-private', providerToken: 'provider-private', refundId: 'refund-private',
  } as unknown as Pick<WidgetConfig, 'widgetConfigId' | 'widgetType' | 'placement' | 'style' | 'dataSource'>;
  const app = await buildTestApp({ overlay: { async getWidgetConfig() { return pollutedConfig; } } });
  const response = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', config: { widgetConfigId, widgetType: 'recent_tips', placement: { anchor: 'top' }, style: { color: 'gold' }, dataSource: { limit: 5 } } });
  await app.close();

  const failed = await buildTestApp({ overlay: { async getWidgetConfig() { throw new Error('synthetic database outage'); } } });
  const failedResponse = await failed.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' } });
  assert.equal(failedResponse.statusCode, 503);
  assert.equal(failedResponse.json().retryable, true);
  await failed.close();
});

test('typed overlay state reads report an unwired or failed dependency as retryable 503, never as 401', async () => {
  const noStore = await buildTestApp({});
  const routes = [
    `/v1/overlay-widgets/${definitionId}/votes/${definitionId}`,
    `/v1/overlay-widgets/${definitionId}/hype/${definitionId}`,
    `/v1/overlay-widgets/${definitionId}/leaderboard`,
  ];
  for (const url of routes) {
    const response = await noStore.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().errorCode, 'interaction_store_unavailable');
    assert.equal(response.json().retryable, true);
  }
  await noStore.close();

  const failedStore = await buildTestApp({ overlay: {
    async getVoteTally() { throw new Error('synthetic database outage'); },
    async getHypeMode() { throw new Error('synthetic database outage'); },
    async getLeaderboard() { throw new Error('synthetic database outage'); },
  } });
  for (const url of routes) {
    const response = await failedStore.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().errorCode, 'interaction_store_unavailable');
  }
  await failedStore.close();
});

test('typed overlay state reads publish only their exact rendering projections', async () => {
  const vote = {
    schemaVersion: 'v1', options: [{ optionKey: 'a', label: 'A', voteCount: 2, paymentId: 'payment-private' }],
    resolved: true, resolvedOptionKey: 'a', channelId, accountId: userId, providerToken: 'private', refundId: 'refund-private',
  } as unknown as VoteTally;
  const hypeState = {
    schemaVersion: 'v1', meterPaise: 2000, thresholdPaise: 5000, reached: false,
    startedAt: '2026-09-07T00:00:00.000Z', endsAt: '2026-09-07T00:05:00.000Z', ended: false,
    channelId, paymentInstrumentId: 'instrument-private',
  } as unknown as HypeModeState;
  const board = {
    schemaVersion: 'v1', window: 'weekly', rows: [{ rank: 1, viewerRef: 'viewer_abc', tierLabel: 'gold', amountPaise: 99999, accountId: userId }],
    providerAccountId: 'provider-private',
  } as unknown as Leaderboard;
  const app = await buildTestApp({ overlay: {
    async getVoteTally() { return vote; },
    async getHypeMode() { return hypeState; },
    async getLeaderboard() { return board; },
  } });
  const [voteResponse, hypeResponse, leaderboardResponse] = await Promise.all([
    app.inject({ method: 'GET', url: `/v1/overlay-widgets/${definitionId}/votes/${definitionId}`, headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' } }),
    app.inject({ method: 'GET', url: `/v1/overlay-widgets/${definitionId}/hype/${definitionId}`, headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' } }),
    app.inject({ method: 'GET', url: `/v1/overlay-widgets/${definitionId}/leaderboard?window=weekly`, headers: { authorization: 'Bearer overlay-token-000000000000000000000000000000' } }),
  ]);
  assert.deepEqual(voteResponse.json(), { schemaVersion: 'v1', tally: { schemaVersion: 'v1', options: [{ optionKey: 'a', label: 'A', voteCount: 2 }], resolved: true, resolvedOptionKey: 'a' } });
  assert.deepEqual(hypeResponse.json(), { schemaVersion: 'v1', hype: { schemaVersion: 'v1', meterPaise: 2000, thresholdPaise: 5000, reached: false, startedAt: '2026-09-07T00:00:00.000Z', endsAt: '2026-09-07T00:05:00.000Z', ended: false } });
  assert.deepEqual(leaderboardResponse.json(), { schemaVersion: 'v1', leaderboard: { schemaVersion: 'v1', window: 'weekly', rows: [{ rank: 1, viewerRef: 'viewer_abc', tierLabel: 'gold' }] } });
  await app.close();
});

test('an overlay leaderboard read returns rank/tier rows only, scoped by the overlay session, no amount', async () => {
  const board: Leaderboard = { schemaVersion: 'v1', window: 'all', rows: [{ rank: 1, viewerRef: 'viewer_abcd1234', tierLabel: 'bronze' }] };
  const app = await buildTestApp({ overlay: { async getLeaderboard() { return board; } } });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${definitionId}/leaderboard`, headers: { authorization: `Bearer overlay-token-000000000000000000000000000000` } });
  assert.equal(response.statusCode, 200);
  const row = response.json().leaderboard.rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['rank', 'tierLabel', 'viewerRef']);
  await app.close();
});

test('an overlay hype-mode read with no active activation returns { hype: null }, never an error', async () => {
  const app = await buildTestApp({ overlay: { async getHypeMode() { return null; } } });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${definitionId}/hype/${definitionId}`, headers: { authorization: `Bearer overlay-token-000000000000000000000000000000` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().hype, null);
  await app.close();
});
