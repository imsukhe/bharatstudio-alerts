import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import type { PublicChannelRepository } from '../src/domain/public-channel.js';
import type { GoogleIdentityVerifier } from '../src/auth/google.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AlertStore } from '../src/domain/alert-store.js';
import type { OverlayStore } from '../src/domain/overlay-store.js';
import type { ChannelStore } from '../src/domain/channel-store.js';
import type { PaymentOrderService } from '../src/domain/payment-order.js';
import type { PaymentSubscriptionService } from '../src/domain/payment-subscription.js';
import { createGooglePaymentOrderService } from '../src/db/payment-order-client.js';
import { createGooglePaymentSubscriptionService } from '../src/db/payment-subscription-client.js';
import type { IdTokenClient } from 'google-auth-library';
import type { MaintenanceStore } from '../src/domain/maintenance.js';

const config: RuntimeConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 4100,
  appOrigin: 'http://localhost:3100',
  paymentEnvironment: 'live',
};

test('staging and production reject using the pooled app endpoint as the direct listener endpoint', () => {
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://alerts.example',
    DATABASE_URL_APP: 'postgres://same',
    DATABASE_URL_DIRECT: 'postgres://same',
    GOOGLE_CLIENT_ID: 'client',
    PAYMENT_SERVICE_ORIGIN: 'https://payment.example',
    PAYMENT_SERVICE_AUDIENCE: 'payment',
    INTERNAL_SERVICE_AUDIENCES: 'worker',
  }), /separate direct database endpoint/);

  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://alerts.example',
    DATABASE_URL_APP: 'postgres://app.example/db',
    DATABASE_URL_DIRECT: 'postgres://ep-example-pooler.c-123.aws.neon.tech/db',
    GOOGLE_CLIENT_ID: 'client',
    PAYMENT_SERVICE_ORIGIN: 'https://payment.example',
    PAYMENT_SERVICE_AUDIENCE: 'payment',
    INTERNAL_SERVICE_AUDIENCES: 'worker',
  }), /non-pooled database endpoint/);

  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://alerts.example',
    DATABASE_URL_APP: 'https://not-postgres.example/db',
    DATABASE_URL_DIRECT: 'postgres://direct.example/db',
    GOOGLE_CLIENT_ID: 'client',
    PAYMENT_SERVICE_ORIGIN: 'https://payment.example',
    PAYMENT_SERVICE_AUDIENCE: 'payment',
    INTERNAL_SERVICE_AUDIENCES: 'worker',
  }), /DATABASE_URL_APP must be a PostgreSQL URL/);

  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://alerts.example',
    DATABASE_URL_APP: 'postgres://app.example/db',
    DATABASE_URL_DIRECT: 'postgres://direct.example/db',
    GOOGLE_CLIENT_ID: 'client',
    PAYMENT_SERVICE_ORIGIN: 'https://payment.example',
    PAYMENT_SERVICE_AUDIENCE: 'payment',
    INTERNAL_SERVICE_AUDIENCES: 'worker',
    NOTIFICATION_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
    PUBLIC_PAYMENT_TURNSTILE_REQUIRED: 'false',
  }), /cannot be disabled in production/);
});

test('health endpoint is available without exposing runtime details', async () => {
  const app = await buildApp(config);
  const response = await app.inject({ method: 'GET', url: '/healthz' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: 'ok',
    service: 'bharatstudio-alerts-api',
  });
  await app.close();
});

test('API request burst is bounded by the global rate limiter', async () => {
  const app = await buildApp(config);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      remoteAddress: '203.0.113.10',
    });
    assert.equal(response.statusCode, 200);
  }

  const limited = await app.inject({
    method: 'GET',
    url: '/healthz',
    remoteAddress: '203.0.113.10',
  });
  assert.equal(limited.statusCode, 429);
  assert.match(String(limited.headers['retry-after'] ?? ''), /^\d+$/);
  await app.close();
});

test('security headers and credentialed CORS are limited to the configured app origin', async () => {
  const app = await buildApp(config);
  const allowed = await app.inject({
    method: 'GET',
    url: '/healthz',
    headers: { origin: config.appOrigin },
  });
  assert.equal(allowed.headers['x-content-type-options'], 'nosniff');
  assert.equal(allowed.headers['access-control-allow-origin'], config.appOrigin);
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');

  const denied = await app.inject({
    method: 'GET',
    url: '/healthz',
    headers: { origin: 'https://unapproved.example' },
  });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  assert.equal(denied.headers['access-control-allow-credentials'], undefined);
  await app.close();
});

test('readiness does not claim unconfigured dependencies are ready', async () => {
  const app = await buildApp(config);
  const response = await app.inject({ method: 'GET', url: '/readyz' });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, 'not_ready');
  await app.close();
});

test('readiness reports ready only after the configured dependency probe succeeds', async () => {
  const ready = await buildApp(config, { readiness: async () => true });
  const response = await ready.inject({ method: 'GET', url: '/readyz' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ready' });
  await ready.close();

  const unavailable = await buildApp(config, { readiness: async () => false });
  const unavailableResponse = await unavailable.inject({ method: 'GET', url: '/readyz' });
  assert.equal(unavailableResponse.statusCode, 503);
  assert.equal(unavailableResponse.json().reason, 'runtime_dependency_unavailable');
  await unavailable.close();
});

test('unknown routes use the versioned error envelope', async () => {
  const app = await buildApp(config);
  const response = await app.inject({ method: 'GET', url: '/v1/not-implemented' });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().schemaVersion, 'v1');
  assert.equal(response.json().errorCode, 'not_found');
  assert.match(response.json().traceId, /^req-/);
  await app.close();
});

test('public channel response contains only approved projection fields', async () => {
  const repository: PublicChannelRepository = {
    async findByHandle(handle) {
      if (handle.toLowerCase() !== 'demo_creator') return null;
      return {
        channelId: '00000000-0000-4000-8000-000000000011',
        handle: 'demo_creator',
        displayName: 'Demo Creator',
        acceptingTips: true,
        minimumTipPaise: 1000,
        publicConfigVersion: 2,
      };
    },
    async listFeatured() { return []; },
  };
  const app = await buildApp(config, { publicChannels: repository });
  const response = await app.inject({ method: 'GET', url: '/v1/public/channels/demo_creator' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    channelId: '00000000-0000-4000-8000-000000000011',
    handle: 'demo_creator',
    displayName: 'Demo Creator',
    acceptingTips: true,
    minimumTipPaise: 1000,
    publicConfigVersion: 2,
  });
  assert.equal('ownerUserId' in response.json(), false);
  await app.close();
});

test('public channel route fails closed without its repository', async () => {
  const app = await buildApp(config);
  const response = await app.inject({ method: 'GET', url: '/v1/public/channels/demo_creator' });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'public_read_unavailable');
  await app.close();
});

