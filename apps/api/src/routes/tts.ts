import type { FastifyInstance } from 'fastify';
import type { ServiceIdentityVerifier } from '../domain/maintenance.js';
import type { TtsStore } from '../domain/tts-store.js';
import type { TtsQuotaMeter } from '../domain/tts-quota.js';
import type { TtsService } from '../tts/provider.js';
import type { ApiMetrics } from '../observability/metrics.js';

const eventParams = { type: 'object', additionalProperties: false, required: ['eventId'], properties: { eventId: { type: 'string', format: 'uuid' } } } as const;

// quotaMeter is optional so existing callers that have not wired it up yet
// keep working unmetered (defaults to allowing synthesis, matching prior
// behavior) rather than the route hard-failing — but a deployment that
// wants the §3.2 hard stop enforced MUST pass one. See §3.2/§10.3 item 4:
// nothing metered TTS spend before this.
export async function registerTtsRoutes(app: FastifyInstance, identity?: ServiceIdentityVerifier, store?: TtsStore, service?: TtsService, quotaMeter?: TtsQuotaMeter, metrics?: ApiMetrics): Promise<void> {
  app.post<{ Params: { eventId: string } }>('/internal/v1/tts/events/:eventId', { schema: { params: eventParams } }, async (request, reply) => {
    if (!identity || !await identity.verify(request.headers.authorization)) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Unauthorized', traceId: request.id });
    if (!store || !service) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'tts_unavailable', message: 'TTS is temporarily unavailable', traceId: request.id, retryable: true });
    const input = await store.getEventInput(request.params.eventId);
    if (!input || !input.enabled || !input.eligible || !input.message) return reply.code(200).send({ schemaVersion: 'v1', mode: 'chime', reason: 'not_eligible' });
    // Hard stop, checked (and, on success, atomically incremented) before any
    // paid provider call — a free-tier channel must never reach the
    // provider, and an exhausted channel must never be charged for another
    // synthesis. The alert itself still fires visual-only (mode: 'chime')
    // with a reason distinct from plain ineligibility, so the web/overlay
    // and dashboard can tell "not configured for TTS" apart from "TTS quota
    // exhausted, show the upgrade prompt" (§3.2 "Overage behaviour").
    // §19.0 RT-03 / RT-03.6: meter() settles this charge immediately, before
    // the provider call. reservedCharacters records what was just charged so
    // every synthesis-failure path below can release it back — a failed
    // synthesis must never consume premium characters (blocking acceptance
    // test, not an assumption).
    let reservedCharacters = 0;
    if (quotaMeter) {
      const quota = await quotaMeter.meter(input.eventId, input.message.length);
      if (!quota.allowed) {
        // §10.3 item 5: record why synthesis was skipped so the overlay can
        // fall back to the browser's own speech synthesis instead of going
        // silent. This is a durable write-back of the reason only — it never
        // touches alert_tts_usage_monthly, so a browser-voice fallback can
        // never consume paid quota.
        await store.storeFallbackReason?.(input.eventId, quota.reason);
        return reply.code(200).send({ schemaVersion: 'v1', mode: 'chime', reason: quota.reason, remaining: quota.remaining });
      }
      reservedCharacters = input.message.length;
    }
    // L09: a provider that throws, and a provider that answers "chime" because
    // it could not synthesize, are both TTS failures worth counting. Quota
    // exhaustion is NOT counted here — it is expected tier behaviour handled by
    // the hard stop above, not a fault, and counting it would make the failure
    // metric rise every time the product worked as designed.
    let result;
    try {
      result = await service.synthesize({ text: input.message, locale: input.locale, ...(input.voiceId ? { voiceId: input.voiceId } : {}), ...(input.model ? { model: input.model } : {}) });
    } catch (error) {
      metrics?.recordTtsFailure('provider_error');
      if (reservedCharacters > 0) await quotaMeter!.release(input.eventId, reservedCharacters);
      throw error;
    }
    if (result.mode === 'chime') {
      metrics?.recordTtsFailure('other');
      if (reservedCharacters > 0) await quotaMeter!.release(input.eventId, reservedCharacters);
      return reply.code(200).send({ schemaVersion: 'v1', mode: 'chime', reason: result.reason });
    }
    const artifactId = await store.storeAudio(input.eventId, result.audio);
    return reply.code(200).send({ schemaVersion: 'v1', mode: 'audio', artifactId, cacheHit: result.cacheHit });
  });
}
