import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { registerPublicRoutes } from '../src/routes/public.js';
import { generateTipIntentToken, hashTipIntentToken } from '../src/db/tipintent-store.js';
import type {
  ConsumedTipIntent,
  CreateTipIntentInput,
  ResolvedTipIntent,
  TipIntentRepository,
} from '../src/domain/tipintent-types.js';
import type { PaymentOrderService } from '../src/domain/payment-order.js';

const CREATION_SECRET = 'synthetic-connector-secret-value';

type IntentRecord = {
  channelId: string;
  channelHandle: string;
  channelDisplayName: string;
  amountPaise: number;
  donorDisplayName: string | null;
  message: string | null;
  consumed: boolean;
  expired: boolean;
};

// Faithful in-memory TipIntentRepository: uses the SAME token generation
// and hashing as the real store (db/tipintent-store.ts) so tests exercise
// the real token shape, but keeps records in a Map instead of Postgres —
// mirrors migration 0097's "only the fingerprint is stored, never the
// token" design (records are keyed by tokenHash, never by the raw token).
function fakeTipIntents() {
  const byHash = new Map<string, IntentRecord>();
  const repository: TipIntentRepository = {
    async create(input: CreateTipIntentInput) {
      const token = generateTipIntentToken();
      byHash.set(hashTipIntentToken(token), {
        channelId: input.channelId,
        channelHandle: 'raka_gaming',
        channelDisplayName: 'Raka Gaming',
        amountPaise: input.amountPaise,
        donorDisplayName: input.donorDisplayName ?? null,
        message: input.message ?? null,
        consumed: false,
        expired: false,
      });
      return { token, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
    },
    async resolve(token: string): Promise<ResolvedTipIntent> {
      const record = byHash.get(hashTipIntentToken(token));
      if (!record) return { state: 'unknown' };
      if (record.consumed) return { state: 'used', channelHandle: record.channelHandle, channelDisplayName: record.channelDisplayName };
      if (record.expired) return { state: 'expired', channelHandle: record.channelHandle, channelDisplayName: record.channelDisplayName };
      return {
        state: 'ready',
        channelHandle: record.channelHandle,
        channelDisplayName: record.channelDisplayName,
        amountPaise: record.amountPaise,
        currency: 'INR',
        donorDisplayName: record.donorDisplayName,
        message: record.message,
      };
    },
    async consume(token: string, _orderId: string): Promise<ConsumedTipIntent | null> {
      const record = byHash.get(hashTipIntentToken(token));
      if (!record || record.consumed || record.expired) return null;
      record.consumed = true;
      return {
        channelId: record.channelId,
        amountPaise: record.amountPaise,
        currency: 'INR',
        donorDisplayName: record.donorDisplayName,
        message: record.message,
      };
    },
  };
  return { repository, byHash };
}

async function buildTestApp(opts: {
  tipIntents?: TipIntentRepository;
  paymentOrders?: PaymentOrderService;
  rateLimited?: boolean;
}) {
  // Mirrors app.ts's ajv config exactly: removeAdditional: false, so an
  // unknown property in a request body is REJECTED (400), not silently
  // stripped — this is what makes the tamper-resistance test below
  // meaningful (fastify's own default otherwise strips unknown fields
  // instead of rejecting them).
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  if (opts.rateLimited) {
    // Deliberately NOT allow-listing 127.0.0.1 (unlike app.ts's test
    // config) so the per-route rate-limit config actually engages here.
    await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  }
  await registerPublicRoutes(
    app,
    undefined,
    opts.paymentOrders,
    'test',
    undefined,
    undefined,
    false,
    opts.tipIntents,
    CREATION_SECRET,
    'https://app.example.test',
  );
  await app.ready();
  return app;
}

test('internal creation rejects a missing or wrong connector secret', async () => {
  const { repository } = fakeTipIntents();
  const app = await buildTestApp({ tipIntents: repository });
  const noSecret = await app.inject({ method: 'POST', url: '/v1/public/internal/tip-intents', payload: { channelId: '00000000-0000-4000-8000-000000000001', amountPaise: 10000, sourcePlatform: 'youtube' } });
  assert.equal(noSecret.statusCode, 401);
  const wrongSecret = await app.inject({ method: 'POST', url: '/v1/public/internal/tip-intents', headers: { 'x-connector-secret': 'wrong' }, payload: { channelId: '00000000-0000-4000-8000-000000000001', amountPaise: 10000, sourcePlatform: 'youtube' } });
  assert.equal(wrongSecret.statusCode, 401);
  await app.close();
});

test('token is opaque: the created token/shortLink encode nothing recoverable, only a lookup resolves the amount/name/message', async () => {
  const { repository } = fakeTipIntents();
  const app = await buildTestApp({ tipIntents: repository });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/public/internal/tip-intents',
    headers: { 'x-connector-secret': CREATION_SECRET },
    payload: { channelId: '00000000-0000-4000-8000-000000000001', amountPaise: 12345, donorDisplayName: 'Rahul', message: 'play GTA bhai', sourcePlatform: 'youtube' },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.match(body.token, /^[0-9A-Za-z]{10}$/);
  assert.equal(body.shortLink, `https://app.example.test/t/${body.token}`);
  // The amount (12345), the encoded rupee value (123), and the name/
  // message never appear anywhere in the token or the short link.
  for (const needle of ['12345', '123', 'Rahul', 'GTA']) {
    assert.equal(body.token.includes(needle), false, `token must not contain ${needle}`);
    assert.equal(body.shortLink.includes(needle), false, `shortLink must not contain ${needle}`);
  }
  await app.close();
});

test('resolve returns ready with full details, and unknown for a token that was never issued', async () => {
  const { repository } = fakeTipIntents();
  const app = await buildTestApp({ tipIntents: repository });
  const created = (await app.inject({
    method: 'POST', url: '/v1/public/internal/tip-intents', headers: { 'x-connector-secret': CREATION_SECRET },
    payload: { channelId: '00000000-0000-4000-8000-000000000001', amountPaise: 10000, donorDisplayName: 'Rahul', message: 'hi', sourcePlatform: 'youtube' },
  })).json();

  const ready = await app.inject({ method: 'GET', url: `/v1/public/tip-intents/${created.token}` });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), {
    schemaVersion: 'v1', state: 'ready', channelHandle: 'raka_gaming', channelDisplayName: 'Raka Gaming',
    amountPaise: 10000, currency: 'INR', donorDisplayName: 'Rahul', message: 'hi',
  });

  const unknown = await app.inject({ method: 'GET', url: '/v1/public/tip-intents/ZZZZZZZZZZ' });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().state, 'unknown');
  await app.close();
});

