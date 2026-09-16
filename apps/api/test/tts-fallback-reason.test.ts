import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { registerTtsRoutes } from '../src/routes/tts.js';
import type { TtsStore } from '../src/domain/tts-store.js';
import type { TtsQuotaMeter } from '../src/domain/tts-quota.js';
import type { TtsAudio, TtsService } from '../src/tts/provider.js';

// MASTER-PLAN §10.3 item 5 — the overlay's browser/device TTS fallback only
// knows to engage because the route durably records WHY synthesis was
// skipped (TtsStore.storeFallbackReason -> migration 0096's
// app_private.store_alert_tts_fallback_reason). These tests prove that
// write-back happens for both denial reasons, never for a successful
// synthesis, and never touches the provider or (by construction — this
// store fake has no metering side effects) paid quota.
const EVENT_ID = '00000000-0000-4000-8000-000000000001';
const identity = { verify: async (authorization?: string) => authorization === 'Bearer worker-token' };

const audio: TtsAudio = { audioBase64: 'UklGRg==', mimeType: 'audio/wav', durationMs: 850, cacheKey: 'cache' };
const succeedingService: TtsService = { async synthesize() { return { mode: 'audio', audio, cacheHit: false }; } };

function storeWithFallbackRecorder(recorded: { eventId: string; reason: string }[]): TtsStore {
  return {
    async getEventInput(eventId) { return { eventId, message: 'Namaste', locale: 'hi-IN', enabled: true, eligible: true }; },
    async storeAudio() { throw new Error('must not store audio when quota denies'); },
    async storeFallbackReason(eventId, reason) { recorded.push({ eventId, reason }); },
  };
}

async function buildTtsApp(store: TtsStore, service: TtsService, quotaMeter?: TtsQuotaMeter) {
  const app = createTestFastify();
  await registerTtsRoutes(app, identity, store, service, quotaMeter);
  return app;
}

test('tier_not_entitled denial durably records the fallback reason', async () => {
  const recorded: { eventId: string; reason: string }[] = [];
  const meter: TtsQuotaMeter = { async meter() { return { allowed: false, reason: 'tier_not_entitled', remaining: 0 }; }, async release() {} };
  const app = await buildTtsApp(storeWithFallbackRecorder(recorded), succeedingService, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'chime');
  assert.deepEqual(recorded, [{ eventId: EVENT_ID, reason: 'tier_not_entitled' }]);
  await app.close();
});

test('quota_exhausted denial durably records the fallback reason', async () => {
  const recorded: { eventId: string; reason: string }[] = [];
  const meter: TtsQuotaMeter = { async meter() { return { allowed: false, reason: 'quota_exhausted', remaining: 0 }; }, async release() {} };
  const app = await buildTtsApp(storeWithFallbackRecorder(recorded), succeedingService, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'chime');
  assert.deepEqual(recorded, [{ eventId: EVENT_ID, reason: 'quota_exhausted' }]);
  await app.close();
});

test('a successful synthesis never records a fallback reason', async () => {
  const recorded: { eventId: string; reason: string }[] = [];
  const meter: TtsQuotaMeter = { async meter() { return { allowed: true, remaining: 99, reservationId: '00000000-0000-4000-8000-0000000000a1' }; }, async release() {} };
  const store: TtsStore = {
    async getEventInput(eventId) { return { eventId, message: 'Namaste', locale: 'hi-IN', enabled: true, eligible: true }; },
    async storeAudio() { return '00000000-0000-4000-8000-000000000099'; },
    async storeFallbackReason(eventId, reason) { recorded.push({ eventId, reason }); },
  };
  const app = await buildTtsApp(store, succeedingService, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'audio');
  assert.deepEqual(recorded, []);
  await app.close();
});

test('a store with no storeFallbackReason wired (back-compat) does not crash the denial path', async () => {
  const meter: TtsQuotaMeter = { async meter() { return { allowed: false, reason: 'tier_not_entitled', remaining: 0 }; }, async release() {} };
  const store: TtsStore = {
    async getEventInput(eventId) { return { eventId, message: 'Namaste', locale: 'hi-IN', enabled: true, eligible: true }; },
    async storeAudio() { throw new Error('must not store'); },
  };
  const app = await buildTtsApp(store, succeedingService, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'chime');
  await app.close();
});