test('the featured-creator listing exposes only the approved narrow projection', async () => {
  let seenLimit: number | undefined;
  const repository: PublicChannelRepository = {
    async findByHandle() { return null; },
    async listFeatured(limit) {
      seenLimit = limit;
      return [{ handle: 'featured_creator', displayName: 'Featured Creator', acceptingTips: true, locale: 'hi-IN' }];
    },
  };
  const app = await buildApp(config, { publicChannels: repository });
  const response = await app.inject({ method: 'GET', url: '/v1/public/featured' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', creators: [{ handle: 'featured_creator', displayName: 'Featured Creator', acceptingTips: true, locale: 'hi-IN' }] });
  assert.equal('channelId' in response.json().creators[0], false);
  assert.equal(seenLimit, 60);
  await app.close();
});

test('the featured-creator listing accepts a bounded limit and fails closed without its repository', async () => {
  const repository: PublicChannelRepository = {
    async findByHandle() { return null; },
    async listFeatured(limit) { return limit === 5 ? [] : [{ handle: 'wrong', displayName: 'Wrong', acceptingTips: true, locale: 'en-IN' }]; },
  };
  const app = await buildApp(config, { publicChannels: repository });
  const bounded = await app.inject({ method: 'GET', url: '/v1/public/featured?limit=5' });
  assert.equal(bounded.statusCode, 200);
  assert.deepEqual(bounded.json().creators, []);
  const oversized = await app.inject({ method: 'GET', url: '/v1/public/featured?limit=500' });
  assert.equal(oversized.statusCode, 400);
  await app.close();

  const unavailableApp = await buildApp(config);
  const unavailable = await unavailableApp.inject({ method: 'GET', url: '/v1/public/featured' });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().errorCode, 'public_read_unavailable');
  await unavailableApp.close();
});

test('invalid public handles return a bounded error envelope', async () => {
  const app = await buildApp(config, {
    publicChannels: { findByHandle: async () => null, listFeatured: async () => [] },
  });
  const response = await app.inject({ method: 'GET', url: '/v1/public/channels/bad%20handle' });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'bad_request');
  assert.equal(response.json().message, 'Request validation failed');
  await app.close();
});

test('malformed JSON returns a bounded client error without parser details', async () => {
  const app = await buildApp(config);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'content-type': 'application/json' },
    payload: '{"amountPaise":',
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json().errorCode, 'bad_request');
  assert.equal(response.json().message, 'Request body is invalid JSON');
  assert.doesNotMatch(response.body, /Unexpected end|JSON.parse|stack/i);
  await app.close();
});

test('oversized JSON returns 413 instead of an internal error', async () => {
  const app = await buildApp(config);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ message: 'x'.repeat(70_000) }),
  });

  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json().errorCode, 'request_too_large');
  assert.equal(response.json().message, 'Request is too large');
  assert.doesNotMatch(response.body, /70,000|Unexpected|stack/i);
  await app.close();
});

test('public tip order requires the reviewed payment boundary and forwards canonical channel context', async () => {
  const repository: PublicChannelRepository = {
    async findByHandle(handle) {
      return handle === 'demo_creator' ? {
        channelId: '00000000-0000-4000-8000-000000000011',
        handle,
        displayName: 'Demo Creator',
        acceptingTips: true,
        minimumTipPaise: 1000,
        publicConfigVersion: 2,
      } : null;
    },
    async listFeatured() { return []; },
  };
  let received: Record<string, unknown> | undefined;
  const paymentOrders: PaymentOrderService = {
    async createTipOrder(input) {
      received = input;
      return { schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000091', provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: input.amountPaise, currency: 'INR', status: 'created' };
    },
  };
  const app = await buildApp(config, { publicChannels: repository, paymentOrders });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-001' },
    payload: { amountPaise: 1000, currency: 'INR', donorDisplayName: 'Viewer', message: 'Hello', alertConsent: false },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().providerOrderId, 'order_synthetic');
  assert.equal(received?.channelId, '00000000-0000-4000-8000-000000000011');
  assert.equal(received?.environment, 'live');
  assert.match(String(received?.providerReceipt), /^bsa_[a-f0-9]{32}$/);
  assert.equal(received?.alertConsent, false);
  await app.close();
});