test('used and expired states render distinctly and never carry amount/name/message', async () => {
  const { repository, byHash } = fakeTipIntents();
  const app = await buildTestApp({ tipIntents: repository });
  const usedToken = (await app.inject({ method: 'POST', url: '/v1/public/internal/tip-intents', headers: { 'x-connector-secret': CREATION_SECRET }, payload: { channelId: '00000000-0000-4000-8000-000000000002', amountPaise: 5000, sourcePlatform: 'youtube' } })).json().token;
  const expiredToken = (await app.inject({ method: 'POST', url: '/v1/public/internal/tip-intents', headers: { 'x-connector-secret': CREATION_SECRET }, payload: { channelId: '00000000-0000-4000-8000-000000000002', amountPaise: 5000, sourcePlatform: 'youtube' } })).json().token;
  byHash.get(hashTipIntentToken(usedToken))!.consumed = true;
  byHash.get(hashTipIntentToken(expiredToken))!.expired = true;

  const usedResponse = await app.inject({ method: 'GET', url: `/v1/public/tip-intents/${usedToken}` });
  assert.deepEqual(usedResponse.json(), { schemaVersion: 'v1', state: 'used', channelHandle: 'raka_gaming', channelDisplayName: 'Raka Gaming' });
  assert.equal('amountPaise' in usedResponse.json(), false);

  const expiredResponse = await app.inject({ method: 'GET', url: `/v1/public/tip-intents/${expiredToken}` });
  assert.deepEqual(expiredResponse.json(), { schemaVersion: 'v1', state: 'expired', channelHandle: 'raka_gaming', channelDisplayName: 'Raka Gaming' });
  assert.notEqual(usedResponse.json().state, expiredResponse.json().state);
  await app.close();
});

