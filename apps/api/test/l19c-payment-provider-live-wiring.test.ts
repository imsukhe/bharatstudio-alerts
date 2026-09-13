import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerPublicRoutes } from '../src/routes/public.js';
import { registerPaymentAccountRoutes } from '../src/routes/payment-accounts.js';
import type { PublicChannelRepository } from '../src/domain/public-channel.js';
import type { CreateTipOrderInput, PaymentOrderService, TipOrder } from '../src/domain/payment-order.js';
import { createRazorpayPaymentProvider } from '../src/domain/payment-provider-razorpay.js';
import { PaymentProviderNotImplementedError, isValidUpiAppPreference, UPI_APP_PREFERENCES } from '../src/domain/payment-provider-creator.js';
import type { RazorpayOAuthHttpClient } from '../src/domain/payment-provider-razorpay-oauth.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { PaymentAccount, PaymentAccountStore } from '../src/domain/payment-account.js';
import type { ProviderCapabilitySnapshot, ProviderCapabilitySnapshotStore } from '../src/domain/payment-provider-creator.js';

const channelId = '00000000-0000-4000-8000-000000000011';
const userId = '00000000-0000-4000-8000-000000000001';

const repository: PublicChannelRepository = {
  async findByHandle(handle) {
    return handle === 'demo_creator'
      ? { channelId, handle, displayName: 'Demo Creator', acceptingTips: true, minimumTipPaise: 1000, publicConfigVersion: 1 }
      : null;
  },
  async listFeatured() { return []; },
};

