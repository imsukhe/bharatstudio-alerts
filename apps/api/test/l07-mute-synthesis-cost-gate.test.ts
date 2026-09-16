import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { registerTtsRoutes } from '../src/routes/tts.js';
import type { TtsStore } from '../src/domain/tts-store.js';
import type { TtsQuotaMeter } from '../src/domain/tts-quota.js';
import type { TtsAudio, TtsService } from '../src/tts/provider.js';

// This route only ever sees the "eligible" boolean 0103
// (app_private.get_alert_tts_input) now computes, folding in "does any
// fan-out queue for this event still want TTS" -- it has no queue/delivery
// context of its own (see 0103's migration header for why that SQL-side
// fix, not a route/interface change, is correct). These tests prove the
// route-level half of the cost gate: when the store reports eligible=false
// (which 0103 now also means for "every fan-out queue muted"), neither the
// quota meter nor the paid provider is ever reached -- so an all-muted
// event costs nothing and consumes no quota, exactly like every other
// not_eligible reason already did before this fix.
const EVENT_ID = '00000000-0000-4000-8000-00000000c001';
const identity = { verify: async (authorization?: string) => authorization === 'Bearer worker-token' };

const audio: TtsAudio = { audioBase64: 'UklGRg==', mimeType: 'audio/wav', durationMs: 850, cacheKey: 'cache' };

function storeWithEligibility(eligible: boolean): TtsStore {
  return {
    async getEventInput(eventId) { return { eventId, message: 'both queues muted', locale: 'en-IN', enabled: true, eligible }; },
    async storeAudio() {
      if (!eligible) throw new Error('must not store when ineligible');
      return '00000000-0000-4000-8000-00000000c099';
    },
  };
}

async function buildTtsApp(store: TtsStore, service: TtsService, quotaMeter?: TtsQuotaMeter) {
  const app = createTestFastify();
  await registerTtsRoutes(app, identity, store, service, quotaMeter);
  return app;
}

test('event whose entire fan-out is muted (eligible=false) never reaches the quota meter or the paid provider', async () => {
  let metered = false;
  let providerCalled = false;
  const meter: TtsQuotaMeter = { async meter() { metered = true; return { allowed: true, remaining: 100, reservationId: '00000000-0000-4000-8000-0000000000a1' }; }, async release() {} };
  const service: TtsService = { async synthesize() { providerCalled = true; return { mode: 'audio', audio, cacheHit: false }; } };
  const app = await buildTtsApp(storeWithEligibility(false), service, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.mode, 'chime');
  assert.equal(body.reason, 'not_eligible');
  assert.equal(metered, false, 'quota must not be metered for an event nobody could ever hear');
  assert.equal(providerCalled, false, 'paid provider must not be called for an event nobody could ever hear');
  await app.close();
});

test('event with at least one unmuted fan-out queue (eligible=true) meters quota and calls the provider exactly once', async () => {
  let meterCalls = 0;
  let providerCalls = 0;
  const meter: TtsQuotaMeter = { async meter() { meterCalls += 1; return { allowed: true, remaining: 100, reservationId: '00000000-0000-4000-8000-0000000000a1' }; }, async release() {} };
  const service: TtsService = { async synthesize() { providerCalls += 1; return { mode: 'audio', audio, cacheHit: false }; } };
  const app = await buildTtsApp(storeWithEligibility(true), service, meter);
  const response = await app.inject({ method: 'POST', url: `/internal/v1/tts/events/${EVENT_ID}`, headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'audio');
  assert.equal(meterCalls, 1);
  assert.equal(providerCalls, 1);
  await app.close();
});
