import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerAlertRoutes } from '../src/routes/alerts.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import {
  PaymentMethodUpdateForbiddenError,
  type PaymentMethodUpdateLink,
  type PaymentMethodUpdateService,
  type RequestPaymentMethodUpdateLinkInput,
} from '../src/domain/billing-payment-method.js';

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const headers = { authorization: `Bearer ${'a'.repeat(48)}`, 'idempotency-key': 'payment-method-idempotency-001' };

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

// A route under test only, built directly against registerAlertRoutes
// (not buildApp/app.ts, which this task's lane does not own) so the new
// endpoint can be exercised without any other lane's wiring.
async function buildTestApp(paymentMethodUpdates?: PaymentMethodUpdateService) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  app.setErrorHandler(async (error, request, reply) => {
    const fastifyError = error as { validation?: unknown; statusCode?: number };
    if (fastifyError.validation) {
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'bad_request', message: 'Request validation failed', traceId: request.id });
    }
    return reply.code(500).send({ schemaVersion: 'v1', errorCode: 'internal_error', message: 'unexpected', traceId: request.id });
  });
  await registerAlertRoutes(app, sessions, undefined, undefined, 'test', acceptedAccount, paymentMethodUpdates);
  return app;
}

function fixedLinkService(calls: RequestPaymentMethodUpdateLinkInput[], link?: PaymentMethodUpdateLink): PaymentMethodUpdateService {
  return {
    async requestUpdateLink(input) {
      calls.push(input);
      return link ?? { schemaVersion: 'v1', provider: 'razorpay', updateUrl: 'https://rzp.io/i/update-abc123', expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
    },
  };
}

test('payment-method route returns an opaque short-lived provider-hosted link for an authenticated owner', async () => {
  const calls: RequestPaymentMethodUpdateLinkInput[] = [];
  const app = await buildTestApp(fixedLinkService(calls));
  const response = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/payment-method`, headers });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.provider, 'razorpay');
  const url = new URL(body.updateUrl);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.search, ''); // opaque: no mutable amount/plan/tier riding along as a query param
  const lifetimeMs = new Date(body.expiresAt).getTime() - Date.now();
  assert.ok(lifetimeMs > 0 && lifetimeMs <= 30 * 60 * 1000, 'link must be short-lived');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.userId, userId);
  assert.equal(calls[0]?.channelId, channelId);
  await app.close();
});

test('payment-method route rejects a caller without owner/admin channel role', async () => {
  const service: PaymentMethodUpdateService = {
    async requestUpdateLink() { throw new PaymentMethodUpdateForbiddenError(); },
  };
  const app = await buildTestApp(service);
  const response = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/payment-method`, headers });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'channel_role_required');
  await app.close();
});

test('payment-method route rejects unauthenticated callers and fails closed when unavailable', async () => {
  const app = await buildTestApp();
  const unauthorized = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/payment-method` });
  assert.equal(unauthorized.statusCode, 401);

  const unavailable = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/payment-method`, headers });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().errorCode, 'subscription_lifecycle_unavailable');
  await app.close();
});

test('payment-method route requires a valid idempotency key before dispatch', async () => {
  const calls: RequestPaymentMethodUpdateLinkInput[] = [];
  const app = await buildTestApp(fixedLinkService(calls));
  const response = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/payment-method`, headers: { authorization: headers.authorization } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'invalid_idempotency_key');
  assert.equal(calls.length, 0);
  await app.close();
});

test('payment-method route accepts no request body at all — any instrument-shaped field is rejected before the handler runs', async () => {
  const calls: RequestPaymentMethodUpdateLinkInput[] = [];
  const app = await buildTestApp(fixedLinkService(calls));
  const withCardNumber = await app.inject({
    method: 'POST',
    url: `/v1/channels/${channelId}/billing/payment-method`,
    headers,
    payload: { cardNumber: '4111111111111111', cvv: '123' },
  });
  assert.equal(withCardNumber.statusCode, 400);
  assert.equal(withCardNumber.json().errorCode, 'unexpected_request_body');

  const withUpiPin = await app.inject({
    method: 'POST',
    url: `/v1/channels/${channelId}/billing/payment-method`,
    headers,
    payload: { upiPin: '1234' },
  });
  assert.equal(withUpiPin.statusCode, 400);

  // Neither malformed request ever reached the service — no instrument
  // data was accepted, logged, or forwarded anywhere.
  assert.equal(calls.length, 0);
  await app.close();
});

test('payment-method route never leaks provider failure detail and fails closed as 503', async () => {
  const leaky: PaymentMethodUpdateService = {
    async requestUpdateLink() { throw new Error('razorpay_secret=super-secret rejected the request'); },
  };
  const app = await buildTestApp(leaky);
  const response = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/billing/payment-method`, headers });
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(response.json()), /razorpay_secret/);
  await app.close();
});
