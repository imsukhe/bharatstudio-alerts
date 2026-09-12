import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { PublicChannelRepository } from '../src/domain/public-channel.js';
import type { PaymentOrderService } from '../src/domain/payment-order.js';

const config: RuntimeConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 4101,
  appOrigin: 'http://localhost:3100',
  paymentEnvironment: 'live',
};

const currentChannel = {
  channelId: '00000000-0000-4000-8000-000000000021',
  handle: 'current_handle',
  displayName: 'Renamed Creator',
  acceptingTips: true,
  minimumTipPaise: 1000,
  publicConfigVersion: 3,
};

// A history map from any released handle this channel ever used (however
// long the rename chain) straight to its current projection — mirrors
// channel_handle_history mapping directly to channel_id, never to
// "next handle", so a chain A->B->C resolves in one hop.
function fakeRepository(history: Record<string, typeof currentChannel>): PublicChannelRepository {
  return {
    async findByHandle(handle) {
      return handle === currentChannel.handle ? currentChannel : null;
    },
    async listFeatured() { return []; },
    async resolveReleasedHandle(handle) {
      return history[handle] ?? null;
    },
  };
}

test('GET resolves a once-released handle to the channel current handle, marked renamedFrom', async () => {
  const app = await buildApp(config, { publicChannels: fakeRepository({ old_handle: currentChannel }) });
  const response = await app.inject({ method: 'GET', url: '/v1/public/channels/old_handle' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ...currentChannel, renamedFrom: 'old_handle' });
  await app.close();
});

test('GET resolves a multi-hop rename chain (A->B->C) in one lookup, no chain walking', async () => {
  const app = await buildApp(config, { publicChannels: fakeRepository({ handle_a: currentChannel, handle_b: currentChannel }) });
  const responseA = await app.inject({ method: 'GET', url: '/v1/public/channels/handle_a' });
  const responseB = await app.inject({ method: 'GET', url: '/v1/public/channels/handle_b' });
  assert.equal(responseA.json().handle, 'current_handle');
  assert.equal(responseB.json().handle, 'current_handle');
  await app.close();
});

test('GET on a live (non-renamed) handle never carries renamedFrom', async () => {
  const app = await buildApp(config, { publicChannels: fakeRepository({}) });
  const response = await app.inject({ method: 'GET', url: '/v1/public/channels/current_handle' });
  assert.equal(response.statusCode, 200);
  assert.equal('renamedFrom' in response.json(), false);
  await app.close();
});

test('GET on a handle that never existed still 404s, same as any released-lookup miss', async () => {
  const app = await buildApp(config, { publicChannels: fakeRepository({}) });
  const response = await app.inject({ method: 'GET', url: '/v1/public/channels/never_existed' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().errorCode, 'not_found');
  await app.close();
});

test('GET works without a resolveReleasedHandle implementation at all (optional method)', async () => {
  const repository: PublicChannelRepository = {
    async findByHandle(handle) { return handle === currentChannel.handle ? currentChannel : null; },
    async listFeatured() { return []; },
  };
  const app = await buildApp(config, { publicChannels: repository });
  const response = await app.inject({ method: 'GET', url: '/v1/public/channels/old_handle' });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('a tip can be created by posting to a released handle', async () => {
  const created: unknown[] = [];
  const paymentOrders: PaymentOrderService = {
    async createTipOrder(input) {
      created.push(input);
      return {
        schemaVersion: 'v1',
        orderId: '00000000-0000-4000-8000-000000000099',
        provider: 'razorpay',
        providerOrderId: 'order_synthetic',
        amountPaise: input.amountPaise,
        currency: input.currency,
        status: 'created',
      };
    },
  };
  const app = await buildApp(config, {
    publicChannels: fakeRepository({ old_handle: currentChannel }),
    paymentOrders,
  });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/public/channels/old_handle/tips/orders',
    headers: { 'idempotency-key': 'synthetic-renamed-handle-001' },
    payload: { amountPaise: 1000, currency: 'INR' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(created.length, 1);
  assert.equal((created[0] as { channelId: string }).channelId, currentChannel.channelId);
  await app.close();
});

test('a tip order still 404s through a handle that never existed', async () => {
  const paymentOrders: PaymentOrderService = {
    async createTipOrder() { throw new Error('must not be called for a channel that was never found'); },
  };
  const app = await buildApp(config, { publicChannels: fakeRepository({}), paymentOrders });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/public/channels/never_existed/tips/orders',
    headers: { 'idempotency-key': 'synthetic-nonexistent-001' },
    payload: { amountPaise: 1000, currency: 'INR' },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});
