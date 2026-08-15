import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedServerMessage, parsePublicOrderStatus, parseTipOrderResponse } from './tip-contract';

const orderId = '00000000-0000-4000-8000-000000000001';

test('accepts only a bounded server-owned tip order envelope', () => {
  const parsed = parseTipOrderResponse({ schemaVersion: 'v1', orderId, provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: 2500, currency: 'INR', status: 'created' }, 2500);
  assert.deepEqual(parsed, { schemaVersion: 'v1', orderId, provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: 2500, currency: 'INR', status: 'created' });
  assert.equal(parseTipOrderResponse({ schemaVersion: 'v1', orderId, provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: -1, currency: 'INR', status: 'created' }, 2500), null);
  assert.equal(parseTipOrderResponse({ schemaVersion: 'v1', orderId, provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: 1000, currency: 'INR', status: 'created' }, 2500), null);
  assert.equal(parseTipOrderResponse({ schemaVersion: 'v1', orderId: 'not-a-uuid', provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: 2500, currency: 'INR', status: 'created' }, 2500), null);
  assert.equal(parseTipOrderResponse({ schemaVersion: 'v1', orderId, provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: 2500, currency: 'INR', status: 'unexpected' }, 2500), null);
  assert.equal(parseTipOrderResponse({ schemaVersion: 'v1', orderId, provider: 'razorpay', providerOrderId: 'order_synthetic', amountPaise: 2500, currency: 'INR', status: 'created', secret: true }, 2500), null);
});

test('accepts only server-confirmed public payment status', () => {
  const parsed = parsePublicOrderStatus({ schemaVersion: 'v1', orderId, status: 'paid', amountPaise: 1000, currency: 'INR', updatedAt: '2026-08-15T10:00:00.000Z' });
  assert.equal(parsed?.status, 'paid');
  assert.equal(parsePublicOrderStatus({ schemaVersion: 'v1', orderId, status: 'paid', amountPaise: 1000, currency: 'USD', updatedAt: '2026-08-15T10:00:00.000Z' }), null);
  assert.equal(parsePublicOrderStatus({ schemaVersion: 'v1', orderId, status: 'paid', amountPaise: 1000, currency: 'INR', updatedAt: 'not-a-date' }), null);
  assert.equal(parsePublicOrderStatus({ schemaVersion: 'v1', orderId, status: 'provider_created', amountPaise: 1000, currency: 'INR', updatedAt: '2026-08-15T10:00:00.000Z' }), null);
  assert.equal(parsePublicOrderStatus({ schemaVersion: 'v1', orderId, status: 'paid', amountPaise: 1000, currency: 'INR', updatedAt: '2026-08-15T10:00:00.000Z', internalState: 'captured' }), null);
});

test('bounds server messages before showing them in checkout errors', () => {
  assert.equal(boundedServerMessage('Payment could not be prepared'), 'Payment could not be prepared');
  assert.equal(boundedServerMessage('<script>alert(1)</script>'), '<script>alert(1)</script>');
  assert.equal(boundedServerMessage('x'.repeat(181)), undefined);
  assert.equal(boundedServerMessage({ message: 'nested' }), undefined);
});
