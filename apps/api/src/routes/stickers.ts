import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import type { PublicStickerCatalogueStore, StickerCatalogueStore, StickerSelectionStore } from '../domain/sticker-catalogue.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const stickerParams = { type: 'object', additionalProperties: false, required: ['channelId', 'stickerId'], properties: { channelId: uuid, stickerId: uuid } } as const;

const enableBody = {
  type: 'object', additionalProperties: false, required: ['enabled'],
  properties: { enabled: { type: 'boolean' } },
} as const;

const selectionBody = {
  type: 'object', additionalProperties: false, required: ['orderId', 'stickerId'],
  properties: { orderId: uuid, stickerId: uuid },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'sticker_store_unavailable', message: 'Stickers are temporarily unavailable', traceId, retryable: true });
}

/**
 * L22 — curated sticker catalogue routes. Two authenticated creator
 * endpoints (list + enable/disable, role-gated by the underlying
 * security-definer functions) and two public/unauthenticated endpoints
 * (list-for-viewer + attach-to-tip) — the latter pair follows
 * routes/public.ts's own shape (no session, all scoping inside the SQL
 * function) but lives entirely in this file, so registering it needs no
 * edit to routes/public.ts or app.ts beyond calling this function. See
 * buildApp composes the stores from the SQL runtime when available.
 *
 * NOT built here, on purpose: any endpoint that accepts sticker bytes from
 * a request body. A sticker id is always resolved against the catalogue
 * server-side (attach.ts's store never receives or stores an asset) — see
 * migration 0110 and sticker-import-validation.ts for where the one
 * legitimate way to add a catalogue entry lives.
 */
export async function registerStickerRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: StickerCatalogueStore,
  account?: AccountStore,
  publicStore?: PublicStickerCatalogueStore,
  selections?: StickerSelectionStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/stickers', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const items = await store.listForChannel(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    } catch (error) {
      logSafeError(request, 'sticker_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.patch<{ Params: { channelId: string; stickerId: string }; Body: { enabled: boolean } }>('/v1/channels/:channelId/stickers/:stickerId', {
    preHandler: termsAuth,
    schema: { params: stickerParams, body: enableBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.setEnabled(request.auth.userId, request.params.channelId, request.params.stickerId, request.body.enabled);
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', stickerId: request.params.stickerId, enabled: result.enabled });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Sticker not found', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'sticker_enable_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'sticker_store_unavailable', message: 'The sticker setting could not be updated', traceId: request.id, retryable: true });
    }
  });

  // Public/unauthenticated — the tip page's sticker picker.
  app.get<{ Params: { channelId: string } }>('/v1/public/channels/:channelId/stickers', {
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!publicStore) return unavailable(reply, request.id);
    try {
      const items = await publicStore.listEnabledForChannel(request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    } catch (error) {
      logSafeError(request, 'public_sticker_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // Public/unauthenticated — attaches a sticker to an already-paid tip
  // order. The sticker id is re-validated server-side against the
  // channel's live enabled+tier-eligible set inside
  // app_private.attach_sticker_to_tip; an unknown/disabled/ineligible id
  // is rejected with a 4xx, never silently dropped.
  app.post<{ Params: { channelId: string }; Body: { orderId: string; stickerId: string } }>('/v1/public/channels/:channelId/stickers/selections', {
    schema: { params: channelParams, body: selectionBody },
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!selections) return unavailable(reply, request.id);
    try {
      const result = await selections.attach(request.params.channelId, request.body.orderId, request.body.stickerId);
      switch (result.outcome) {
        case 'attached': return reply.code(201).send({ schemaVersion: 'v1', selectionId: result.selectionId, stickerId: request.body.stickerId });
        case 'unknown_order': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Tip order not found', traceId: request.id });
        case 'order_not_paid': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'order_not_paid', message: 'This tip has not completed yet', traceId: request.id });
        case 'unknown_sticker': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'unknown_sticker', message: 'That sticker does not exist', traceId: request.id });
        case 'not_available': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'sticker_not_available', message: 'That sticker is not available on this channel', traceId: request.id });
        case 'already_attached': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'sticker_already_attached', message: 'A sticker is already attached to this tip', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'sticker_attach_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'sticker_store_unavailable', message: 'The sticker could not be attached', traceId: request.id, retryable: true });
    }
  });
}