test('tamper resistance: a client-supplied amountPaise in the confirm body is rejected outright (schema), and the resulting order always uses the server-side amount', async () => {
  const { repository } = fakeTipIntents();
  const createdOrders: unknown[] = [];
  const paymentOrders: PaymentOrderService = {
    async createTipOrder(input) {
      createdOrders.push(input);
      return { schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000099', provider: 'razorpay', providerOrderId: 'order_x', amountPaise: input.amountPaise, currency: input.currency, status: 'created' };
    },
  };
  const app = await buildTestApp({ tipIntents: repository, paymentOrders });
  const created = (await app.inject({ method: 'POST', url: '/v1/public/internal/tip-intents', headers: { 'x-connector-secret': CREATION_SECRET }, payload: { channelId: '00000000-0000-4000-8000-000000000003', amountPaise: 7700, donorDisplayName: 'Rahul', message: 'hi', sourcePlatform: 'youtube' } })).json();

  // Attempt to tamper: post a wildly different amount straight into the
  // confirm body. additionalProperties: false on this route's schema
  // rejects it before the handler ever runs.
  const tampered = await app.inject({
    method: 'POST',
    url: `/v1/public/tip-intents/${created.token}/orders`,
    headers: { 'idempotency-key': 'synthetic-tipintent-tamper-0001' },
    payload: { amountPaise: 1, donorDisplayName: 'Attacker', turnstileToken: null },
  });
  assert.equal(tampered.statusCode, 400);
  assert.equal(createdOrders.length, 0);

  // The legitimate confirm (no amount in the body at all) uses the
  // TipIntent's own server-side amount.
  const legitimate = await app.inject({
    method: 'POST',
    url: `/v1/public/tip-intents/${created.token}/orders`,
    headers: { 'idempotency-key': 'synthetic-tipintent-confirm-0001' },
    payload: {},
  });
  assert.equal(legitimate.statusCode, 201);
  assert.equal(createdOrders.length, 1);
  assert.equal((createdOrders[0] as { amountPaise: number }).amountPaise, 7700);
  assert.equal((createdOrders[0] as { donorDisplayName: string }).donorDisplayName, 'Rahul');
  await app.close();
});

test('confirm on an already-used token 409s, on an expired token 410s, on an unknown token 404s, and single-use is enforced', async () => {
  const { repository } = fakeTipIntents();
  const paymentOrders: PaymentOrderService = { async createTipOrder(input) { return { schemaVersion: 'v1', orderId: 'o1', provider: 'razorpay', providerOrderId: 'p1', amountPaise: input.amountPaise, currency: input.currency, status: 'created' }; } };
  const app = await buildTestApp({ tipIntents: repository, paymentOrders });
  const created = (await app.inject({ method: 'POST', url: '/v1/public/internal/tip-intents', headers: { 'x-connector-secret': CREATION_SECRET }, payload: { channelId: '00000000-0000-4000-8000-000000000003', amountPaise: 5000, sourcePlatform: 'youtube' } })).json();

  const first = await app.inject({ method: 'POST', url: `/v1/public/tip-intents/${created.token}/orders`, headers: { 'idempotency-key': 'synthetic-tipintent-single-use-01' }, payload: {} });
  assert.equal(first.statusCode, 201);

  const second = await app.inject({ method: 'POST', url: `/v1/public/tip-intents/${created.token}/orders`, headers: { 'idempotency-key': 'synthetic-tipintent-single-use-02' }, payload: {} });
  assert.equal(second.statusCode, 409);

  const unknown = await app.inject({ method: 'POST', url: '/v1/public/tip-intents/ZZZZZZZZZZ/orders', headers: { 'idempotency-key': 'synthetic-tipintent-single-use-03' }, payload: {} });
  assert.equal(unknown.statusCode, 404);
  await app.close();
});

test('TipIntent confirmation uses the same opaque anonymous cookie boundary as direct checkout', async () => {
  const { repository } = fakeTipIntents();
  const createdOrders: Array<{ anonymousIdentityTokenHash?: string }> = [];
  const paymentOrders: PaymentOrderService = {
    async createTipOrder(input) {
      createdOrders.push(input);
      return { schemaVersion: 'v1', orderId: input.intentId, provider: 'razorpay', providerOrderId: `order_${input.intentId}`, amountPaise: input.amountPaise, currency: input.currency, status: 'created' };
    },
  };
  const app = await buildTestApp({ tipIntents: repository, paymentOrders });
  const firstIntent = (await app.inject({ method: 'POST', url: '/v1/public/internal/tip-intents', headers: { 'x-connector-secret': CREATION_SECRET }, payload: { channelId: '00000000-0000-4000-8000-000000000003', amountPaise: 5000, sourcePlatform: 'youtube' } })).json();
  const first = await app.inject({ method: 'POST', url: `/v1/public/tip-intents/${firstIntent.token}/orders`, headers: { 'idempotency-key': 'synthetic-tipintent-identity-0001' }, payload: {} });
  assert.equal(first.statusCode, 201);
  const cookie = first.headers['set-cookie'];
  assert.equal(typeof cookie, 'string');
  assert.match(cookie as string, /^__Host-bsa-anonymous=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/);
  assert.match(createdOrders[0]?.anonymousIdentityTokenHash ?? '', /^[0-9a-f]{64}$/);

  const secondIntent = (await app.inject({ method: 'POST', url: '/v1/public/internal/tip-intents', headers: { 'x-connector-secret': CREATION_SECRET }, payload: { channelId: '00000000-0000-4000-8000-000000000003', amountPaise: 6000, sourcePlatform: 'youtube' } })).json();
  const second = await app.inject({ method: 'POST', url: `/v1/public/tip-intents/${secondIntent.token}/orders`, headers: { 'idempotency-key': 'synthetic-tipintent-identity-0002', cookie: (cookie as string).split(';', 1)[0] }, payload: {} });
  assert.equal(second.statusCode, 201);
  assert.equal(second.headers['set-cookie'], undefined);
  assert.equal(createdOrders[1]?.anonymousIdentityTokenHash, createdOrders[0]?.anonymousIdentityTokenHash);
  await app.close();
});

test('the resolve lookup is rate limited', async () => {
  const { repository } = fakeTipIntents();
  const app = await buildTestApp({ tipIntents: repository, rateLimited: true });
  const created = (await app.inject({ method: 'POST', url: '/v1/public/internal/tip-intents', headers: { 'x-connector-secret': CREATION_SECRET }, payload: { channelId: '00000000-0000-4000-8000-000000000003', amountPaise: 5000, sourcePlatform: 'youtube' } })).json();

  let sawTooManyRequests = false;
  for (let i = 0; i < 32; i++) {
    const response = await app.inject({ method: 'GET', url: `/v1/public/tip-intents/${created.token}` });
    if (response.statusCode === 429) { sawTooManyRequests = true; break; }
  }
  assert.equal(sawTooManyRequests, true, 'expected the 30/minute route limit to engage within 32 requests');
  await app.close();
});

test('every new route 503s cleanly when tipIntents is not configured (feature dark by default)', async () => {
  const app = await buildTestApp({});
  const create = await app.inject({ method: 'POST', url: '/v1/public/internal/tip-intents', headers: { 'x-connector-secret': CREATION_SECRET }, payload: { channelId: '00000000-0000-4000-8000-000000000004', amountPaise: 100, sourcePlatform: 'youtube' } });
  assert.equal(create.statusCode, 503);
  const resolve = await app.inject({ method: 'GET', url: '/v1/public/tip-intents/AAAAAAAAAA' });
  assert.equal(resolve.statusCode, 503);
  const confirm = await app.inject({ method: 'POST', url: '/v1/public/tip-intents/AAAAAAAAAA/orders', headers: { 'idempotency-key': 'synthetic-tipintent-dark-0001' }, payload: {} });
  assert.equal(confirm.statusCode, 503);
  await app.close();
});
