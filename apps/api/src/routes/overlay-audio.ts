import type { FastifyInstance } from 'fastify';
import type { OverlayAudioStore } from '../domain/overlay-audio-store.js';

const uuid = { type: 'string', format: 'uuid' } as const;

export async function registerOverlayAudioRoutes(app: FastifyInstance, store?: OverlayAudioStore): Promise<void> {
  app.get<{ Params: { overlayId: string; artifactId: string }; Headers: { authorization?: string } }>('/v1/overlay-audio/:overlayId/:artifactId', {
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['overlayId', 'artifactId'], properties: { overlayId: uuid, artifactId: uuid } },
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!store || !token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Overlay audio is not available', traceId: request.id });
    const audio = await store.read(token, request.params.overlayId, request.params.artifactId);
    if (!audio) return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Overlay audio not found', traceId: request.id });
    reply.header('cache-control', 'private, no-store');
    reply.header('content-type', audio.mimeType);
    return reply.send(audio.bytes);
  });
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1];
}