test('public tip order fails closed when the payment boundary is not wired', async () => {
  const app = await buildApp(config, {
    publicChannels: { findByHandle: async () => ({ channelId: '00000000-0000-4000-8000-000000000011', handle: 'demo_creator', displayName: 'Demo Creator', acceptingTips: true, minimumTipPaise: 1000, publicConfigVersion: 1 }), listFeatured: async () => [] },
  });
  const response = await app.inject({ method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders', headers: { 'idempotency-key': 'synthetic-idempotency-001' }, payload: { amountPaise: 1000, currency: 'INR' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'payment_unavailable');
  await app.close();
});

test('public tip order rejects malformed idempotency keys before payment dispatch', async () => {
  let paymentCalled = false;
  const app = await buildApp(config, {
    publicChannels: { findByHandle: async () => ({ channelId: '00000000-0000-4000-8000-000000000011', handle: 'demo_creator', displayName: 'Demo Creator', acceptingTips: true, minimumTipPaise: 1000, publicConfigVersion: 1 }), listFeatured: async () => [] },
    paymentOrders: {
      async createTipOrder() {
        paymentCalled = true;
        throw new Error('must not be called');
      },
    },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'invalid key with spaces' },
    payload: { amountPaise: 1000, currency: 'INR' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'bad_request');
  assert.equal(paymentCalled, false);
  await app.close();
});

test('public payment status exposes only server-confirmed donor-safe state', async () => {
  const orderId = '00000000-0000-4000-8000-000000000091';
  const app = await buildApp(config, {
    publicPaymentStatus: {
      async findByOrderId(value) {
        return value === orderId ? { orderId, status: 'paid', amountPaise: 2500, currency: 'INR', updatedAt: '2026-08-15T10:00:00.000Z' } : null;
      },
    },
  });
  const response = await app.inject({ method: 'GET', url: `/v1/public/tip-orders/${orderId}/status` });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', orderId, status: 'paid', amountPaise: 2500, currency: 'INR', updatedAt: '2026-08-15T10:00:00.000Z' });
  assert.equal('providerOrderId' in response.json(), false);
  assert.equal('message' in response.json(), false);
  await app.close();
});

test('authenticated subscription route forwards only approved creator inputs to the private payment boundary', async () => {
  let received: Record<string, unknown> | undefined;
  const paymentSubscriptions: PaymentSubscriptionService = {
    async createSubscription(input) {
      received = input;
      return {
        schemaVersion: 'v1', provider: 'razorpay', status: 'linked',
        subscriptionId: 'sub_synthetic', tier: input.tier,
        billingInterval: input.billingInterval, monthlyPricePaise: 39900,
        annualChargePaise: 399000, annualMonthsCharged: 10, annualServiceMonths: 12,
        checkoutUrl: 'https://rzp.io/i/synthetic',
      };
    },
    async cancelSubscription() {
      return { schemaVersion: 'v1', action: 'cancel', requestId: 'req_synthetic', status: 'provider_confirmed', replay: false };
    },
    async changeSubscriptionPlan(_input, action) {
      return { schemaVersion: 'v1', action, requestId: 'req_synthetic', status: 'provider_confirmed', replay: false };
    },
    async reactivateSubscription() {
      return { schemaVersion: 'v1', action: 'reactivate', requestId: 'req_synthetic', status: 'provider_confirmed', replay: false };
    },
  };
  const app = await buildApp(config, { sessions: fakeSessions(), paymentSubscriptions });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/channels/00000000-0000-4000-8000-000000000011/billing/subscription',
    headers: { authorization: `Bearer ${'a'.repeat(48)}`, 'idempotency-key': 'subscription-idempotency-001' },
    payload: { tier: 'creator', billingInterval: 'monthly' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().subscriptionId, 'sub_synthetic');
  assert.deepEqual(received, {
    userId: '00000000-0000-4000-8000-000000000001',
    channelId: '00000000-0000-4000-8000-000000000011',
    environment: 'live', idempotencyKey: 'subscription-idempotency-001',
    tier: 'creator', billingInterval: 'monthly',
  });
  await app.close();
});

test('public payment status returns not found without revealing order data', async () => {
  const app = await buildApp(config, { publicPaymentStatus: { async findByOrderId() { return null; } } });
  const response = await app.inject({ method: 'GET', url: '/v1/public/tip-orders/00000000-0000-4000-8000-000000000092/status' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().errorCode, 'not_found');
  assert.equal('providerOrderId' in response.json(), false);
  await app.close();
});

test('public tip order rejects an amount below the channel-configured minimum before payment service use', async () => {
  let paymentCalled = false;
  const app = await buildApp(config, {
    publicChannels: { findByHandle: async () => ({ channelId: '00000000-0000-4000-8000-000000000011', handle: 'demo_creator', displayName: 'Demo Creator', acceptingTips: true, minimumTipPaise: 2500, publicConfigVersion: 3 }), listFeatured: async () => [] },
    paymentOrders: { async createTipOrder() { paymentCalled = true; throw new Error('must not be called'); } },
  });
  const response = await app.inject({ method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders', headers: { 'idempotency-key': 'synthetic-idempotency-002' }, payload: { amountPaise: 1000, currency: 'INR' } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'tip_below_channel_minimum');
  assert.match(response.json().message, /₹25/);
  assert.equal(paymentCalled, false);
  await app.close();
});

test('production public payment boundary requires a successful Turnstile verification', async () => {
  const repository: PublicChannelRepository = {
    async findByHandle() {
      return { channelId: '00000000-0000-4000-8000-000000000011', handle: 'demo_creator', displayName: 'Demo Creator', acceptingTips: true, minimumTipPaise: 1000, publicConfigVersion: 1 };
    },
    async listFeatured() { return []; },
  };
  const paymentOrders: PaymentOrderService = {
    async createTipOrder(input) {
      return { schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000091', provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: input.amountPaise, currency: 'INR', status: 'created' };
    },
  };
  const protectedConfig = { ...config, publicPaymentTurnstileRequired: true };
  const blocked = await buildApp(protectedConfig, { publicChannels: repository, paymentOrders, publicAbuseGuard: { verify: async () => false } });
  const blockedResponse = await blocked.inject({ method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders', headers: { 'idempotency-key': 'synthetic-turnstile-001' }, payload: { amountPaise: 1000, currency: 'INR', turnstileToken: 'bad' } });
  assert.equal(blockedResponse.statusCode, 403);
  assert.equal(blockedResponse.json().errorCode, 'bot_verification_required');
  await blocked.close();

  const allowed = await buildApp(protectedConfig, { publicChannels: repository, paymentOrders, publicAbuseGuard: { verify: async (token, ip) => token === 'good' && ip === '127.0.0.1' } });
  const allowedResponse = await allowed.inject({ method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders', headers: { 'idempotency-key': 'synthetic-turnstile-002' }, payload: { amountPaise: 1000, currency: 'INR', turnstileToken: 'good' } });
  assert.equal(allowedResponse.statusCode, 201);
  await allowed.close();
});

test('payment service client validates the internal order response before returning it', async () => {
  let requestUrl = '';
  const fakeClient = {} as IdTokenClient;
  const service = createGooglePaymentOrderService('http://127.0.0.1:4400', 'audience', 'test', async (_client, url, body, traceId) => {
    requestUrl = url;
    assert.equal(body.currency, 'INR');
    assert.equal(traceId, 'api-request');
    return { schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000091', provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: body.amountPaise, currency: 'INR', status: 'created' };
  }, async () => fakeClient);
  const input = { channelId: '00000000-0000-4000-8000-000000000011', environment: 'test' as const, idempotencyKey: 'synthetic-idempotency-001', intentId: '00000000-0000-4000-8000-000000000091', providerReceipt: 'bsa_receipt', amountPaise: 1000, currency: 'INR' as const, donorDisplayName: 'Viewer', message: '', alertConsent: true, expiresAt: '2099-08-14T10:00:00Z' };
  const result = await service.createTipOrder(input);
  assert.equal(requestUrl, 'http://127.0.0.1:4400/internal/v1/tips/orders');
  assert.equal(result.providerOrderId, 'order_synthetic');

  const malformedService = createGooglePaymentOrderService('http://127.0.0.1:4400', 'audience', 'test', async () => ({
    schemaVersion: 'v1', orderId: 'not-a-uuid', provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: input.amountPaise, currency: 'INR', status: 'created', unexpected: true,
  }), async () => fakeClient);
  await assert.rejects(() => malformedService.createTipOrder(input), /invalid payment service response/);
});

test('payment subscription client sends only the private route contract and validates annual pricing fields', async () => {
  let requestUrl = '';
  const fakeClient = {} as IdTokenClient;
  const service = createGooglePaymentSubscriptionService('http://127.0.0.1:4400', 'audience', 'test', async (_client, url, body, traceId) => {
    requestUrl = url;
    assert.equal(body.tier, 'creator');
    assert.equal(body.billingInterval, 'annual');
    assert.equal(traceId, 'subscription-request');
    return {
      schemaVersion: 'v1', provider: 'razorpay', status: 'linked', subscriptionId: 'sub_synthetic',
      tier: 'creator', billingInterval: 'annual', monthlyPricePaise: 39900,
      annualChargePaise: 399000, annualMonthsCharged: 10, annualServiceMonths: 12,
      checkoutUrl: 'https://rzp.io/i/synthetic',
    };
  }, async () => fakeClient);
  const result = await service.createSubscription({
    userId: '00000000-0000-4000-8000-000000000001',
    channelId: '00000000-0000-4000-8000-000000000011', environment: 'test',
    idempotencyKey: 'subscription-idempotency-001', tier: 'creator', billingInterval: 'annual',
  }, 'subscription-request');
  assert.equal(requestUrl, 'http://127.0.0.1:4400/internal/v1/subscriptions');
  assert.equal(result.annualChargePaise, 399000);

  const malformedService = createGooglePaymentSubscriptionService('http://127.0.0.1:4400', 'audience', 'test', async () => ({
    schemaVersion: 'v1', provider: 'razorpay', status: 'linked', subscriptionId: 'sub_synthetic',
    tier: 'creator', billingInterval: 'annual', monthlyPricePaise: 39900.5,
    annualChargePaise: 399005, annualMonthsCharged: 10, annualServiceMonths: 12,
    checkoutUrl: 'http://unsafe.example/checkout',
  }), async () => fakeClient);
  await assert.rejects(() => malformedService.createSubscription({
    userId: '00000000-0000-4000-8000-000000000001',
    channelId: '00000000-0000-4000-8000-000000000011', environment: 'test',
    idempotencyKey: 'subscription-idempotency-001', tier: 'creator', billingInterval: 'annual',
  }), /invalid payment service response/);
});

test('payment subscription lifecycle client posts to the dedicated internal route and validates the response', async () => {
  const fakeClient = {} as IdTokenClient;
  const seenBodies: Record<string, unknown>[] = [];
  const service = createGooglePaymentSubscriptionService(
    'http://127.0.0.1:4400', 'audience', 'test',
    async () => { throw new Error('createSubscription transport must not be used for lifecycle calls'); },
    async () => fakeClient,
    async (_client, url, body, traceId) => {
      assert.equal(url, 'http://127.0.0.1:4400/internal/v1/subscriptions/lifecycle');
      assert.equal(traceId, 'lifecycle-request');
      seenBodies.push(body as Record<string, unknown>);
      return { schemaVersion: 'v1', action: body.action, requestId: 'req_synthetic', status: 'provider_confirmed', replay: false };
    },
  );
  const input = { userId: '00000000-0000-4000-8000-000000000001', channelId: '00000000-0000-4000-8000-000000000011', environment: 'test' as const, idempotencyKey: 'lifecycle-idempotency-001' };

  const cancelled = await service.cancelSubscription(input, 'lifecycle-request');
  assert.equal(cancelled.action, 'cancel');
  assert.equal(seenBodies.at(0)?.action, 'cancel');

  const upgraded = await service.changeSubscriptionPlan({ ...input, targetTier: 'studio', billingInterval: 'monthly' }, 'upgrade', 'lifecycle-request');
  assert.equal(upgraded.action, 'upgrade');
  assert.equal(seenBodies.at(1)?.targetTier, 'studio');

  const reactivated = await service.reactivateSubscription(input, 'lifecycle-request');
  assert.equal(reactivated.action, 'reactivate');
  assert.equal(seenBodies.at(2)?.action, 'reactivate');

  const malformedService = createGooglePaymentSubscriptionService(
    'http://127.0.0.1:4400', 'audience', 'test',
    async () => { throw new Error('unused'); },
    async () => fakeClient,
    async () => ({ schemaVersion: 'v1', action: 'cancel', requestId: 'req_synthetic', status: 'unknown_status', replay: false }),
  );
  await assert.rejects(() => malformedService.cancelSubscription(input), /invalid payment service response/);
});

test('maintenance routes require service identity and remain fail-closed without a transactional store', async () => {
  const identity = { verify: async (authorization?: string) => authorization === 'Bearer synthetic-internal-token' };
  const app = await buildApp(config, { serviceIdentity: identity });
  const unauthorized = await app.inject({ method: 'POST', url: '/internal/maintenance/outbox-recover', payload: { idempotencyKey: 'synthetic-job-001' } });
  const unavailable = await app.inject({ method: 'POST', url: '/internal/maintenance/outbox-recover', headers: { authorization: 'Bearer synthetic-internal-token' }, payload: { idempotencyKey: 'synthetic-job-001' } });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unavailable.statusCode, 503);
  await app.close();
});

test('maintenance route forwards an idempotent job to its store only after identity verification', async () => {
  let received: unknown;
  const store: MaintenanceStore = { async execute(request) { received = request; return { schemaVersion: 'v1', job: request.job, status: 'accepted', runId: '00000000-0000-4000-8000-000000000099' }; } };
  const app = await buildApp(config, { serviceIdentity: { verify: async () => true }, maintenance: store });
  const response = await app.inject({ method: 'POST', url: '/internal/maintenance/overlay-sessions', headers: { authorization: 'Bearer synthetic-internal-token' }, payload: { idempotencyKey: 'synthetic-job-001', window: '2026-08-14T10:00Z' } });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(received, { job: 'overlay-sessions', idempotencyKey: 'synthetic-job-001', window: '2026-08-14T10:00Z' });
  await app.close();
});

test('maintenance API rejects jobs owned by the payment or worker service', async () => {
  let called = false;
  const store: MaintenanceStore = { async execute() { called = true; throw new Error('must not be called'); } };
  const app = await buildApp(config, { serviceIdentity: { verify: async () => true }, maintenance: store });
  const response = await app.inject({ method: 'POST', url: '/internal/maintenance/outbox-recover', headers: { authorization: 'Bearer synthetic-internal-token' }, payload: { idempotencyKey: 'synthetic-job-002' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'maintenance_unavailable');
  assert.equal(called, false);
  await app.close();
});

test('metrics are internal, normalized and free of request identifiers', async () => {
  const app = await buildApp(config, {
    serviceIdentity: { verify: async (authorization?: string) => authorization === 'Bearer synthetic-internal-token' },
    overlayWakeup: { async wait() {}, async close() {}, health: () => ({ connected: true, reconnects: 2, failures: 1 }) },
  });
  const unauthorized = await app.inject({ method: 'GET', url: '/internal/metrics' });
  assert.equal(unauthorized.statusCode, 401);
  await app.inject({ method: 'GET', url: '/healthz?userId=secret-user-id', headers: { authorization: 'Bearer synthetic-internal-token' } });
  const response = await app.inject({ method: 'GET', url: '/internal/metrics', headers: { authorization: 'Bearer synthetic-internal-token' } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /bsa_api_requests_total/);
  assert.match(response.body, /route="\/healthz"/);
  assert.match(response.body, /bsa_overlay_listener_connected 1/);
  assert.match(response.body, /bsa_overlay_listener_reconnects_total 2/);
  assert.match(response.body, /bsa_overlay_listener_failures_total 1/);
  assert.doesNotMatch(response.body, /secret-user-id/);
  assert.doesNotMatch(response.body, /authorization/);
  await app.close();
});

function fakeSessions(): SessionStore {
  return {
    async create() {
      return {
        accessToken: 'a'.repeat(48),
        principal: {
          sessionId: '00000000-0000-4000-8000-000000000041',
          userId: '00000000-0000-4000-8000-000000000001',
          expiresAt: '2026-09-13T10:00:00Z',
        },
      };
    },
    async lookup(token) {
      return token === 'a'.repeat(48)
        ? { sessionId: '00000000-0000-4000-8000-000000000041', userId: '00000000-0000-4000-8000-000000000001', expiresAt: '2026-09-13T10:00:00Z' }
        : null;
    },
    async getCurrentUser(userId) {
      return { schemaVersion: 'v1', userId, displayName: 'Synthetic Creator', channels: [] };
    },
    async list() {
      return [{ sessionId: '00000000-0000-4000-8000-000000000041', createdAt: '2026-08-14T10:00:00Z', lastSeenAt: '2026-08-14T10:00:00Z', current: false, deviceLabel: 'Test device' }];
    },
    async revoke() { return true; },
  };
}

function fakeAlerts(): AlertStore {
  return {
    async createTestAlert(_userId, channelId, displayName, message) {
      return { schemaVersion: 'v1', eventId: '00000000-0000-4000-8000-000000000051', traceId: `test-${channelId}`, status: 'accepted' };
    },
    async listHistory() {
      return {
        items: [{ eventId: '00000000-0000-4000-8000-000000000051', sourceType: 'manual', status: 'accepted', createdAt: '2026-08-14T10:00:00.000Z', grossAmountPaise: null, currency: null, displayName: 'Synthetic Viewer', message: 'Hello' }],
        nextCursor: '2026-08-14T10:00:00.000Z',
      };
    },
    async moderate(_userId, _channelId, eventId, action, reason) {
      return { eventId, action, appliedAt: '2026-08-14T10:00:01.000Z', ...(reason ? {} : {}) };
    },
    async getBilling(_userId, channelId) {
      return {
        schemaVersion: 'v1', channelId, tier: 'creator', monthlyPricePaise: 39900,
        annualMonthsCharged: 10, annualServiceMonths: 12, renewalState: 'not_applicable',
        nextRenewalAt: null, billingInterval: 'monthly', autoRenew: false,
        currentPeriodEndsAt: null, priceProtectedUntil: null, priceSource: 'current',
      };
    },
    async getEntitlements(_userId, channelId) {
      return { schemaVersion: 'v1', channelId, tier: 'creator', source: 'individual_plan', entitlementVersion: 4, values: { queueCount: 16, lottieEnabled: true } };
    },
    async getCompanionState(_userId, channelId) {
      return { schemaVersion: 'v1', channelId, overlayConnected: true, pendingAlerts: 2, lastUpdatedAt: '2026-08-14T10:00:00.000Z' };
    },
    async getCompanionLayout(_userId, channelId) {
      return { schemaVersion: 'v1', channelId, version: 0, tier: 'creator', maxSlots: 32, pageSize: 16, slots: [], createdAt: null };
    },
    async updateCompanionLayout(_userId, channelId, _expectedVersion, pageSize, slots) {
      return { schemaVersion: 'v1', channelId, version: 1, tier: 'creator', maxSlots: 32, pageSize, slots, createdAt: '2026-08-14T10:00:03.000Z' };
    },
    async acquireCompanionControlSession(_userId, channelId, clientType, clientInstanceId) {
      return { schemaVersion: 'v1', sessionId: '00000000-0000-4000-8000-000000000401', channelId, clientType, clientInstanceId, leaseUntil: '2026-08-14T10:05:00.000Z', createdAt: '2026-08-14T10:00:00.000Z', reused: false };
    },
    async revokeCompanionControlSession() { return true; },
    async executeCompanionAction(_userId, channelId, action, targetId, idempotencyKey) {
      return { schemaVersion: 'v1', commandId: `command-${idempotencyKey}-${channelId}-${targetId ?? 'none'}`, status: 'accepted', acceptedAt: '2026-08-14T10:00:02.000Z' };
    },
  };
}

function fakeOverlays(): OverlayStore {
  return {
    async create(_userId, _channelId) {
      return { schemaVersion: 'v1', overlayId: '00000000-0000-4000-8000-000000000061', expiresAt: '2026-08-21T10:00:00.000Z', streamUrl: 'https://web.example.test/overlay/00000000-0000-4000-8000-000000000061#token=synthetic' };
    },
    async revoke(_userId, overlayId) { return overlayId === '00000000-0000-4000-8000-000000000061'; },
    async rotate(_userId, overlayId) {
      return overlayId === '00000000-0000-4000-8000-000000000061'
        ? { schemaVersion: 'v1', overlayId: '00000000-0000-4000-8000-000000000062', expiresAt: '2026-08-21T10:00:00.000Z', streamUrl: 'https://web.example.test/overlay/00000000-0000-4000-8000-000000000062#token=synthetic' }
        : null;
    },
    async replay(_token, overlayId, lastEventId) {
      if (lastEventId === 'bad-cursor') throw new Error('invalid_cursor');
      return overlayId === '00000000-0000-4000-8000-000000000061' && !lastEventId
        ? [{ schemaVersion: 'v1', cursor: '2026-08-14T10:00:00.000000Z|00000000-0000-4000-8000-000000000071', eventId: '00000000-0000-4000-8000-000000000051', eventType: 'alert.ready', traceId: 'synthetic', createdAt: '2026-08-14T10:00:00.000Z', payload: { message: 'Hello' } }]
        : null;
    },
    async acknowledge(_token, overlayId) { return overlayId === '00000000-0000-4000-8000-000000000061'; },
  };
}

function fakeChannels(): ChannelStore {
  const channel = { schemaVersion: 'v1' as const, channelId: '00000000-0000-4000-8000-000000000011', handle: 'synthetic_a', displayName: 'Synthetic A', acceptingTips: true, publicConfigVersion: 1, featuredConsent: false, role: 'owner' };
  const queue = { schemaVersion: 'v1' as const, queueId: '00000000-0000-4000-8000-000000000021', channelId: channel.channelId, name: 'Main', paused: false, active: true };
  return {
    async createChannel() { return channel; },
    async getChannel() { return channel; },
    async updateChannel(_userId, _channelId, input) { return { ...channel, ...input }; },
    async getConfig(_userId, channelId) { return { schemaVersion: 'v1', channelId, version: 1, values: {}, effectiveAt: '2026-08-14T10:00:00.000Z' }; },
    async updateConfig(_userId, channelId, values, expectedVersion) { return expectedVersion === 1 ? { schemaVersion: 'v1', channelId, version: 2, values, effectiveAt: '2026-08-14T10:00:00.000Z' } : null; },
    async listQueues() { return [queue]; },
    async createQueue() { return queue; },
    async updateQueue() { return queue; },
    async listBindings() { return []; },
    async createBinding(_userId, channelId, input) { return { schemaVersion: 'v1', channelId, active: true, ...input }; },
    async updateBinding(_userId, channelId, bindingId, input) { return { schemaVersion: 'v1', channelId, bindingId, queueId: '00000000-0000-4000-8000-000000000021', sourceType: 'payment', sourceId: 'synthetic', allowDuplicates: input.allowDuplicates ?? false, priority: input.priority ?? 10, overrideValues: input.overrideValues ?? null, active: input.active ?? true }; },
  };
}

test('overlay SSE uses the wake-up path and then replays durably until its bounded close', async () => {
  let waits = 0;
  const wakeup = {
    async wait() { waits += 1; },
    async close() {},
  };
  const app = await buildApp({ ...config, overlayStreamWindowMs: 20, overlayPollMs: 5 }, {
    sessions: fakeSessions(),
    overlays: fakeOverlays(),
    overlayWakeup: wakeup,
  });
  const response = await app.inject({
    method: 'GET',
    url: '/v1/overlays/00000000-0000-4000-8000-000000000061/events',
    headers: { authorization: 'Bearer synthetic-overlay-token-000000000000000000000000000000' },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /replay-complete/);
  assert.ok(waits >= 1);
  await app.close();
});

test('overlay SSE emits a durable event that arrives after the initial replay and resumes after Last-Event-ID', async () => {
  const first: NonNullable<Awaited<ReturnType<OverlayStore['replay']>>>[number] = {
    schemaVersion: 'v1',
    cursor: '2026-08-14T10:00:00.000000Z|00000000-0000-4000-8000-000000000071',
    eventId: '00000000-0000-4000-8000-000000000051',
    eventType: 'alert.ready',
    traceId: 'synthetic-first',
    createdAt: '2026-08-14T10:00:00.000Z',
    payload: { message: 'First' },
  };
  const second: typeof first = {
    ...first,
    cursor: '2026-08-14T10:00:01.000000Z|00000000-0000-4000-8000-000000000072',
    eventId: '00000000-0000-4000-8000-000000000052',
    traceId: 'synthetic-second',
    payload: { message: 'Second' },
  };
  const seenCursors: Array<string | undefined> = [];
  const overlayStore: OverlayStore = {
    async create() { return { schemaVersion: 'v1', overlayId: first.eventId, expiresAt: '2026-08-21T10:00:00.000Z', streamUrl: 'https://web.example.test/overlay/test#token=synthetic' }; },
    async revoke() { return true; },
    async rotate() { return null; },
    async replay(_token, _overlayId, lastEventId) {
      seenCursors.push(lastEventId);
      if (!lastEventId) return [first];
      if (lastEventId === first.cursor) return [second];
      return null;
    },
    async acknowledge() { return true; },
  };
  const app = await buildApp({ ...config, overlayStreamWindowMs: 20, overlayPollMs: 5 }, {
    overlays: overlayStore,
    overlayWakeup: { async wait() {}, async close() {} },
  });

  const initial = await app.inject({
    method: 'GET',
    url: '/v1/overlays/00000000-0000-4000-8000-000000000061/events',
    headers: { authorization: 'Bearer synthetic-overlay-token-000000000000000000000000000000' },
  });
  assert.equal(initial.statusCode, 200);
  assert.match(initial.body, /synthetic-first/);
  assert.match(initial.body, /synthetic-second/);
  assert.deepEqual(seenCursors.slice(0, 2), [undefined, first.cursor]);

  const resumed = await app.inject({
    method: 'GET',
    url: '/v1/overlays/00000000-0000-4000-8000-000000000061/events',
    headers: {
      authorization: 'Bearer synthetic-overlay-token-000000000000000000000000000000',
      'last-event-id': first.cursor,
    },
  });
  assert.equal(resumed.statusCode, 200);
  assert.doesNotMatch(resumed.body, /synthetic-first/);
  assert.match(resumed.body, /synthetic-second/);
  assert.ok(seenCursors.includes(first.cursor));
  await app.close();
});

test('overlay on replica B replays an event committed through replica A', async () => {
  const event = {
    schemaVersion: 'v1' as const,
    cursor: '2026-08-14T10:00:02.000000Z|00000000-0000-4000-8000-000000000073',
    eventId: '00000000-0000-4000-8000-000000000053',
    eventType: 'alert.ready' as const,
    traceId: 'replica-a-commit',
    createdAt: '2026-08-14T10:00:02.000Z',
    payload: { message: 'Committed on replica A' },
  };
  let committed = false;
  let wakeupsOnReplicaB = 0;
  let signalReplicaB: (() => void) | undefined;
  const durableStore: OverlayStore = {
    async create() {
      return { schemaVersion: 'v1', overlayId: event.eventId, expiresAt: '2026-08-21T10:00:00.000Z', streamUrl: 'https://web.example.test/overlay/replica#token=synthetic' };
    },
    async revoke() { return true; },
    async rotate() { return null; },
    async replay(_token, _overlayId, lastEventId) {
      if (!committed || lastEventId) return [];
      return [event];
    },
    async acknowledge() { return true; },
  };
  const replicaBWakeup = {
    async wait(_overlayId: string, timeoutMs: number) {
      wakeupsOnReplicaB += 1;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        signalReplicaB = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
    async close() {},
  };
  const replicaAWakeup = { async wait() {}, async close() {} };
  const replicaA = await buildApp({ ...config, overlayStreamWindowMs: 30, overlayPollMs: 5 }, {
    overlays: durableStore,
    overlayWakeup: replicaAWakeup,
  });
  const replicaB = await buildApp({ ...config, overlayStreamWindowMs: 30, overlayPollMs: 5 }, {
    overlays: durableStore,
    overlayWakeup: replicaBWakeup,
  });

  const stream = replicaB.inject({
    method: 'GET',
    url: '/v1/overlays/00000000-0000-4000-8000-000000000061/events',
    headers: { authorization: 'Bearer synthetic-overlay-token-000000000000000000000000000000' },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
  committed = true;
  signalReplicaB?.();

  const response = await stream;
  assert.equal(response.statusCode, 200);
  assert.equal((response.body.match(/replica-a-commit/g) ?? []).length, 1);
  assert.match(response.body, /Committed on replica A/);
  assert.ok(wakeupsOnReplicaB >= 1);

  await replicaA.close();
  await replicaB.close();
});

test('overlay replay remains correct when the notification wake-up is unavailable', async () => {
  const event = {
    schemaVersion: 'v1' as const,
    cursor: '2026-08-14T10:00:03.000000Z|00000000-0000-4000-8000-000000000074',
    eventId: '00000000-0000-4000-8000-000000000054',
    eventType: 'alert.ready' as const,
    traceId: 'notification-outage-replay',
    createdAt: '2026-08-14T10:00:03.000Z',
    payload: { message: 'Durable replay without notification' },
  };
  let committed = false;
  const durableStore: OverlayStore = {
    async create() {
      return { schemaVersion: 'v1', overlayId: event.eventId, expiresAt: '2026-08-21T10:00:00.000Z', streamUrl: 'https://web.example.test/overlay/outage#token=synthetic' };
    },
    async revoke() { return true; },
    async rotate() { return null; },
    async replay(_token, _overlayId, lastEventId) {
      if (!committed || lastEventId) return [];
      return [event];
    },
    async acknowledge() { return true; },
  };
  const app = await buildApp({ ...config, overlayStreamWindowMs: 35, overlayPollMs: 5 }, { overlays: durableStore });
  const stream = app.inject({
    method: 'GET',
    url: '/v1/overlays/00000000-0000-4000-8000-000000000061/events',
    headers: { authorization: 'Bearer synthetic-overlay-token-000000000000000000000000000000' },
  });
  await new Promise<void>((resolve) => setTimeout(() => { committed = true; resolve(); }, 8));

  const response = await stream;
  assert.equal(response.statusCode, 200);
  assert.equal((response.body.match(/notification-outage-replay/g) ?? []).length, 1);
  assert.match(response.body, /Durable replay without notification/);
  await app.close();
});

test('overlay SSE closes cleanly when replay fails after the stream opens', async () => {
  const event = {
    schemaVersion: 'v1' as const,
    cursor: '2026-08-14T10:00:04.000000Z|00000000-0000-4000-8000-000000000075',
    eventId: '00000000-0000-4000-8000-000000000055',
    eventType: 'alert.ready' as const,
    traceId: 'replay-failure',
    createdAt: '2026-08-14T10:00:04.000Z',
    payload: { message: 'Replay failure must reconnect' },
  };
  let replayCalls = 0;
  const overlayStore: OverlayStore = {
    async create() { return { schemaVersion: 'v1', overlayId: event.eventId, expiresAt: '2026-08-21T10:00:00.000Z', streamUrl: 'https://web.example.test/overlay/failure#token=synthetic' }; },
    async revoke() { return true; },
    async rotate() { return null; },
    async replay() {
      replayCalls += 1;
      if (replayCalls === 1) return [event];
      throw new Error('temporary database failure');
    },
    async acknowledge() { return true; },
  };
  const app = await buildApp({ ...config, overlayStreamWindowMs: 30, overlayPollMs: 5 }, {
    overlays: overlayStore,
    overlayWakeup: { async wait() {}, async close() {} },
  });

  const response = await app.inject({
    method: 'GET',
    url: '/v1/overlays/00000000-0000-4000-8000-000000000061/events',
    headers: { authorization: 'Bearer synthetic-overlay-token-000000000000000000000000000000' },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Replay failure must reconnect/);
  assert.match(response.body, /replay-unavailable/);
  assert.ok(replayCalls >= 2);
  await app.close();
});

test('overlay credentials are accepted only in Authorization, never in the request query', async () => {
  const app = await buildApp(config, { overlays: fakeOverlays() });
  const missingHeader = await app.inject({ method: 'GET', url: '/v1/overlays/00000000-0000-4000-8000-000000000061/events' });
  const queryCredential = await app.inject({ method: 'GET', url: '/v1/overlays/00000000-0000-4000-8000-000000000061/events?token=synthetic-overlay-token-000000000000000000000000000000' });
  assert.equal(missingHeader.statusCode, 401);
  assert.equal(queryCredential.statusCode, 400);
  await app.close();
});

test('overlay session URLs keep the credential in the fragment and out of the query', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), overlays: fakeOverlays() });
  const response = await app.inject({ method: 'POST', url: '/v1/channels/00000000-0000-4000-8000-000000000011/overlay/session', headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 201);
  const streamUrl = response.json().streamUrl as string;
  const parsed = new URL(streamUrl);
  assert.equal(parsed.search, '');
  assert.match(parsed.hash, /^#token=/);
  await app.close();
});

test('protected current-user route rejects missing credentials', async () => {
  const app = await buildApp(config, { sessions: fakeSessions() });
  const response = await app.inject({ method: 'GET', url: '/v1/me' });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().errorCode, 'unauthorized');
  await app.close();
});

test('authenticated routes accept the HTTP case-insensitive Bearer scheme', async () => {
  const app = await buildApp(config, { sessions: fakeSessions() });
  const response = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `bearer ${'a'.repeat(48)}` } });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().schemaVersion, 'v1');
  await app.close();
});

test('Google exchange creates an opaque session and returns current user', async () => {
  const google: GoogleIdentityVerifier = {
    async verify(idToken) {
      assert.equal(idToken, 'g'.repeat(24));
      return { subject: 'google-subject-test', displayName: 'Synthetic Creator' };
    },
  };
  const app = await buildApp(config, { google, sessions: fakeSessions() });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/google/exchange',
    payload: { idToken: 'g'.repeat(24), deviceLabel: 'Test device' },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().schemaVersion, 'v1');
  assert.equal(response.json().accessToken.length, 48);
  assert.equal(response.json().user.displayName, 'Synthetic Creator');
  await app.close();
});

test('authenticated session list and revoke are channel/user scoped', async () => {
  const app = await buildApp(config, { sessions: fakeSessions() });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
  const list = await app.inject({ method: 'GET', url: '/v1/me/sessions', headers });
  const revoke = await app.inject({ method: 'DELETE', url: '/v1/me/sessions/00000000-0000-4000-8000-000000000041', headers });

  assert.equal(list.statusCode, 200);
  assert.equal(list.json().sessions[0].current, true);
  assert.equal(revoke.statusCode, 204);
  await app.close();
});

test('authenticated alert and Companion routes expose bounded v1 operations', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), channels: fakeChannels(), alerts: fakeAlerts(), overlays: fakeOverlays() });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
  const channelId = '00000000-0000-4000-8000-000000000011';
  const alertId = '00000000-0000-4000-8000-000000000051';

  const accepted = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/test-alert`, headers, payload: { displayName: 'Synthetic Viewer', message: 'Hello' } });
  const history = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/alert-history?pageSize=10`, headers });
  const moderation = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/moderation/${alertId}`, headers, payload: { action: 'hold', reason: 'manual test' } });
  const billing = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/billing`, headers });
  const entitlements = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/entitlements`, headers });
  const state = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/companion/state`, headers });
  const layout = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/companion/layout`, headers });
  const savedLayout = await app.inject({ method: 'PATCH', url: `/v1/channels/${channelId}/companion/layout`, headers: { ...headers, 'if-match-version': '0' }, payload: { pageSize: 8, slots: [] } });
  const controlSession = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/control-session`, headers, payload: { clientType: 'mobile', clientInstanceId: 'mobile-instance-0001' } });
  const revokedControlSession = await app.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/companion/control-session/00000000-0000-4000-8000-000000000401`, headers });
  const action = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/actions`, headers: { ...headers, 'idempotency-key': 'synthetic-command-001' }, payload: { action: 'pause_queue', targetId: channelId } });
  const testAction = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/actions`, headers: { ...headers, 'idempotency-key': 'synthetic-command-002' }, payload: { action: 'send_test_alert', targetId: '00000000-0000-4000-8000-000000000021' } });
  const unsafeKey = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/actions`, headers: { ...headers, 'idempotency-key': 'unsafe key with spaces' }, payload: { action: 'pause_queue', targetId: channelId } });
  const missingKey = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/actions`, headers, payload: { action: 'resume_queue', targetId: channelId } });
  const missingTarget = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/actions`, headers: { ...headers, 'idempotency-key': 'synthetic-command-003' }, payload: { action: 'pause_queue' } });
  const unsupportedAction = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/companion/actions`, headers: { ...headers, 'idempotency-key': 'synthetic-command-004' }, payload: { action: 'approve_alert', targetId: alertId } });
  const overlay = await app.inject({ method: 'POST', url: `/v1/channels/${channelId}/overlay/session`, headers });
  const rotated = await app.inject({ method: 'POST', url: '/v1/overlays/00000000-0000-4000-8000-000000000061/rotate', headers });
  const revoked = await app.inject({ method: 'DELETE', url: '/v1/overlays/00000000-0000-4000-8000-000000000061', headers });
  const overlayHeaders = { authorization: 'Bearer synthetic-overlay-token-000000000000000000000000000000' };
  const replay = await app.inject({ method: 'GET', url: '/v1/overlays/00000000-0000-4000-8000-000000000061/events', headers: { ...overlayHeaders, 'last-event-id': '' } });
  const cursor = await app.inject({ method: 'POST', url: '/v1/overlays/00000000-0000-4000-8000-000000000061/cursor', headers: overlayHeaders, payload: { cursor: '2026-08-14T10:00:00.000000Z|00000000-0000-4000-8000-000000000071', eventId: alertId } });
  const badCursor = await app.inject({ method: 'GET', url: '/v1/overlays/00000000-0000-4000-8000-000000000061/events', headers: { ...overlayHeaders, 'last-event-id': 'bad-cursor' } });
  const invalidOverlay = await app.inject({ method: 'GET', url: '/v1/overlays/00000000-0000-4000-8000-000000000099/events', headers: overlayHeaders });
  const channel = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}`, headers });
  const configView = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/config`, headers });
  const queues = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/queues`, headers });
  const bindings = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/bindings`, headers });

  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json().status, 'accepted');
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().items[0].message, 'Hello');
  assert.equal(moderation.statusCode, 200);
  assert.equal(moderation.json().action, 'hold');
  assert.equal(billing.statusCode, 200);
  assert.equal(billing.json().monthlyPricePaise, 39900);
  assert.equal(entitlements.statusCode, 200);
  assert.equal(entitlements.json().entitlementVersion, 4);
  assert.equal(state.statusCode, 200);
  assert.equal(state.json().overlayConnected, true);
  assert.equal(layout.statusCode, 200);
  assert.equal(layout.json().maxSlots, 32);
  assert.equal(savedLayout.statusCode, 200);
  assert.equal(savedLayout.json().pageSize, 8);
  assert.equal(controlSession.statusCode, 201);
  assert.equal(controlSession.json().clientType, 'mobile');
  assert.equal(revokedControlSession.statusCode, 204);
  assert.equal(action.statusCode, 202);
  assert.equal(action.json().status, 'accepted');
  assert.equal(testAction.statusCode, 202);
  assert.equal(unsafeKey.statusCode, 400);
  assert.equal(unsafeKey.json().errorCode, 'bad_request');
  assert.equal(missingKey.statusCode, 400);
  assert.equal(missingKey.json().errorCode, 'idempotency_key_required');
  assert.equal(missingTarget.statusCode, 400);
  assert.equal(missingTarget.json().errorCode, 'bad_request');
  assert.equal(unsupportedAction.statusCode, 400);
  assert.equal(overlay.statusCode, 201);
  assert.equal(overlay.json().overlayId, '00000000-0000-4000-8000-000000000061');
  assert.equal(rotated.statusCode, 201);
  assert.equal(rotated.json().overlayId, '00000000-0000-4000-8000-000000000062');
  assert.equal(revoked.statusCode, 204);
  assert.equal(replay.statusCode, 200);
  assert.match(replay.headers['content-type'] ?? '', /text\/event-stream/);
  assert.match(replay.body, /alert\.ready/);
  assert.equal(cursor.statusCode, 204);
  assert.equal(badCursor.statusCode, 400);
  assert.equal(invalidOverlay.statusCode, 401);
  assert.equal(channel.statusCode, 200);
  assert.equal(configView.statusCode, 200);
  assert.equal(queues.json().queues[0].name, 'Main');
  assert.equal(bindings.statusCode, 200);
  await app.close();
});

test('configuration and binding override envelopes reject oversized top-level objects', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), channels: fakeChannels() });
  const authorization = `Bearer ${'a'.repeat(48)}`;
  const oversized = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key${index}`, true]));
  const configResponse = await app.inject({
    method: 'PATCH',
    url: '/v1/channels/00000000-0000-4000-8000-000000000011/config',
    headers: { authorization, 'if-match-version': '1' },
    payload: { values: oversized },
  });
  const bindingResponse = await app.inject({
    method: 'POST',
    url: '/v1/channels/00000000-0000-4000-8000-000000000011/bindings',
    headers: { authorization },
    payload: {
      queueId: '00000000-0000-4000-8000-000000000021',
      sourceType: 'payment',
      sourceId: 'payment',
      allowDuplicates: false,
      priority: 10,
      overrideValues: oversized,
    },
  });

  assert.equal(configResponse.statusCode, 400);
  assert.equal(bindingResponse.statusCode, 400);
  await app.close();
});

