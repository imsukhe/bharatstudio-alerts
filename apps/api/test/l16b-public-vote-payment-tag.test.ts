import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerPublicRoutes } from '../src/routes/public.js';
import type { PublicChannelRepository } from '../src/domain/public-channel.js';
import type { PaymentOrderService } from '../src/domain/payment-order.js';
import type { TagVotePaymentInput, TagVotePaymentResult, VotePaymentTagStore } from '../src/domain/vote-payment-types.js';

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

function fakePaymentOrders(): PaymentOrderService {
  return {
    async createTipOrder(input) {
      return { schemaVersion: 'v1', orderId: '00000000-0000-4000-8000-000000000091', provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: input.amountPaise, currency: 'INR', status: 'created' };
    },
  };
}

async function buildTestApp(votePaymentTags?: VotePaymentTagStore) {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  await registerPublicRoutes(
    app, repository, fakePaymentOrders(), 'test', undefined, undefined, false,
    undefined, undefined, 'https://app.example.test', votePaymentTags,
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

test('a lone voteOptionKey with no interactionDefinitionId never calls the tag store, and the tip still succeeds', async () => {
  let called = false;
  const votePaymentTags: VotePaymentTagStore = { async tag() { called = true; return { outcome: 'tagged' }; } };
  const app = await buildTestApp(votePaymentTags);
  const response = await app.inject({
    method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-tag-003' }, payload: { amountPaise: 100000, currency: 'INR', voteOptionKey: 'option-a' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(called, false);
  await app.close();
});

test('a rejected/invalid tag never fails the underlying tip — the checkout is what must never break', async () => {
  const votePaymentTags: VotePaymentTagStore = { async tag(): Promise<TagVotePaymentResult> { return { outcome: 'invalid' }; } };
  const app = await buildTestApp(votePaymentTags);
  const response = await app.inject({
    method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-tag-004' },
    payload: { amountPaise: 100000, currency: 'INR', interactionDefinitionId: '00000000-0000-4000-8000-000000000099', voteOptionKey: 'option-a' },
  });
  assert.equal(response.statusCode, 201);
  await app.close();
});

test('a tag store that THROWS never fails the underlying tip either', async () => {
  const votePaymentTags: VotePaymentTagStore = { async tag() { throw new Error('db connection reset'); } };
  const app = await buildTestApp(votePaymentTags);
  const response = await app.inject({
    method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-tag-005' },
    payload: { amountPaise: 100000, currency: 'INR', interactionDefinitionId: '00000000-0000-4000-8000-000000000099', voteOptionKey: 'option-a' },
  });
  assert.equal(response.statusCode, 201);
  await app.close();
});

test('with no votePaymentTags store wired at all, a tip carrying vote fields still succeeds unmodified', async () => {
  const app = await buildTestApp(undefined);
  const response = await app.inject({
    method: 'POST', url: '/v1/public/channels/demo_creator/tips/orders',
    headers: { 'idempotency-key': 'synthetic-idempotency-tag-006' },
    payload: { amountPaise: 100000, currency: 'INR', interactionDefinitionId: '00000000-0000-4000-8000-000000000099', voteOptionKey: 'option-a' },
  });
  assert.equal(response.statusCode, 201);
  await app.close();
});
