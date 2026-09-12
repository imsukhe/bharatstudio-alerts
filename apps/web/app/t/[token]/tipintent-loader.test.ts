import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTipIntent } from './tipintent-loader';

const ready = {
  schemaVersion: 'v1', state: 'ready', channelHandle: 'raka_gaming', channelDisplayName: 'Raka Gaming',
  amountPaise: 10000, currency: 'INR', donorDisplayName: 'Rahul', message: 'hi',
};

function response(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

test('a ready token resolves with full detail', async () => {
  const result = await loadTipIntent('https://api.example.test', 'ABCDE12345', async () => response(200, ready));
  assert.equal(result.state, 'ready');
});

test('used/expired/unknown states are each distinct', async () => {
  const used = await loadTipIntent('https://api.example.test', 'T', async () => response(200, { schemaVersion: 'v1', state: 'used', channelHandle: 'h', channelDisplayName: 'H' }));
  const expired = await loadTipIntent('https://api.example.test', 'T', async () => response(200, { schemaVersion: 'v1', state: 'expired', channelHandle: 'h', channelDisplayName: 'H' }));
  const unknown = await loadTipIntent('https://api.example.test', 'T', async () => response(404, { schemaVersion: 'v1', state: 'unknown' }));
  assert.equal(used.state, 'used');
  assert.equal(expired.state, 'expired');
  assert.equal(unknown.state, 'unknown');
  const states = new Set([used.state, expired.state, unknown.state]);
  assert.equal(states.size, 3, 'used/expired/unknown must render as three distinct states');
});

test('transport failure, missing origin, and a malformed/tampered response are all "unavailable" — never mislabeled as a real state', async () => {
  const missingOrigin = await loadTipIntent(undefined, 'T', async () => response(200, ready));
  const networkFailure = await loadTipIntent('https://api.example.test', 'T', async () => { throw new Error('offline'); });
  const serverError = await loadTipIntent('https://api.example.test', 'T', async () => response(503, { error: 'busy' }));
  const tampered = await loadTipIntent('https://api.example.test', 'T', async () => response(200, { ...ready, amountPaise: 'not-a-number' }));
  assert.deepEqual(missingOrigin, { state: 'unavailable' });
  assert.deepEqual(networkFailure, { state: 'unavailable' });
  assert.deepEqual(serverError, { state: 'unavailable' });
  assert.deepEqual(tampered, { state: 'unavailable' });
});
