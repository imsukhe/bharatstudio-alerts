import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { PaymentAccount, PaymentAccountStore } from '../src/domain/payment-account.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const account: PaymentAccount = { schemaVersion: 'v1', accountId: '00000000-0000-4000-8000-000000000041', channelId, provider: 'razorpay', environment: 'test', connectedAccountRef: 'acct_pending_1', status: 'pending', createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z', revokedAt: null };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); }, async list() { return []; }, async revoke() { return false; },
};

test('payment-account onboarding is pending until provider activation', async () => {
  let current: PaymentAccount | null = null;
  const store: PaymentAccountStore = {
    async list() { return current ? [current] : []; },
    async register(_user, _channel, environment, ref) { current = { ...account, environment, connectedAccountRef: ref, status: 'pending' }; return current; },
    async revoke() { current = current ? { ...current, status: 'revoked', revokedAt: '2026-08-16T00:01:00.000Z' } : null; return Boolean(current); },
    async skipOnboarding() { return '2026-08-16T00:02:00.000Z'; },
  };
  const app = await buildApp(config, { sessions, paymentAccounts: store });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
  const registered = await app.inject({ method: 'PUT', url: `/v1/channels/${channelId}/payment-accounts/razorpay`, headers, payload: { environment: 'test', connectedAccountRef: 'acct_pending_2' } });
  assert.equal(registered.statusCode, 200);
  assert.equal(registered.json().status, 'pending');
  const listed = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/payment-accounts`, headers });
  assert.equal(listed.json().accounts[0].connectedAccountRef, 'acct_pending_2');
  const revoked = await app.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/payment-accounts/razorpay?environment=test`, headers });
  assert.equal(revoked.statusCode, 204);
  await app.close();
});

test('payment-account route rejects provider-looking secrets and unauthenticated callers', async () => {
  const app = await buildApp(config, { sessions, paymentAccounts: { async list() { return []; }, async register() { return account; }, async revoke() { return false; }, async skipOnboarding() { return '2026-08-16T00:00:00.000Z'; } } });
  const invalid = await app.inject({ method: 'PUT', url: `/v1/channels/${channelId}/payment-accounts/razorpay`, headers: { authorization: `Bearer ${'a'.repeat(48)}` }, payload: { environment: 'test', connectedAccountRef: 'acct value with spaces' } });
  assert.equal(invalid.statusCode, 400);
  const unauthorized = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/payment-accounts` });
  assert.equal(unauthorized.statusCode, 401);
  await app.close();
});

test('skipping payout onboarding is idempotent, returns the recorded time, and requires authentication', async () => {
  let skippedAt: string | null = null;
  const store: PaymentAccountStore = {
    async list() { return []; },
    async register() { throw new Error('not used'); },
    async revoke() { throw new Error('not used'); },
    async skipOnboarding() { skippedAt ??= '2026-08-16T00:03:00.000Z'; return skippedAt; },
  };
  const app = await buildApp(config, { sessions, paymentAccounts: store });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
  const first = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/payout-onboarding/skip`, headers });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().payoutOnboardingSkippedAt, '2026-08-16T00:03:00.000Z');
  const second = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/payout-onboarding/skip`, headers });
  assert.equal(second.json().payoutOnboardingSkippedAt, first.json().payoutOnboardingSkippedAt);
  const unauthorized = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/payout-onboarding/skip` });
  assert.equal(unauthorized.statusCode, 401);
  await app.close();
});

test('a skip attempt the store rejects (wrong role, unknown channel) surfaces as a safe 403, not a stack trace', async () => {
  const store: PaymentAccountStore = {
    async list() { return []; },
    async register() { throw new Error('not used'); },
    async revoke() { throw new Error('not used'); },
    async skipOnboarding() { throw new Error('invalid payout-onboarding skip'); },
  };
  const app = await buildApp(config, { sessions, paymentAccounts: store });
  const response = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/payout-onboarding/skip`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'payout_onboarding_skip_failed');
  assert.doesNotMatch(response.body, /invalid payout-onboarding skip/);
  await app.close();
});
