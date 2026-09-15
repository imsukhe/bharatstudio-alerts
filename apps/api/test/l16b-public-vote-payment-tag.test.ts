import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerPublicRoutes } from '../src/routes/public.js';
import type { PublicChannelRepository } from '../src/domain/public-channel.js';
import type { PaymentOrderService } from '../src/domain/payment-order.js';
import type { PublicPaidVoteStore, TagVotePaymentInput, TagVotePaymentResult, VotePaymentTagStore } from '../src/domain/vote-payment-types.js';

// L16 gap closure (0108): this focused route test exercises the optional
// vote-payment dependency with a bare Fastify instance. The complementary
// l16-runtime-composition test proves buildApp passes the production store.

const channelId = '00000000-0000-4000-8000-000000000011';

const repository: PublicChannelRepository = {
  async findByHandle(handle) {
    return handle === 'demo_creator'
      ? { channelId, handle, displayName: 'Demo Creator', acceptingTips: true, minimumTipPaise: 1000, publicConfigVersion: 1 }
      : null;
  },
  async listFeatured() { return []; },
};

function fakePaymentOrders(onCreate?: () => void): PaymentOrderService {
  return {
    async createTipOrder(input) {
      onCreate?.();
      return { schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000091', provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: input.amountPaise, currency: 'INR', status: 'created' };
    },
  };
}

async function buildTestApp(votePaymentTags?: VotePaymentTagStore, publicPaidVotes?: PublicPaidVoteStore, onCreate?: () => void) {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  await registerPublicRoutes(
    app, repository, fakePaymentOrders(onCreate), 'test', undefined, undefined, false,
    undefined, undefined, 'https://app.example.test', votePaymentTags, publicPaidVotes,
  );
  await app.ready();
  return app;
}

test('a tip order carrying both interactionDefinitionId and voteOptionKey tags the payment before creating the order', async () => {
  const calls: TagVotePaymentInput[] = [];
  const votePaymentTags: VotePaymentTagStore = { async tag(input) { calls.push(input); return { outcome: 'tagged' }; } };
  const app = await buildTestApp(votePaymentTags);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-tag-001' },
    payload: { amountPaise: 100000, currency: 'INR', interactionDefinitionId: '00000000-0000-4000-8000-000000000099', voteOptionKey: 'option-a' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    channelId, environment: 'test', idempotencyKey: 'synthetic-idempotency-tag-001',
    interactionDefinitionId: '00000000-0000-4000-8000-000000000099', optionKey: 'option-a',
  });
  await app.close();
});

test('a tip order with no vote fields never calls the tag store', async () => {
  let called = false;
  const votePaymentTags: VotePaymentTagStore = { async tag() { called = true; return { outcome: 'tagged' }; } };
  const app = await buildTestApp(votePaymentTags);
  const response = await app.inject({
    method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-tag-002' }, payload: { amountPaise: 100000, currency: 'INR' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(called, false);
  await app.close();
});

test('a lone voteOptionKey is rejected before either tag or payment creation', async () => {
  let called = false;
  let paymentCreated = false;
  const votePaymentTags: VotePaymentTagStore = { async tag() { called = true; return { outcome: 'tagged' }; } };
  const app = await buildTestApp(votePaymentTags, undefined, () => { paymentCreated = true; });
  const response = await app.inject({
    method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-tag-003' }, payload: { amountPaise: 100000, currency: 'INR', voteOptionKey: 'option-a' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  assert.equal(paymentCreated, false);
  await app.close();
});

test('a rejected/invalid tag never fails the underlying tip — the checkout is what must never break', async () => {
  const votePaymentTags: VotePaymentTagStore = { async tag(): Promise<TagVotePaymentResult> { return { outcome: 'invalid' }; } };
  let paymentCreated = false;
  const app = await buildTestApp(votePaymentTags, undefined, () => { paymentCreated = true; });
  const response = await app.inject({
    method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-tag-004' },
    payload: { amountPaise: 100000, currency: 'INR', interactionDefinitionId: '00000000-0000-4000-8000-000000000099', voteOptionKey: 'option-a' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'invalid_interaction_selection');
  assert.equal(paymentCreated, false);
  await app.close();
});

test('a tag store that THROWS never fails the underlying tip either', async () => {
  const votePaymentTags: VotePaymentTagStore = { async tag() { throw new Error('db connection reset'); } };
  let paymentCreated = false;
  const app = await buildTestApp(votePaymentTags, undefined, () => { paymentCreated = true; });
  const response = await app.inject({
    method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-tag-005' },
    payload: { amountPaise: 100000, currency: 'INR', interactionDefinitionId: '00000000-0000-4000-8000-000000000099', voteOptionKey: 'option-a' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'interaction_unavailable');
  assert.equal(paymentCreated, false);
  await app.close();
});

test('a durable tag-store outage is retryable and still prevents payment order creation', async () => {
  let paymentCreated = false;
  const votePaymentTags: VotePaymentTagStore = { async tag() { return { outcome: 'unavailable' }; } };
  const app = await buildTestApp(votePaymentTags, undefined, () => { paymentCreated = true; });
  const response = await app.inject({
    method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-tag-005b' },
    payload: { amountPaise: 100000, currency: 'INR', interactionDefinitionId: '00000000-0000-4000-8000-000000000099', voteOptionKey: 'option-a' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'interaction_unavailable');
  assert.equal(paymentCreated, false);
  await app.close();
});

test('with no votePaymentTags store wired, a selected vote fails before payment order creation', async () => {
  let paymentCreated = false;
  const app = await buildTestApp(undefined, undefined, () => { paymentCreated = true; });
  const response = await app.inject({
    method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-tag-006' },
    payload: { amountPaise: 100000, currency: 'INR', interactionDefinitionId: '00000000-0000-4000-8000-000000000099', voteOptionKey: 'option-a' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'interaction_unavailable');
  assert.equal(paymentCreated, false);
  await app.close();
});

test('a partial selection fails closed before payment creation', async () => {
  let paymentCreated = false;
  const app = await buildTestApp(undefined, undefined, () => { paymentCreated = true; });
  const response = await app.inject({
    method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-tag-007' }, payload: { amountPaise: 100000, currency: 'INR', voteOptionKey: 'option-a' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'invalid_interaction_selection');
  assert.equal(paymentCreated, false);
  await app.close();
});

test('public paid-vote catalogue exposes only the strict item projection and fails closed when unwired', async () => {
  const publicPaidVotes: PublicPaidVoteStore = {
    async listForChannel(id) {
      assert.equal(id, channelId);
      return [{ definitionId: '00000000-0000-4000-8000-000000000099', label: 'Which game?', options: [{ optionKey: 'option-a', label: 'Game A' }] }];
    },
  };
  const app = await buildTestApp(undefined, publicPaidVotes);
  const response = await app.inject({ method: 'GET', url: '/v1/public/channels/demo_creator/paid-votes' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', items: [{ definitionId: '00000000-0000-4000-8000-000000000099', label: 'Which game?', options: [{ optionKey: 'option-a', label: 'Game A' }] }] });
  await app.close();

  const unwired = await buildTestApp();
  const unavailable = await unwired.inject({ method: 'GET', url: '/v1/public/channels/demo_creator/paid-votes' });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().errorCode, 'interaction_unavailable');
  await unwired.close();
});
