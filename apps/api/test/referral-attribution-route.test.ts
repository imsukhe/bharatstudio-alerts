import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { ChannelDetails, ChannelStore } from '../src/domain/channel-store.js';
import type { ReferralAttributionResult, ReferralStore } from '../src/domain/referrals.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-000000000001';

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const createdChannel: ChannelDetails = {
  schemaVersion: 'v1', channelId: '00000000-0000-4000-8000-000000000011', handle: 'new_creator',
  displayName: 'New Creator', acceptingTips: true, publicConfigVersion: 1, featuredConsent: false,
};

function fakeChannels(): ChannelStore {
  return {
    async createChannel() { return createdChannel; },
    async getChannel() { return createdChannel; },
    async updateChannel() { return createdChannel; },
    async getConfig() { throw new Error('not used'); },
    async updateConfig() { throw new Error('not used'); },
    async listQueues() { throw new Error('not used'); },
    async createQueue() { throw new Error('not used'); },
    async updateQueue() { throw new Error('not used'); },
    async listBindings() { throw new Error('not used'); },
    async createBinding() { throw new Error('not used'); },
    async updateBinding() { throw new Error('not used'); },
  };
}

function fakeReferrals(result: ReferralAttributionResult | Error): ReferralStore & { calls: { referredChannelId: string; referrerHandle: string; ipSubnetHash: string | null }[] } {
  const calls: { referredChannelId: string; referrerHandle: string; ipSubnetHash: string | null }[] = [];
  return {
    calls,
    async getOverview() { throw new Error('not used'); },
    async listHistory() { throw new Error('not used'); },
    async attribute(referredChannelId, referrerHandle, ipSubnetHash) {
      calls.push({ referredChannelId, referrerHandle, ipSubnetHash });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test('a referral code on channel creation is attributed after the channel is committed', async () => {
  const referrals = fakeReferrals('attributed');
  const app = await buildApp(config, { sessions, channels: fakeChannels(), referrals });
  const response = await app.inject({
    method: 'POST', url: '/v1/channels',
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: { handle: 'new_creator', displayName: 'New Creator', referralCode: 'referrer010' },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), createdChannel);
  assert.equal(referrals.calls.length, 1);
  assert.equal(referrals.calls[0]?.referredChannelId, createdChannel.channelId);
  assert.equal(referrals.calls[0]?.referrerHandle, 'referrer010');
  await app.close();
});

test('channel creation succeeds with no referralCode and never calls the referral store', async () => {
  const referrals = fakeReferrals('attributed');
  const app = await buildApp(config, { sessions, channels: fakeChannels(), referrals });
  const response = await app.inject({
    method: 'POST', url: '/v1/channels',
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: { handle: 'new_creator', displayName: 'New Creator' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(referrals.calls.length, 0);
  await app.close();
});

test('a referral attribution failure never fails the channel-creation request', async () => {
  const referrals = fakeReferrals(new Error('referral store outage'));
  const app = await buildApp(config, { sessions, channels: fakeChannels(), referrals });
  const response = await app.inject({
    method: 'POST', url: '/v1/channels',
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: { handle: 'new_creator', displayName: 'New Creator', referralCode: 'referrer010' },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), createdChannel);
  await app.close();
});

test('a bad or self-referral code still returns 201 — attribution outcomes are reported, not rejected', async () => {
  const referrals = fakeReferrals('unknown_referrer_code');
  const app = await buildApp(config, { sessions, channels: fakeChannels(), referrals });
  const response = await app.inject({
    method: 'POST', url: '/v1/channels',
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: { handle: 'new_creator', displayName: 'New Creator', referralCode: 'not-a-real-code' },
  });
  assert.equal(response.statusCode, 201);
  await app.close();
});
