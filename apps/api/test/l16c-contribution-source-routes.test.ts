import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerGoalRoutes } from '../src/routes/goals.js';
import { registerChallengeRoutes } from '../src/routes/challenges.js';
import { registerInteractionRoutes } from '../src/routes/interactions.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import type {
  ContributionSourceInclusion,
  ContributionSourceStore,
  ListSourceInclusionsResult,
  SetSourceInclusionResult,
} from '../src/domain/contribution-source-types.js';

// L16c (0117): the goals.ts/challenges.ts/interactions.ts source-inclusion
// endpoints, tested directly against a bare Fastify instance per route
// file, mirroring l16-goals-routes.test.ts's own model.

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const goalId = '00000000-0000-4000-8000-000000000091';
const challengeId = '00000000-0000-4000-8000-000000000092';
const definitionId = '00000000-0000-4000-8000-000000000093';
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

const defaultSources: ContributionSourceInclusion[] = [
  { sourceType: 'payment', included: true },
  { sourceType: 'youtube_superchat', included: true },
];

function fakeContributionSources(overrides: Partial<ContributionSourceStore> = {}): ContributionSourceStore {
  return {
    async list(): Promise<ListSourceInclusionsResult> { return { outcome: 'ok', sources: defaultSources }; },
    async set(): Promise<SetSourceInclusionResult> { return { outcome: 'ok', sources: defaultSources }; },
    ...overrides,
  };
}

// --- goals.ts --------------------------------------------------------------

test('GET goal sources returns the resolved include/exclude state, default-included', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerGoalRoutes(app, sessions, undefined, account, undefined, fakeContributionSources());
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/goals/${goalId}/sources`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().sources, defaultSources);
  await app.close();
});

test('PUT goal sources rejects a percentage-shaped body at the schema layer (include/exclude only)', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerGoalRoutes(app, sessions, undefined, account, undefined, fakeContributionSources());
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/goals/${goalId}/sources`,
    headers: { authorization: `Bearer ${token}` },
    payload: { sourceType: 'youtube_superchat', rate: 0.7 },
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test('PUT goal sources maps a not_found outcome to 404', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerGoalRoutes(app, sessions, undefined, account, undefined, fakeContributionSources({
    async set() { return { outcome: 'not_found' }; },
  }));
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/goals/${goalId}/sources`,
    headers: { authorization: `Bearer ${token}` },
    payload: { sourceType: 'youtube_superchat', included: false },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('goal sources routes fail closed (503) with no store configured', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerGoalRoutes(app, sessions, undefined, account, undefined, undefined);
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/goals/${goalId}/sources`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 503);
  await app.close();
});

// --- challenges.ts -----------------------------------------------------------

test('PUT challenge sources excludes a source and echoes the resolved state back', async () => {
  const excluded: ContributionSourceInclusion[] = [
    { sourceType: 'payment', included: true },
    { sourceType: 'youtube_superchat', included: false },
  ];
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerChallengeRoutes(app, sessions, undefined, account, undefined, fakeContributionSources({
    async set() { return { outcome: 'ok', sources: excluded }; },
  }));
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/challenges/${challengeId}/sources`,
    headers: { authorization: `Bearer ${token}` },
    payload: { sourceType: 'youtube_superchat', included: false },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().sources, excluded);
  await app.close();
});

test('GET challenge sources requires authentication', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerChallengeRoutes(app, sessions, undefined, account, undefined, fakeContributionSources());
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/challenges/${challengeId}/sources` });
  assert.equal(response.statusCode, 401);
  await app.close();
});

// --- interactions.ts (hype mode's interaction_definition target) -----------

test('GET interaction definition sources returns the resolved state', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerInteractionRoutes(
    app, sessions, account,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined,
    fakeContributionSources(),
  );
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/interactions/${definitionId}/sources`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().sources, defaultSources);
  await app.close();
});

test('PUT interaction definition sources maps a forbidden outcome to 404, not a leaking 403', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerInteractionRoutes(
    app, sessions, account,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined,
    fakeContributionSources({ async set() { return { outcome: 'forbidden' }; } }),
  );
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/interactions/${definitionId}/sources`,
    headers: { authorization: `Bearer ${token}` },
    payload: { sourceType: 'payment', included: false },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});
