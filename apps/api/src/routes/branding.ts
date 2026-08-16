import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import { displayStyles, type BrandingStore, type DisplayStyle } from '../domain/branding.js';
import { validateLottieDocument } from '../domain/lottie-validation.js';
import { logSafeError } from '../observability/safe-log.js';

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;
const assetParams = { type: 'object', additionalProperties: false, required: ['channelId', 'displayStyle'], properties: { channelId: { type: 'string', format: 'uuid' }, displayStyle: { type: 'string', enum: [...displayStyles] } } } as const;

// A raw Lottie document can legitimately approach the 2,000,000-byte
// storage cap; Fastify's app-wide 64 KB bodyLimit (app.ts) exists for
// every other JSON route and is deliberately overridden only here.
const LOTTIE_UPLOAD_BODY_LIMIT = 2_200_000;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'branding_store_unavailable', message: 'Branding data is temporarily unavailable', traceId, retryable: true });
}

export async function registerBrandingRoutes(app: FastifyInstance, sessions?: SessionStore, store?: BrandingStore, account?: AccountStore): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/branding/lottie', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const items = await store.listAssets(request.auth.userId, request.params.channelId);
    return reply.code(200).send({ schemaVersion: 'v1', items });
  });

  app.put<{ Params: { channelId: string; displayStyle: DisplayStyle }; Body: unknown }>('/v1/channels/:channelId/branding/lottie/:displayStyle', {
    preHandler: termsAuth,
    bodyLimit: LOTTIE_UPLOAD_BODY_LIMIT,
    schema: { params: assetParams, body: { type: 'object' } },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const validation = validateLottieDocument(request.body);
    if (!validation.ok) {
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_lottie_document', message: validation.reason, traceId: request.id });
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(JSON.stringify(request.body), 'utf8');
    } catch {
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_lottie_document', message: 'The document could not be serialized', traceId: request.id });
    }
    if (bytes.byteLength > 2_000_000) {
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'lottie_too_large', message: 'The animation must be 2,000,000 bytes or smaller', traceId: request.id });
    }
    try {
      const result = await store.storeAsset(request.auth.userId, request.params.channelId, request.params.displayStyle, bytes);
      switch (result.outcome) {
        case 'stored': return reply.code(200).send({ schemaVersion: 'v1', displayStyle: request.params.displayStyle, artifactId: result.artifactId });
        case 'tier_required': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'studio_tier_required', message: 'Custom branding requires the Studio tier', traceId: request.id });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_lottie_document', message: 'The document could not be stored', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'lottie_asset_store_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'branding_store_unavailable', message: 'The animation could not be stored', traceId: request.id, retryable: true });
    }
  });

  app.delete<{ Params: { channelId: string; displayStyle: DisplayStyle } }>('/v1/channels/:channelId/branding/lottie/:displayStyle', {
    preHandler: termsAuth,
    schema: { params: assetParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const deleted = await store.deleteAsset(request.auth.userId, request.params.channelId, request.params.displayStyle);
    return deleted
      ? reply.code(204).send()
      : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Custom animation not found', traceId: request.id });
  });
}
