import assert from 'node:assert/strict';
import test from 'node:test';
import { loadReceipt } from './receipt-loader';

const found = {
  schemaVersion: 'v1',
  receipt: {
    channelHandle: 'raka_gaming', channelDisplayName: 'Raka Gaming',
    grossAmountPaise: 20000, refundedAmountPaise: 0, netAmountPaise: 20000,
    currency: 'INR', donorDisplayName: 'Ravi', message: null, paymentStatus: 'captured', paidAt: '2026-09-01T00:00:00.000Z',
  },
};

function response(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

test('THE RECEIPT TEST: resolves with no viewer account/session — the fetch call carries no Authorization header', async () => {
  let sawAuthHeader = false;
  const fetcher = (async (_url: string, init?: RequestInit) => {
    if (init?.headers && 'Authorization' in (init.headers as Record<string, string>)) sawAuthHeader = true;
    return response(200, found);
  }) as typeof fetch;

  const result = await loadReceipt('https://api.example.test', 'A1B2C3D4E5F6G7H8', fetcher);
  assert.equal(result.state, 'found');
  assert.equal(sawAuthHeader, false, 'the receipt page must never send auth — it works with no account at all');
});

test('an unknown/guessed token resolves to not_found, never leaking any amount', async () => {
  const result = await loadReceipt('https://api.example.test', 'GUESSEDTOKEN0000', async () => response(404, { schemaVersion: 'v1', errorCode: 'not_found', message: 'Receipt not found', traceId: 't1' }));
  assert.deepEqual(result, { state: 'not_found', receipt: { state: 'not_found' } });
  assert.equal(JSON.stringify(result).includes('20000'), false);
});

test('transport failure, missing origin, and a malformed response are all "unavailable"', async () => {
  const missingOrigin = await loadReceipt(undefined, 'T', async () => response(200, found));
  const networkFailure = await loadReceipt('https://api.example.test', 'T', async () => { throw new Error('offline'); });
  const serverError = await loadReceipt('https://api.example.test', 'T', async () => response(503, { error: 'busy' }));
  const tampered = await loadReceipt('https://api.example.test', 'T', async () => response(200, { ...found, receipt: { ...found.receipt, netAmountPaise: 'nan' } }));
  assert.deepEqual(missingOrigin, { state: 'unavailable' });
  assert.deepEqual(networkFailure, { state: 'unavailable' });
  assert.deepEqual(serverError, { state: 'unavailable' });
  assert.deepEqual(tampered, { state: 'unavailable' });
});
