import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { PaymentLedgerEntry, PaymentLedgerStore } from '../src/domain/payment-ledger.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const entry: PaymentLedgerEntry = {
  paymentId: '00000000-0000-4000-8000-000000000051', providerPaymentId: 'pay_synthetic_1',
  grossAmountPaise: 50000, currency: 'INR', status: 'captured', createdAt: '2026-08-15T10:00:00.000Z',
  refundTotalPaise: 0, latestRefundStatus: null,
};

test('the payment ledger route returns a bounded page for an authenticated caller', async () => {
  let seenChannelId: string | undefined;
  let seenCursor: string | undefined;
  const store: PaymentLedgerStore = {
    async listPayments(_user, channel, cursor) {
      seenChannelId = channel;
      seenCursor = cursor;
      return { schemaVersion: 'v1', items: [entry], nextCursor: null };
    },
  };
  const app = await buildApp(config, { sessions, paymentLedger: store });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/payments?cursor=2026-08-15T10%3A00%3A00.000Z%7C00000000-0000-4000-8000-000000000051`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items, [entry]);
  assert.equal(seenChannelId, channelId);
  assert.equal(seenCursor, '2026-08-15T10:00:00.000Z|00000000-0000-4000-8000-000000000051');
  await app.close();
});

test('a non-owner/admin caller sees an empty ledger, not a 403 — enforcement stays at the database layer', async () => {
  const store: PaymentLedgerStore = {
    async listPayments() { return { schemaVersion: 'v1', items: [], nextCursor: null }; },
  };
  const app = await buildApp(config, { sessions, paymentLedger: store });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/payments`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items, []);
  await app.close();
});

test('the payment ledger route rejects an invalid cursor and unauthenticated callers, and fails closed without a store', async () => {
  const store: PaymentLedgerStore = {
    async listPayments() { throw new Error('invalid payments cursor'); },
  };
  const app = await buildApp(config, { sessions, paymentLedger: store });
  const badCursor = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/payments?cursor=not-a-cursor`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(badCursor.statusCode, 400);
  assert.equal(badCursor.json().errorCode, 'bad_cursor');

  const unauthorized = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/payments` });
  assert.equal(unauthorized.statusCode, 401);
  await app.close();

  const unavailableApp = await buildApp(config, { sessions });
  const unavailable = await unavailableApp.inject({ method: 'GET', url: `/v1/channels/${channelId}/payments`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().errorCode, 'payment_ledger_unavailable');
  await unavailableApp.close();
});
