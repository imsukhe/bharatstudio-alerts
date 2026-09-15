import assert from 'node:assert/strict';
import test from 'node:test';
import { mintReceiptForConfirmedTip, receiptPath } from './receipt-client';

test('mints a receipt with only the already-known intent id and accepts only the opaque token contract', async () => {
  let received: RequestInit | undefined;
  const token = '0123456789ABCDEF';
  const fetchImpl: typeof fetch = async (_url, init) => {
    received = init;
    return new Response(JSON.stringify({ schemaVersion: 'v1', token, ignored: 'not used' }), { status: 201 });
  };
  const minted = await mintReceiptForConfirmedTip('https://api.example.test', '00000000-0000-4000-8000-000000000091', fetchImpl);
  assert.equal(minted, token);
  assert.equal(received?.method, 'POST');
  assert.equal(received?.credentials, 'include');
  assert.deepEqual(JSON.parse(received?.body as string), { intentId: '00000000-0000-4000-8000-000000000091' });
  assert.equal(receiptPath(token), `/r/${token}`);
});

test('never changes payment state for an unavailable or malformed receipt response', async () => {
  const unavailable: typeof fetch = async () => new Response('{"errorCode":"receipt_unavailable"}', { status: 409 });
  const malformed: typeof fetch = async () => new Response('{"token":"not-a-receipt-token"}', { status: 201 });
  assert.equal(await mintReceiptForConfirmedTip('https://api.example.test', '00000000-0000-4000-8000-000000000091', unavailable), null);
  assert.equal(await mintReceiptForConfirmedTip('https://api.example.test', '00000000-0000-4000-8000-000000000091', malformed), null);
});
