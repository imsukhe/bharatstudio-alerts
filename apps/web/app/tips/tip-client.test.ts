import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchTipOrder, getOrCreateTipIdempotencyKey, shouldRetainTipIdempotencyKey, tipRequestTimeoutMs } from './tip-client';

test('normalizes tip request timeout to a bounded range', () => {
  assert.equal(tipRequestTimeoutMs(10_000), 10_000);
  assert.equal(tipRequestTimeoutMs(999), 10_000);
  assert.equal(tipRequestTimeoutMs(60_001), 10_000);
  assert.equal(tipRequestTimeoutMs(2_345.9), 2_345);
});

test('reuses a retry key and retains it only for retryable or ambiguous responses', () => {
  assert.equal(getOrCreateTipIdempotencyKey('existing-key', () => 'new-key'), 'existing-key');
  assert.equal(getOrCreateTipIdempotencyKey(null, () => 'new-key'), 'new-key');
  assert.equal(shouldRetainTipIdempotencyKey(503, false), true);
  assert.equal(shouldRetainTipIdempotencyKey(400, false), false);
  assert.equal(shouldRetainTipIdempotencyKey(200, false), true);
  assert.equal(shouldRetainTipIdempotencyKey(200, true), false);
});

test('aborts a stalled tip-order request within the configured bound', async () => {
  let aborted = false;
  const fetchImpl: typeof fetch = async (_url, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });
  };

  await assert.rejects(
    fetchTipOrder({ url: 'https://api.example.test/v1/tips/orders', init: { method: 'POST' }, timeoutMs: 1_000, fetchImpl }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(aborted, true);
});

test('forwards the request idempotency key and does not mutate the body', async () => {
  const request = { method: 'POST', headers: { 'Idempotency-Key': 'tip-retry-key-001' }, body: '{"amountPaise":1000}' };
  let received: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    received = init;
    return new Response('{"ok":true}', { status: 200 });
  };

  await fetchTipOrder({ url: 'https://api.example.test/v1/tips/orders', init: request, timeoutMs: 1_000, fetchImpl });
  assert.equal((received?.headers as Record<string, string>)['Idempotency-Key'], 'tip-retry-key-001');
  assert.equal(received?.body, request.body);
});
