import type { FastifyInstance } from 'fastify';
import type { OverlayBrandingStore } from '../domain/branding.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1];
}

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'overlay_branding_unavailable', message: 'Overlay branding is temporarily unavailable', traceId, retryable: true });
}

// Mirrors overlay-audio.ts's auth pattern exactly: no preHandler (deliberately
// outside the session-cookie auth chain — the overlay browser source has
// only its own scoped bearer token), token fingerprinted server-side, all
// channel/tier scoping enforced inside the security-definer functions
// these read from.
export async function registerOverlayLottieRoutes(app: FastifyInstance, store?: OverlayBrandingStore): Promise<void> {
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-lottie/:overlayId', {
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['overlayId'], properties: { overlayId: uuid } },
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Overlay branding is not available', traceId: request.id });
    if (!store) return unavailable(reply, request.id);
    try {
      const items = await store.listForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    } catch (error) {
      logSafeError(request, 'overlay_lottie_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.get<{ Params: { overlayId: string; artifactId: string }; Headers: { authorization?: string } }>('/v1/overlay-lottie/:overlayId/:artifactId', {
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['overlayId', 'artifactId'], properties: { overlayId: uuid, artifactId: uuid } },
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Overlay branding is not available', traceId: request.id });
    if (!store) return unavailable(reply, request.id);
    try {
      const asset = await store.getForOverlay(token, request.params.overlayId, request.params.artifactId);
      if (!asset) return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Custom animation not found', traceId: request.id });
      reply.header('cache-control', 'private, no-store');
      reply.header('content-type', asset.mimeType);
      return reply.send(asset.bytes);
    } catch (error) {
      logSafeError(request, 'overlay_lottie_read_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
