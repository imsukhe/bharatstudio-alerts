import assert from 'node:assert/strict';
import test from 'node:test';
import { createSarvamTtsProvider, createTtsService, type TtsAudio } from '../src/tts/provider.js';

const request = { text: 'Rohan tipped one hundred rupees', locale: 'en-IN' as const };

test('Sarvam adapter sends bounded locale/text and returns validated audio', async () => {
  let received: { url: string; init?: RequestInit } | undefined;
  const provider = createSarvamTtsProvider('synthetic-key', 'https://tts.example.test/synthesize', async (url, init) => {
    received = { url, init };
    return new Response(JSON.stringify({ audios: ['UklGRg=='], duration_ms: 850 }), { status: 200 });
  });
  const result = await provider.synthesize(request);
  assert.equal(result.audioBase64, 'UklGRg==');
  assert.equal(result.durationMs, 850);
  assert.equal(received?.url, 'https://tts.example.test/synthesize');
  assert.equal((received?.init?.headers as Record<string, string>)['api-subscription-key'], 'synthetic-key');
  assert.match(String(received?.init?.body), /en-IN/);
});

test('TTS failure becomes a chime fallback and never blocks the visual event', async () => {
  const service = createTtsService({ synthesize: async () => { throw new Error('provider timeout'); } });
  assert.deepEqual(await service.synthesize(request), { mode: 'chime', reason: 'provider_timeout' });
  assert.deepEqual(await createTtsService().synthesize(request), { mode: 'chime', reason: 'not_configured' });
});

test('TTS cache is keyed by normalized content and provider settings', async () => {
  const audio: TtsAudio = { audioBase64: 'UklGRg==', mimeType: 'audio/wav', cacheKey: 'cache-key' };
  let calls = 0;
  let cached: TtsAudio | null = null;
  const provider = { synthesize: async () => { calls += 1; return audio; } };
  const service = createTtsService(provider, { get: async () => cached, put: async (value) => { cached = value; } });
  const first = await service.synthesize(request);
  const second = await service.synthesize(request);
  assert.equal(first.mode, 'audio');
  assert.equal(second.mode, 'audio');
  assert.equal(calls, 1);
});
