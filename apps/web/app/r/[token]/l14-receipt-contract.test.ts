import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReceiptResponse } from './receipt-contract';

const found = {
  schemaVersion: 'v1',
  receipt: {
    channelHandle: 'raka_gaming', channelDisplayName: 'Raka Gaming',
    grossAmountPaise: 20000, refundedAmountPaise: 0, netAmountPaise: 20000,
    currency: 'INR', donorDisplayName: 'Ravi', message: 'gg', paymentStatus: 'captured', paidAt: '2026-09-01T00:00:00.000Z',
  },
};

test('a found receipt parses with net amount accounting for any refund', () => {
  const parsed = parseReceiptResponse(found);
  assert.equal(parsed?.state, 'found');
  if (parsed?.state === 'found') assert.equal(parsed.netAmountPaise, 20000);
});

test('an error-shaped response (404 not_found) parses as not_found, never surfacing an errorCode as data', () => {
  const parsed = parseReceiptResponse({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Receipt not found', traceId: 't1' });
  assert.deepEqual(parsed, { state: 'not_found' });
});

test('a malformed/tampered response is rejected outright, never partially trusted', () => {
  assert.equal(parseReceiptResponse({ ...found, receipt: { ...found.receipt, netAmountPaise: 'not-a-number' } }), null);
  assert.equal(parseReceiptResponse({ ...found, receipt: { ...found.receipt, currency: 'USD' } }), null);
  assert.equal(parseReceiptResponse(null), null);
  assert.equal(parseReceiptResponse('a raw token string, not a response'), null);
});

test('the token itself never appears anywhere in the parsed shape', () => {
  const parsed = parseReceiptResponse(found);
  assert.ok(parsed && !('token' in parsed), 'a receipt response must never echo back a token');
});
