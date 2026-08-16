import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import type {
  CancelSubscriptionInput,
  ChangeSubscriptionPlanInput,
  PaymentSubscriptionService,
  ReactivateSubscriptionInput,
  SubscriptionLifecycleAction,
} from '../src/domain/payment-subscription.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const headers = { authorization: `Bearer ${'a'.repeat(48)}`, 'idempotency-key': 'lifecycle-idempotency-001' };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const acceptedAccount: AccountStore = {
  async listActiveDocuments() { return []; },
  async acceptDocument() { return true; },
  async hasAcceptedActiveDocuments() { return true; },
  async createPrivacyRequest() { throw new Error('not used'); },
  async listPrivacyRequests() { return []; },
  async exportAccount() { return {}; },
  async closeAccount() { return ''; },
};

function recordingService(calls: { action: SubscriptionLifecycleAction; input: unknown }[]): PaymentSubscriptionService {
  return {
    async createSubscription() { throw new Error('not used'); },
    async cancelSubscription(input: CancelSubscriptionInput) {
      calls.push({ action: 'cancel', input });
      return { schemaVersion: 'v1', action: 'cancel', requestId: 'req_1', status: 'provider_confirmed', replay: false };
    },
    async changeSubscriptionPlan(input: ChangeSubscriptionPlanInput, action) {
      calls.push({ action, input });
      return { schemaVersion: 'v1', action, requestId: 'req_2', status: 'provider_confirmed', replay: false };
    },
    async reactivateSubscription(input: ReactivateSubscriptionInput) {
      calls.push({ action: 'reactivate', input });
      return { schemaVersion: 'v1', action: 'reactivate', requestId: 'req_3', status: 'provider_confirmed', replay: false };
    },
  };
}

test('cancel/upgrade/downgrade/reactivate routes forward authenticated creator input and return the lifecycle projection', async () => {
  const calls: { action: SubscriptionLifecycleAction; input: unknown }[] = [];
  const app = await buildApp(config, { sessions, account: acceptedAccount, paymentSubscriptions: recordingService(calls) });

  const cancelled = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/subscription/cancel`, headers });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().action, 'cancel');

  const upgraded = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/subscription/upgrade`, headers, payload: { targetTier: 'studio', billingInterval: 'monthly' } });
  assert.equal(upgraded.statusCode, 200);
  assert.equal(upgraded.json().action, 'upgrade');

  const downgraded = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/subscription/downgrade`, headers, payload: { targetTier: 'pro', billingInterval: 'monthly' } });
  assert.equal(downgraded.statusCode, 200);
  assert.equal(downgraded.json().action, 'downgrade');

  const reactivated = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/subscription/reactivate`, headers });
  assert.equal(reactivated.statusCode, 200);
  assert.equal(reactivated.json().action, 'reactivate');

  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.action), ['cancel', 'upgrade', 'downgrade', 'reactivate']);
  for (const call of calls) {
    assert.equal((call.input as { userId: string }).userId, userId);
    assert.equal((call.input as { channelId: string }).channelId, channelId);
    assert.equal((call.input as { idempotencyKey: string }).idempotencyKey, 'lifecycle-idempotency-001');
  }
  await app.close();
});

test('lifecycle routes require a valid idempotency key and reject unknown tiers before dispatch', async () => {
  const calls: { action: SubscriptionLifecycleAction; input: unknown }[] = [];
  const app = await buildApp(config, { sessions, account: acceptedAccount, paymentSubscriptions: recordingService(calls) });

  const missingKey = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/subscription/cancel`, headers: { authorization: headers.authorization } });
  assert.equal(missingKey.statusCode, 400);
  assert.equal(missingKey.json().errorCode, 'invalid_idempotency_key');

  const invalidTier = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/subscription/upgrade`, headers, payload: { targetTier: 'enterprise', billingInterval: 'monthly' } });
  assert.equal(invalidTier.statusCode, 400);

  assert.equal(calls.length, 0);
  await app.close();
});

test('lifecycle routes reject unauthenticated callers and fail closed when the payment boundary is unavailable', async () => {
  const app = await buildApp(config, { sessions, account: acceptedAccount });
  const unauthorized = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/subscription/cancel` });
  assert.equal(unauthorized.statusCode, 401);

  const unavailable = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/subscription/cancel`, headers });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().errorCode, 'subscription_lifecycle_unavailable');
  await app.close();
});

test('lifecycle routes never leak provider failure detail and fail closed as 503', async () => {
  const leaky: PaymentSubscriptionService = {
    async createSubscription() { throw new Error('not used'); },
    async cancelSubscription() { throw new Error('razorpay_secret=super-secret rejected the request'); },
    async changeSubscriptionPlan() { throw new Error('not used'); },
    async reactivateSubscription() { throw new Error('not used'); },
  };
  const app = await buildApp(config, { sessions, account: acceptedAccount, paymentSubscriptions: leaky });
  const response = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/subscription/cancel`, headers });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'subscription_lifecycle_unavailable');
  assert.equal(JSON.stringify(response.json()).includes('razorpay_secret'), false);
  await app.close();
});