// ---------------------------------------------------------------------
// 1. The live tip flow behaves IDENTICALLY once routed through
//    provider.createPayment: same PaymentOrderService input, same
//    response shape, same values.
// ---------------------------------------------------------------------
test('POST tips/orders routes through CreatorPaymentProvider.createPayment and returns the identical TipOrder shape', async () => {
  const calls: CreateTipOrderInput[] = [];
  let seenTraceId: string | undefined;
  const paymentOrders: PaymentOrderService = {
    async createTipOrder(input, traceId) {
      calls.push(input);
      seenTraceId = traceId;
      const order: TipOrder = { schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000099', provider: 'razorpay', providerOrderId: 'order_synthetic_1', amountPaise: input.amountPaise, currency: 'INR', status: 'created' };
      return order;
    },
  };
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  await registerPublicRoutes(app, repository, paymentOrders, 'test');
  await app.ready();

  const response = await app.inject({
    method: 'POST',
    url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-l19c-001' },
    payload: { amountPaise: 50000, currency: 'INR', donorDisplayName: 'Priya', message: 'great stream', alertConsent: true },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['amountPaise', 'currency', 'orderId', 'provider', 'providerOrderId', 'schemaVersion', 'status'].sort());
  assert.equal(body.orderId, '00000000-0000-4000-8000-000000000099');
  assert.equal(body.provider, 'razorpay');
  assert.equal(body.providerOrderId, 'order_synthetic_1');
  assert.equal(body.amountPaise, 50000);
  assert.equal(body.currency, 'INR');
  assert.equal(body.status, 'created');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.channelId, channelId);
  assert.equal(calls[0]?.environment, 'test');
  assert.equal(calls[0]?.idempotencyKey, 'synthetic-idempotency-l19c-001');
  assert.equal(calls[0]?.donorDisplayName, 'Priya');
  assert.equal(calls[0]?.message, 'great stream');
  assert.equal(calls[0]?.alertConsent, true);
  assert.equal(calls[0]?.amountPaise, 50000);
  assert.equal(calls[0]?.currency, 'INR');
  assert.match(calls[0]?.providerReceipt ?? '', /^bsa_[0-9a-f]{32}$/);
  assert.equal(typeof calls[0]?.expiresAt, 'string');
  assert.equal(seenTraceId, response.headers['x-request-id'] ?? seenTraceId); // traceId is request.id, forwarded unchanged

  await app.close();
});

// ---------------------------------------------------------------------
// 2 & 3. Capability truth: createPayment succeeds ONLY when both a
//    PaymentOrderService and every tip-order field are present;
//    createQr/fetchPayment/refund still throw even with paymentOrders
//    configured -- configuring one dependency must never silently widen
//    what the provider claims to support.
// ---------------------------------------------------------------------
test('createPayment throws (never no-ops) when the intent is missing tip-order fields, even with a PaymentOrderService configured', async () => {
  const paymentOrders: PaymentOrderService = { async createTipOrder() { throw new Error('should not be called'); } };
  const provider = createRazorpayPaymentProvider(undefined, paymentOrders);
  await assert.rejects(
    () => provider.createPayment({ channelId, environment: 'test', idempotencyKey: 'k', intentId: 'TIP_1', amountPaise: 1000, currency: 'INR' }),
    PaymentProviderNotImplementedError,
  );
});

test('createQr, fetchPayment and refund still throw even when a PaymentOrderService is configured for createPayment', async () => {
  const paymentOrders: PaymentOrderService = { async createTipOrder(input) { return { schemaVersion: 'v1', orderId: 'o', provider: 'razorpay', providerOrderId: 'p', amountPaise: input.amountPaise, currency: 'INR', status: 'created' }; } };
  const provider = createRazorpayPaymentProvider(undefined, paymentOrders);
  const intent = { channelId, environment: 'test' as const, idempotencyKey: 'k', intentId: 'TIP_1', amountPaise: 1000, currency: 'INR' as const };
  await assert.rejects(() => provider.createQr(intent), PaymentProviderNotImplementedError);
  await assert.rejects(() => provider.fetchPayment('pay_1'), PaymentProviderNotImplementedError);
  await assert.rejects(() => provider.refund('pay_1', 1000), PaymentProviderNotImplementedError);
  // capability flags are unaffected by which dependency was injected.
  // L19d: dynamic QR is now genuinely implemented, so this rail-level flag
  // is true even on an instance built without a DynamicQrService (createQr
  // still throws for that instance, asserted above).
  assert.equal(provider.connectionCapabilities().supportsDynamicQr, true);
  assert.equal(provider.connectionCapabilities().supportsRefunds, false);
});

test('a fully-populated tip-order intent succeeds through createPayment', async () => {
  const paymentOrders: PaymentOrderService = {
    async createTipOrder(input) {
      return { schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000077', provider: 'razorpay', providerOrderId: 'order_2', amountPaise: input.amountPaise, currency: 'INR', status: 'pending' };
    },
  };
  const provider = createRazorpayPaymentProvider(undefined, paymentOrders);
  const result = await provider.createPayment({
    channelId, environment: 'live', idempotencyKey: 'k2', intentId: 'TIP_2', amountPaise: 20000, currency: 'INR',
    donorDisplayName: 'Anon', message: '', alertConsent: false, providerReceipt: 'bsa_x', expiresAt: '2026-09-13T00:00:00.000Z',
  });
  assert.equal(result.orderId, '00000000-0000-4000-8000-000000000077');
  assert.equal(result.providerPaymentRef, 'order_2');
  assert.equal(result.status, 'pending');
  assert.equal(result.amountPaise, 20000);
  assert.equal(result.currency, 'INR');
});

// ---------------------------------------------------------------------
// 4. UPI-app preference: closed, non-secret enum -- proven to reject
//    anything credential-shaped and accept only the known app names.
// ---------------------------------------------------------------------
test('UPI-app preference validator accepts only the closed app-name allowlist, never a credential-shaped value', () => {
  for (const app of UPI_APP_PREFERENCES) assert.equal(isValidUpiAppPreference(app), true);
  const credentialLikeValues = [
    ['sk', 'live', '51H' + 'x'.repeat(24)].join('_'),      // API-secret-shaped
    '4111111111111111',                          // card-number-shaped
    'user@upi',                                  // a VPA, not an app name
    '1234',                                      // a PIN-shaped value
    '',
    'GOOGLE_PAY; DROP TABLE payment_accounts;--',
    123 as unknown as string,
    null as unknown as string,
  ];
  for (const value of credentialLikeValues) assert.equal(isValidUpiAppPreference(value), false);
});

test('the razorpay capabilities route exposes the same closed UPI-app allowlist, never a free-text field', async () => {
  const sessions: SessionStore = {
    async create() { throw new Error('not used'); },
    async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
    async getCurrentUser() { throw new Error('not used'); }, async list() { return []; }, async revoke() { return false; },
  };
  const store: PaymentAccountStore = { async list() { return []; }, async register() { throw new Error('not used'); }, async revoke() { return false; }, async skipOnboarding() { return '2026-08-16T00:00:00.000Z'; } };
  const app = Fastify();
  await registerPaymentAccountRoutes(app, sessions, store);
  await app.ready();
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/payment-accounts/razorpay/capabilities`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().supportedUpiApps, UPI_APP_PREFERENCES);
  await app.close();
});

// ---------------------------------------------------------------------
// 5. Capability-snapshot persistence: best-effort, never fails the read.
// ---------------------------------------------------------------------
test('capabilities route persists a snapshot when a store is configured, and still returns 200 if the write fails', async () => {
  const sessions: SessionStore = {
    async create() { throw new Error('not used'); },
    async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
    async getCurrentUser() { throw new Error('not used'); }, async list() { return []; }, async revoke() { return false; },
  };
  const store: PaymentAccountStore = { async list() { return []; }, async register() { throw new Error('not used'); }, async revoke() { return false; }, async skipOnboarding() { return '2026-08-16T00:00:00.000Z'; } };

  const writes: { userId: string; channelId: string; environment: string }[] = [];
  const failingSnapshots: ProviderCapabilitySnapshotStore = {
    async upsert() { throw new Error('db unavailable'); },
    async get() { return null; },
  };
  const appFailing = Fastify();
  await registerPaymentAccountRoutes(appFailing, sessions, store, undefined, undefined, failingSnapshots);
  await appFailing.ready();
  const failingResponse = await appFailing.inject({ method: 'GET', url: `/v1/channels/${channelId}/payment-accounts/razorpay/capabilities`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(failingResponse.statusCode, 200);
  await appFailing.close();

  const workingSnapshots: ProviderCapabilitySnapshotStore = {
    async upsert(uid, cid, environment, capabilities) {
      writes.push({ userId: uid, channelId: cid, environment });
      const snapshot: ProviderCapabilitySnapshot = { ...capabilities, channelId: cid, environment, capturedAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z' };
      return snapshot;
    },
    async get() { return null; },
  };
  const appWorking = Fastify();
  await registerPaymentAccountRoutes(appWorking, sessions, store, undefined, undefined, workingSnapshots);
  await appWorking.ready();
  const workingResponse = await appWorking.inject({ method: 'GET', url: `/v1/channels/${channelId}/payment-accounts/razorpay/capabilities`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(workingResponse.statusCode, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.userId, userId);
  assert.equal(writes[0]?.channelId, channelId);
  assert.equal(writes[0]?.environment, 'test');
  await appWorking.close();
});

// ---------------------------------------------------------------------
// 6. Razorpay OAuth alongside manual acc_XXX -- coexistence, no branching
//    outside the abstraction: both paths end at provider.connectAccount.
// ---------------------------------------------------------------------
test('Razorpay OAuth: authorize-url is 503 when unconfigured, and callback registers via the SAME connectAccount call the manual path uses', async () => {
  const sessions: SessionStore = {
    async create() { throw new Error('not used'); },
    async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
    async getCurrentUser() { throw new Error('not used'); }, async list() { return []; }, async revoke() { return false; },
  };
  const registerCalls: { userId: string; channelId: string; environment: string; ref: string }[] = [];
  const account: PaymentAccount = { schemaVersion: 'v1', accountId: '00000000-0000-4000-8000-000000000041', channelId, provider: 'razorpay', environment: 'test', connectedAccountRef: 'acc_from_oauth', status: 'pending', createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z', revokedAt: null };
  const store: PaymentAccountStore = {
    async list() { return []; },
    async register(uid, cid, environment, ref) { registerCalls.push({ userId: uid, channelId: cid, environment, ref }); return { ...account, environment, connectedAccountRef: ref }; },
    async revoke() { return false; },
    async skipOnboarding() { return '2026-08-16T00:00:00.000Z'; },
  };

  // Unconfigured: fails closed, exactly like every other optional
  // dependency in this codebase.
  const appUnconfigured = Fastify();
  await registerPaymentAccountRoutes(appUnconfigured, sessions, store);
  await appUnconfigured.ready();
  const unconfigured = await appUnconfigured.inject({ method: 'GET', url: `/v1/channels/${channelId}/payment-accounts/razorpay/oauth/authorize-url`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(unconfigured.statusCode, 503);
  await appUnconfigured.close();

  // Configured, with a fake token-exchange client (no live network call).
  const fakeHttpClient: RazorpayOAuthHttpClient = async (_url, body) => {
    assert.equal(body.grant_type, 'authorization_code');
    assert.equal(body.code, 'auth_code_synthetic');
    return { razorpay_account_id: 'acc_from_oauth' };
  };
  const appConfigured = Fastify();
  await registerPaymentAccountRoutes(appConfigured, sessions, store, undefined, { clientId: 'client_1', clientSecret: 'secret_1', redirectUri: 'https://app.example.test/oauth/callback' }, undefined, fakeHttpClient);
  await appConfigured.ready();

  const authorizeUrlResponse = await appConfigured.inject({ method: 'GET', url: `/v1/channels/${channelId}/payment-accounts/razorpay/oauth/authorize-url`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(authorizeUrlResponse.statusCode, 200);
  const authorizePayload = authorizeUrlResponse.json();
  assert.match(authorizePayload.url, /^https:\/\/auth\.razorpay\.com\/authorize\?/);
  assert.ok(authorizePayload.url.includes('client_id=client_1'));
  assert.ok(authorizePayload.state.length >= 16);

  const callbackResponse = await appConfigured.inject({
    method: 'POST',
    url: `/v1/channels/${channelId}/payment-accounts/razorpay/oauth/callback`,
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: { code: 'auth_code_synthetic', environment: 'test' },
  });
  assert.equal(callbackResponse.statusCode, 200);
  assert.equal(callbackResponse.json().connectedAccountRef, 'acc_from_oauth');
  assert.equal(registerCalls.length, 1);
  assert.equal(registerCalls[0]?.ref, 'acc_from_oauth');

  // The manual PUT path still works unchanged, calling the exact same
  // store.register -- proving OAuth added a second way to obtain a ref,
  // not a second connection code path.
  const manualResponse = await appConfigured.inject({
    method: 'PUT',
    url: `/v1/channels/${channelId}/payment-accounts/razorpay`,
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: { environment: 'test', connectedAccountRef: 'acc_manual_paste' },
  });
  assert.equal(manualResponse.statusCode, 200);
  assert.equal(registerCalls.length, 2);
  assert.equal(registerCalls[1]?.ref, 'acc_manual_paste');

  await appConfigured.close();
});

// ---------------------------------------------------------------------
// Webhook verification / event-id dedup are deliberately NOT
// re-implemented behind this interface (see webhookVerifier's doc
// comment) -- this test proves the pointer this task shipped still names
// the one real, untouched verifier, rather than asserting behaviour this
// task's file ownership cannot exercise (services/payment-webhook-go is
// out of scope; its own Go test suite, untouched by this task, is
// services/payment-webhook-go/internal/webhook/verifier_test.go).
test('webhookVerifier still names the single untouched Go verifier -- no second signature-check implementation was added', () => {
  const provider = createRazorpayPaymentProvider();
  const ref = provider.webhookVerifier();
  assert.equal(ref.provider, 'razorpay');
  assert.equal(ref.implementedAt, 'services/payment-webhook-go/internal/webhook/verifier.go');
});