test('binding override envelope accepts bounded presentation and source policy fields', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), channels: fakeChannels() });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/channels/00000000-0000-4000-8000-000000000011/bindings',
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: {
      queueId: '00000000-0000-4000-8000-000000000021',
      sourceType: 'payment',
      sourceId: 'payment',
      allowDuplicates: false,
      priority: 10,
      overrideValues: {
        displayStyle: 'large_card',
        anchor: 'bottom_right',
        scale: 1.25,
        rateLimitPerMinute: 60,
        bracket: { charLimit: 180, displayMinMs: 12000, ttsEligible: false, ttsOverflowPolicy: 'visual_only' },
      },
    },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().overrideValues.rateLimitPerMinute, 60);
  assert.equal(response.json().overrideValues.bracket.charLimit, 180);

  const unsupported = await app.inject({
    method: 'POST',
    url: '/v1/channels/00000000-0000-4000-8000-000000000011/bindings',
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: {
      queueId: '00000000-0000-4000-8000-000000000021',
      sourceType: 'payment',
      sourceId: 'payment',
      allowDuplicates: false,
      priority: 10,
      overrideValues: { script: '<script>alert(1)</script>' },
    },
  });
  assert.equal(unsupported.statusCode, 400);
  await app.close();
});

test('binding updates are explicit, scoped and preserve the accepted-snapshot boundary', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), channels: fakeChannels() });
  const authorization = `Bearer ${'a'.repeat(48)}`;
  const bindingId = '00000000-0000-4000-8000-000000000031';
  const updated = await app.inject({
    method: 'PATCH',
    url: `/v1/channels/00000000-0000-4000-8000-000000000011/bindings/${bindingId}`,
    headers: { authorization },
    payload: { allowDuplicates: true, priority: 90 },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().allowDuplicates, true);
  assert.equal(updated.json().priority, 90);
  assert.equal(updated.json().active, true);

  const empty = await app.inject({
    method: 'PATCH',
    url: `/v1/channels/00000000-0000-4000-8000-000000000011/bindings/${bindingId}`,
    headers: { authorization },
    payload: {},
  });
  assert.equal(empty.statusCode, 400);
  await app.close();
});

