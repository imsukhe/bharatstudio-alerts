import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TTS_PLAYBACK_TIMEOUT_MS, playAudioWithTimeout } from './tts-runtime';

test('returns success when audio playback starts before the timeout', async () => {
  let paused = 0;
  const result = await playAudioWithTimeout({ play: async () => undefined, pause: () => { paused += 1; } }, 10);
  assert.equal(result, true);
  assert.equal(paused, 0);
});

test('returns failure when the provider/browser playback rejects', async () => {
  const result = await playAudioWithTimeout({ play: async () => { throw new Error('provider_unavailable'); }, pause: () => undefined }, 10);
  assert.equal(result, false);
});

test('pauses and returns failure when playback is stuck past the hard timeout', async () => {
  let paused = 0;
  const result = await playAudioWithTimeout({
    play: () => new Promise<void>(() => undefined),
    pause: () => { paused += 1; },
  }, 1);
  assert.equal(result, false);
  assert.equal(paused, 1);
  assert.equal(DEFAULT_TTS_PLAYBACK_TIMEOUT_MS, 1500);
});
