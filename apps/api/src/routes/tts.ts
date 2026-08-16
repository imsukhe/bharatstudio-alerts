import type { FastifyInstance } from 'fastify';
import type { ServiceIdentityVerifier } from '../domain/maintenance.js';
import type { TtsStore } from '../domain/tts-store.js';
import type { TtsService } from '../tts/provider.js';

const eventParams = { type: 'object', additionalProperties: false, required: ['eventId'], properties: { eventId: { type: 'string', format: 'uuid' } } } as const;

export async function registerTtsRoutes(app: FastifyInstance, identity?: ServiceIdentityVerifier, store?: TtsStore, service?: TtsService): Promise<void> {
  app.post<{ Params: { eventId: string } }>('/internal/v1/tts/events/:eventId', { schema: { params: eventParams } }, async (request, reply) => {
    if (!identity || !await identity.verify(request.headers.authorization)) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Unauthorized', traceId: request.id });
    if (!store || !service) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'tts_unavailable', message: 'TTS is temporarily unavailable', traceId: request.id, retryable: true });
    const input = await store.getEventInput(request.params.eventId);
    if (!input || !input.enabled || !input.eligible || !input.message) return reply.code(200).send({ schemaVersion: 'v1', mode: 'chime', reason: 'not_eligible' });
    const result = await service.synthesize({ text: input.message, locale: input.locale, ...(input.voiceId ? { voiceId: input.voiceId } : {}), ...(input.model ? { model: input.model } : {}) });
    if (result.mode === 'chime') return reply.code(200).send({ schemaVersion: 'v1', mode: 'chime', reason: result.reason });
    const artifactId = await store.storeAudio(input.eventId, result.audio);
    return reply.code(200).send({ schemaVersion: 'v1', mode: 'audio', artifactId, cacheHit: result.cacheHit });
  });
}
