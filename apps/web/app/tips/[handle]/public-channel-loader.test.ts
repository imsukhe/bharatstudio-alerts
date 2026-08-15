import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPublicChannel } from './public-channel-loader';

const channel = {
  channelId: '00000000-0000-4000-8000-000000000011',
  handle: 'demo_creator',
  displayName: 'Demo Creator',
  acceptingTips: true,
  minimumTipPaise: 1000,
  publicConfigVersion: 1,
};

function response(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

test('returns the narrow public channel on a valid response', async () => {
  const result = await loadPublicChannel('https://api.example.test', 'demo_creator', async () => response(200, channel));
  assert.deepEqual(result, { state: 'ready', channel });
});

test('distinguishes an absent creator from a temporary API failure', async () => {
  const missing = await loadPublicChannel('https://api.example.test', 'missing', async () => response(404, { error: 'not_found' }));
  const unavailable = await loadPublicChannel('https://api.example.test', 'demo_creator', async () => response(503, { error: 'busy' }));
  assert.deepEqual(missing, { state: 'not_found' });
  assert.deepEqual(unavailable, { state: 'unavailable' });
});

test('fails closed without mislabeling an outage as creator policy', async () => {
  const missingOrigin = await loadPublicChannel(undefined, 'demo_creator', async () => response(200, channel));
  const networkFailure = await loadPublicChannel('https://api.example.test', 'demo_creator', async () => { throw new Error('offline'); });
  const malformed = await loadPublicChannel('https://api.example.test', 'demo_creator', async () => response(200, { ...channel, secret: 'must-not-cross' }));
  assert.deepEqual(missingOrigin, { state: 'unavailable' });
  assert.deepEqual(networkFailure, { state: 'unavailable' });
  assert.deepEqual(malformed, { state: 'unavailable' });
});
