import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerTtsRoutes } from '../src/routes/tts.js';
import type { TtsStore } from '../src/domain/tts-store.js';
import type { TtsQuotaMeter } from '../src/domain/tts-quota.js';
import type { TtsAudio, TtsService } from '../src/tts/provider.js';

// These exercise registerTtsRoutes directly (not via buildApp/app.ts, which
// this task does not own) so the quota-meter wiring can be proven in
// isolation. The eventId is a fixed valid UUID; getEventInput/meter are
// fakes, so no real event needs to exist for these route-level tests.
const EVENT_ID = '00000000-0000-4000-8000-000000000001';
const identity = { verify: async (authorization?: string) => authorization === 'Bearer worker-token' };

function eligibleStore(message = 'Namaste'): TtsStore {
  return {
    async getEventInput(eventId) { return { eventId, message, locale: 'hi-IN', enabled: true, eligible: true }; },
    async storeAudio() { return '00000000-0000-4000-8000-000000000099'; },
  };
}

const audio: TtsAudio = { audioBase64: 'UklGRg==', mimeType: 'audio/wav', durationMs: 850, cacheKey: 'cache' };
const succeedingService: TtsService = { async synthesize() { return { mode: 'audio', audio, cacheHit: false }; } };

async function buildTtsApp(store: TtsStore, service: TtsService, quotaMeter?: TtsQuotaMeter) {
  const app = Fastify();
  await registerTtsRoutes(app, identity, store, service, quotaMeter);
  return app;
}

test('free tier (tier_not_entitled) never reaches the paid provider', async () => {
  let providerCalled = false;
  const service: TtsService = { async synthesize() { providerCalled = true; return { mode: 'audio', audio, cacheHit: false }; } };
  const meter: TtsQuotaMeter = { async meter() { return { allowed: false, reason: 'tier_not_entitled', remaining: 0 }; } };
  const app = await buildTtsApp(eligibleStore(), service, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.mode, 'chime');
  assert.equal(body.reason, 'tier_not_entitled');
  assert.equal(providerCalled, false);
  await app.close();
});

test('quota exhaustion is a distinguishable refusal, distinct from plain ineligibility, before the provider call', async () => {
  let providerCalled = false;
  const service: TtsService = { async synthesize() { providerCalled = true; return { mode: 'audio', audio, cacheHit: false }; } };
  const meter: TtsQuotaMeter = { async meter() { return { allowed: false, reason: 'quota_exhausted', remaining: 0 }; } };
  const app = await buildTtsApp(eligibleStore(), service, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.mode, 'chime');
  assert.equal(body.reason, 'quota_exhausted');
  assert.notEqual(body.reason, 'not_eligible');
  assert.equal(providerCalled, false);
  await app.close();
});

test('within quota: provider is called and the meter is fed the message length', async () => {
  let meteredChars = 0;
  const meter: TtsQuotaMeter = { async meter(_eventId, characterCount) { meteredChars = characterCount; return { allowed: true, remaining: 42 }; } };
  const app = await buildTtsApp(eligibleStore('Namaste duniya'), succeedingService, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'audio');
  assert.equal(meteredChars, 'Namaste duniya'.length);
  await app.close();
});

test('no quota meter configured falls back to unmetered behavior (back-compat), not a hard failure', async () => {
  const app = await buildTtsApp(eligibleStore(), succeedingService, undefined);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'audio');
  await app.close();
});

test('ineligible events never reach the quota meter or provider', async () => {
  let meterCalled = false;
  const store: TtsStore = {
    async getEventInput(eventId) { return { eventId, message: 'quiet', locale: 'en-IN', enabled: false, eligible: false }; },
    async storeAudio() { throw new Error('must not store'); },
  };
  const meter: TtsQuotaMeter = { async meter() { meterCalled = true; return { allowed: true, remaining: 1 }; } };
  const service: TtsService = { async synthesize() { throw new Error('must not call'); } };
  const app = await buildTtsApp(store, service, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().reason, 'not_eligible');
  assert.equal(meterCalled, false);
  await app.close();
});