test('approved channel configuration schema rejects unknown keys and semantic bracket gaps', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), channels: fakeChannels() });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}`, 'if-match-version': '1' };
  const saved = await app.inject({
    method: 'PATCH',
    url: '/v1/channels/00000000-0000-4000-8000-000000000011/config',
    headers,
    payload: { values: { minimumTipPaise: 1000, defaultDisplaySeconds: 10, defaultStyle: 'standard_card', locale: 'en-IN', reducedMotion: true, brackets: [{ amountMinPaise: 1000, amountMaxPaise: null, charLimit: 120, ttsEligible: true, displayStyle: 'standard_card', displayMinMs: 10000, ttsOverflowPolicy: 'extend' }], tts: { enabled: true, voiceId: 'bulbul:v1', language: 'en-IN', overflowPolicy: 'extend', paddingMs: 300 }, display: { anchor: 'bottom_center', offsetX: 4, offsetY: -8, scale: 1, widthPercent: 80, maxVisibleItems: 2 }, queue: { mode: 'aggregated', stackLimit: 2, aggregationWindowSeconds: 30, aggregationThreshold: 5, rateLimitPerMinute: 60, approvalRequired: true, quietMode: { enabled: true, start: '23:00', end: '07:00', timezone: 'Asia/Kolkata' } } } },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().version, 2);

  const stale = await app.inject({
    method: 'PATCH',
    url: '/v1/channels/00000000-0000-4000-8000-000000000011/config',
    headers: { ...headers, 'if-match-version': '2' },
    payload: { values: { minimumTipPaise: 1000 } },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().errorCode, 'config_version_conflict');

  const invalidKey = await app.inject({
    method: 'PATCH',
    url: '/v1/channels/00000000-0000-4000-8000-000000000011/config',
    headers,
    payload: { values: { minimumTipPaise: 1000, privateDatabaseUrl: 'secret' } },
  });
  assert.equal(invalidKey.statusCode, 400);

  const gap = await app.inject({
    method: 'PATCH',
    url: '/v1/channels/00000000-0000-4000-8000-000000000011/config',
    headers,
    payload: {
      values: {
        minimumTipPaise: 1000,
        brackets: [
          { amountMinPaise: 1000, amountMaxPaise: 1999, charLimit: 20, ttsEligible: false, displayStyle: 'small_pill', displayMinMs: 4000, ttsOverflowPolicy: 'disable' },
          { amountMinPaise: 2100, amountMaxPaise: null, charLimit: 50, ttsEligible: true, displayStyle: 'standard_card', displayMinMs: 6000, ttsOverflowPolicy: 'extend' },
        ],
      },
    },
  });
  assert.equal(gap.statusCode, 400);
  assert.equal(gap.json().errorCode, 'config_invalid');
  assert.equal(gap.json().issues[0].code, 'ERR_BRACKETS_GAP');
  await app.close();
});
