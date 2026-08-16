import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { ReferralHistory, ReferralOverview, ReferralStore } from '../src/domain/referrals.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const overview: ReferralOverview = {
  schemaVersion: 'v1', pendingCount: 1, paidPendingHoldCount: 0, creditedCount: 2,
  flaggedOrRevokedCount: 0, bankedCreditDays: 0, lifetimeCreditedDays: 60,
};

const history: ReferralHistory = {
  schemaVersion: 'v1',
  items: [{ referralId: '00000000-0000-4000-8000-000000000091', status: 'credited', attributedAt: '2026-08-01T10:00:00.000Z', creditedAt: '2026-08-15T10:00:00.000Z', creditDays: 30 }],
};

test('the referral overview route returns the aggregate for an authenticated caller', async () => {
  let seenChannelId: string | undefined;
  const store: ReferralStore = {
    async getOverview(_user, channel) { seenChannelId = channel; return overview; },
    async listHistory() { throw new Error('not used'); },
    async attribute() { throw new Error('not used'); },
  };
  const app = await buildApp(config, { sessions, referrals: store });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/referrals/overview`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), overview);
  assert.equal(seenChannelId, channelId);
  await app.close();
});

test('the referral history route returns the recent-activity list', async () => {
  const store: ReferralStore = {
    async getOverview() { throw new Error('not used'); },
    async listHistory() { return history; },
    async attribute() { throw new Error('not used'); },
  };
  const app = await buildApp(config, { sessions, referrals: store });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/referrals`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), history);
  await app.close();
});

test('a non-owner/admin caller sees empty results, not a 403 — enforcement stays at the database layer', async () => {
  const empty: ReferralOverview = { schemaVersion: 'v1', pendingCount: 0, paidPendingHoldCount: 0, creditedCount: 0, flaggedOrRevokedCount: 0, bankedCreditDays: 0, lifetimeCreditedDays: 0 };
  const store: ReferralStore = {
    async getOverview() { return empty; },
    async listHistory() { return { schemaVersion: 'v1', items: [] }; },
    async attribute() { throw new Error('not used'); },
  };
  const app = await buildApp(config, { sessions, referrals: store });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/referrals/overview`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), empty);
  await app.close();
});

test('both referral routes reject unauthenticated callers and fail closed without a store', async () => {
  const app = await buildApp(config, { sessions });
  const unauthOverview = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/referrals/overview` });
  assert.equal(unauthOverview.statusCode, 401);
  const unauthHistory = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/referrals` });
  assert.equal(unauthHistory.statusCode, 401);

  const unavailableOverview = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/referrals/overview`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(unavailableOverview.statusCode, 503);
  assert.equal(unavailableOverview.json().errorCode, 'referral_store_unavailable');

  const unavailableHistory = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/referrals`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(unavailableHistory.statusCode, 503);
  await app.close();
});
