import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { OverlayAudioStore } from '../src/domain/overlay-audio-store.js';
import type { TtsStore } from '../src/domain/tts-store.js';
import type { TtsAudio, TtsService } from '../src/tts/provider.js';

const config: RuntimeConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 4100,
  appOrigin: 'http://localhost:3100',
};

const identity = { verify: async (authorization?: string) => authorization === 'Bearer worker-token' };

test('internal TTS route enriches an eligible durable event and stores the artifact', async () => {
  let stored = 0;
  const store: TtsStore = {
    async getEventInput(eventId) { return { eventId, message: 'Namaste', locale: 'hi-IN', enabled: true, eligible: true }; },
    async storeAudio() { stored += 1; return '00000000-0000-4000-8000-000000000099'; },
  };
  const audio: TtsAudio = { audioBase64: 'UklGRg==', mimeType: 'audio/wav', durationMs: 850, cacheKey: 'cache' };
  const service: TtsService = { async synthesize() { return { mode: 'audio', audio, cacheHit: false }; } };
  const app = await buildApp(config, { serviceIdentity: identity, ttsStore: store, tts: service });
  const response = await app.inject({
    method: 'POST',
    url: '/internal/v1/tts/events/00000000-0000-4000-8000-000000000001',
    headers: { authorization: 'Bearer worker-token' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'audio');
  assert.equal(stored, 1);
  await app.close();
});

test('TTS route returns safe chime outcome for ineligible events and rejects missing service identity', async () => {
  const store: TtsStore = {
    async getEventInput(eventId) { return { eventId, message: 'quiet', locale: 'en-IN', enabled: false, eligible: false }; },
    async storeAudio() { throw new Error('must not store'); },
  };
  const app = await buildApp(config, { serviceIdentity: identity, ttsStore: store, tts: { async synthesize() { throw new Error('must not call'); } } });
  const skipped = await app.inject({ method: 'POST', url: '/internal/v1/tts/events/00000000-0000-4000-8000-000000000001', headers: { authorization: 'Bearer worker-token' } });
  assert.equal(skipped.statusCode, 200);
  assert.equal(skipped.json().reason, 'not_eligible');
  const unauthorized = await app.inject({ method: 'POST', url: '/internal/v1/tts/events/00000000-0000-4000-8000-000000000001' });
  assert.equal(unauthorized.statusCode, 401);
  await app.close();
});

test('overlay audio requires the overlay bearer token and returns the scoped artifact bytes', async () => {
  const overlayAudio: OverlayAudioStore = {
    async read(token, overlayId, artifactId) {
      assert.equal(token, 'overlay-token');
      assert.equal(overlayId, '00000000-0000-4000-8000-000000000001');
      assert.equal(artifactId, '00000000-0000-4000-8000-000000000099');
      return { bytes: Buffer.from('RIFF'), mimeType: 'audio/wav', durationMs: 850 };
    },
  };
  const app = await buildApp(config, { overlayAudio });
  const unauthorized = await app.inject({ method: 'GET', url: '/v1/overlay-audio/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000099' });
  assert.equal(unauthorized.statusCode, 401);
  const response = await app.inject({
    method: 'GET',
    url: '/v1/overlay-audio/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000099',
    headers: { authorization: 'Bearer overlay-token' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'audio/wav');
  assert.equal(response.rawPayload.toString(), 'RIFF');
  await app.close();
});
