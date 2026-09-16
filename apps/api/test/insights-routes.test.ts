import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { ActivationState, InsightsStore, RevenueKpis } from '../src/domain/insights-store.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4101, appOrigin: 'http://localhost:3101', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const headers = { authorization: `Bearer ${'a'.repeat(48)}` };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-09-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); }, async list() { return []; }, async revoke() { return false; },
};

const activation: ActivationState = {
  schemaVersion: 'v1',
  payoutConnected: true, payoutConnectedAt: '2026-09-10T00:00:00.000Z',
  overlayConnected: false, overlayConnectedAt: null,
  firstAlertFired: false, firstAlertFiredAt: null,
};

const kpis: RevenueKpis = {
  schemaVersion: 'v1', windowStart: null, windowEnd: null,
  averageNetTipPaise: '220000', netTipCount: '5', totalNetTipPaise: '1100000',
  supporterCount: '2', repeatSupporterCount: '1', repeatSupporterRate: '0.5',
  challengeRevenuePaise: '0', voteRevenuePaise: '0',
};

test('activation state: returns the derived state for an authenticated member, 404 when the store has nothing, 401 unauthenticated', async () => {
  let current: ActivationState | null = activation;
  const store: InsightsStore = {
    async getActivationState() { return current; },
    async getRevenueKpis() { throw new Error('not used'); },
  };
  const app = await buildApp(config, { sessions, insights: store });
  const ok = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/activation-state`, headers });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), activation);

  current = null;
  const notFound = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/activation-state`, headers });
  assert.equal(notFound.statusCode, 404);

  const unauthenticated = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/activation-state` });
  assert.equal(unauthenticated.statusCode, 401);
  await app.close();
});

test('revenue KPIs: owner gets the derived numbers; a caller the store refuses (wrong role or unknown channel) gets the same 404 as "not found" -- no membership-enumeration distinction', async () => {
  let current: RevenueKpis | null = kpis;
  let seenWindow: { start: string | null; end: string | null } | null = null;
  const store: InsightsStore = {
    async getActivationState() { throw new Error('not used'); },
    async getRevenueKpis(_user, _channel, windowStart, windowEnd) {
      seenWindow = { start: windowStart, end: windowEnd };
      return current;
    },
  };
  const app = await buildApp(config, { sessions, insights: store });
  const ok = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/revenue-kpis`, headers });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), kpis);
  assert.deepEqual(seenWindow, { start: null, end: null });

  const windowed = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/revenue-kpis?windowStart=2026-09-01T00:00:00.000Z&windowEnd=2026-09-16T00:00:00.000Z`, headers });
  assert.equal(windowed.statusCode, 200);
  assert.deepEqual(seenWindow, { start: '2026-09-01T00:00:00.000Z', end: '2026-09-16T00:00:00.000Z' });

  current = null;
  const refused = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/revenue-kpis`, headers });
  assert.equal(refused.statusCode, 404);

  const unauthenticated = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/revenue-kpis` });
  assert.equal(unauthenticated.statusCode, 401);
  await app.close();
});

test('an insights-store failure never surfaces as a crash -- both routes degrade to a clean, retryable 503', async () => {
  const store: InsightsStore = {
    async getActivationState() { throw new Error('synthetic db failure'); },
    async getRevenueKpis() { throw new Error('synthetic db failure'); },
  };
  const app = await buildApp(config, { sessions, insights: store });
  const activationFailure = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/activation-state`, headers });
  assert.equal(activationFailure.statusCode, 503);
  assert.equal(activationFailure.json().retryable, true);
  const kpiFailure = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/revenue-kpis`, headers });
  assert.equal(kpiFailure.statusCode, 503);
  assert.equal(kpiFailure.json().retryable, true);
  await app.close();
});

test('both routes are unavailable-but-safe (503, not a thrown error) when no store is wired', async () => {
  const app = await buildApp(config, { sessions });
  const activationUnavailable = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/activation-state`, headers });
  assert.equal(activationUnavailable.statusCode, 503);
  const kpiUnavailable = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/revenue-kpis`, headers });
  assert.equal(kpiUnavailable.statusCode, 503);
  await app.close();
});
