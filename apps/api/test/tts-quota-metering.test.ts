import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { registerTtsRoutes } from '../src/routes/tts.js';
import type { TtsStore } from '../src/domain/tts-store.js';
import type { TtsQuotaMeter } from '../src/domain/tts-quota.js';
import type { TtsAudio, TtsService } from '../src/tts/provider.js';

// These exercise registerTtsRoutes directly (not via buildApp/app.ts, which
// this task does not own) so the quota-meter wiring can be proven in
// isolation. The eventId is a fixed valid UUID; getEventInput/meter are
// fakes, so no real event needs to exist for these route-level tests.
const EVENT_ID = '00000000-0000-4000-8000-000000000001';
// §19.0 RT-03 correction 2026-09-16 (migration 0134): release consumes the
// reservation id the meter returned, never a character count. The count is
// recorded on the reservation row itself, which is what makes a double
// release a no-op and makes a release land on the month it was charged to.
const RESERVATION_ID = '00000000-0000-4000-8000-0000000000a1';
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
  const app = createTestFastify();
  await registerTtsRoutes(app, identity, store, service, quotaMeter);
  return app;
}

test('free tier (tier_not_entitled) never reaches the paid provider', async () => {
  let providerCalled = false;
  const service: TtsService = { async synthesize() { providerCalled = true; return { mode: 'audio', audio, cacheHit: false }; } };
  const meter: TtsQuotaMeter = { async meter() { return { allowed: false, reason: 'tier_not_entitled', remaining: 0 }; }, async release() {} };
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
  const meter: TtsQuotaMeter = { async meter() { return { allowed: false, reason: 'quota_exhausted', remaining: 0 }; }, async release() {} };
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
  const meter: TtsQuotaMeter = { async meter(_eventId, characterCount) { meteredChars = characterCount; return { allowed: true, remaining: 42, reservationId: RESERVATION_ID }; }, async release() {} };
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
  const meter: TtsQuotaMeter = { async meter() { meterCalled = true; return { allowed: true, remaining: 1, reservationId: RESERVATION_ID }; }, async release() {} };
  const service: TtsService = { async synthesize() { throw new Error('must not call'); } };
  const app = await buildTtsApp(store, service, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().reason, 'not_eligible');
  assert.equal(meterCalled, false);
  await app.close();
});

// §19.0 RT-03.6 — a blocking acceptance test: a failed synthesis must never
// consume premium characters. These prove the route releases exactly the
// reservation the meter created on every synthesis-failure path, and never on
// a path where nothing was reserved or synthesis actually succeeded.

test('a successful synthesis never releases the just-reserved characters', async () => {
  let releaseCalls = 0;
  const meter: TtsQuotaMeter = { async meter() { return { allowed: true, remaining: 42, reservationId: RESERVATION_ID }; }, async release() { releaseCalls += 1; } };
  const app = await buildTtsApp(eligibleStore('Namaste duniya'), succeedingService, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'audio');
  assert.equal(releaseCalls, 0);
  await app.close();
});

test('a denied reservation (quota exhausted) never calls release — nothing was reserved', async () => {
  let releaseCalls = 0;
  const meter: TtsQuotaMeter = { async meter() { return { allowed: false, reason: 'quota_exhausted', remaining: 0 }; }, async release() { releaseCalls += 1; } };
  const app = await buildTtsApp(eligibleStore(), succeedingService, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'chime');
  assert.equal(releaseCalls, 0);
  await app.close();
});

test('a provider chime-mode failure releases exactly the reservation the meter created', async () => {
  let released: string | undefined;
  const meter: TtsQuotaMeter = {
    async meter() { return { allowed: true, remaining: 42, reservationId: RESERVATION_ID }; },
    async release(reservationId) { released = reservationId; },
  };
  const failingService: TtsService = { async synthesize() { return { mode: 'chime', reason: 'provider_failure' }; } };
  const app = await buildTtsApp(eligibleStore('Namaste duniya'), failingService, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'chime');
  assert.equal(released, RESERVATION_ID);
  await app.close();
});

test('a provider throw releases exactly the reservation the meter created, before the error propagates', async () => {
  let released: string | undefined;
  const meter: TtsQuotaMeter = {
    async meter() { return { allowed: true, remaining: 42, reservationId: RESERVATION_ID }; },
    async release(reservationId) { released = reservationId; },
  };
  const throwingService: TtsService = { async synthesize() { throw new Error('synthetic provider throw'); } };
  const app = await buildTtsApp(eligibleStore('Namaste duniya'), throwingService, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 500);
  assert.equal(released, RESERVATION_ID);
  await app.close();
});

// Owner decision 2026-09-16: cached audio costs no premium characters. The
// platform pays nothing for a cache hit (createTtsService answers it out of
// alert_tts_cache without reaching the provider), so neither should the
// creator. The hard stop still runs first and against the real character
// count, so an exhausted channel cannot mine the cache for free synthesis.
test('a cache hit releases the metered characters, so cached audio is free', async () => {
  const released: string[] = [];
  let metered = 0;
  const quotaMeter: TtsQuotaMeter = {
    async meter(_eventId, characterCount) { metered += characterCount; return { allowed: true, remaining: 1_000, reservationId: RESERVATION_ID }; },
    async release(reservationId) { released.push(reservationId); },
  };
  const cachedService: TtsService = { async synthesize() { return { mode: 'audio', audio, cacheHit: true }; } };
  const app = await buildTtsApp(eligibleStore('Namaste'), cachedService, quotaMeter);

  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'audio', 'a cache hit still delivers audio');
  assert.equal(response.json().cacheHit, true);
  assert.equal(metered, 'Namaste'.length, 'the hard stop still meters the real character count first');
  assert.deepEqual(released, [RESERVATION_ID], 'and the charge is given straight back');
  await app.close();
});

test('a genuine synthesis (no cache hit) keeps its charge', async () => {
  const released: string[] = [];
  const quotaMeter: TtsQuotaMeter = {
    async meter() { return { allowed: true, remaining: 1_000, reservationId: RESERVATION_ID }; },
    async release(reservationId) { released.push(reservationId); },
  };
  const app = await buildTtsApp(eligibleStore('Namaste'), succeedingService, quotaMeter);

  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().cacheHit, false);
  assert.deepEqual(released, [], 'audio the provider actually synthesised is charged');
  await app.close();
});
