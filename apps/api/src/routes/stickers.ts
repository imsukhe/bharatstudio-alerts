import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import type { PublicStickerCatalogueStore, StickerCatalogueStore, StickerSelectionStore } from '../domain/sticker-catalogue.js';
import type { CreatorPackSelectionStore, CreatorPackStore, PublicCreatorPackStore } from '../domain/sticker-creator-pack.js';
import { validateCreatorPackUpload } from '../domain/sticker-creator-pack-validation.js';
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

const packStickerParams = { type: 'object', additionalProperties: false, required: ['channelId', 'packStickerId'], properties: { channelId: uuid, packStickerId: uuid } } as const;

const packUploadBody = {
  type: 'object', additionalProperties: false, required: ['displayName', 'category', 'renderDocument', 'creatorAttested'],
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 120 },
    category: { type: 'string', minLength: 1, maxLength: 60 },
    renderDocument: {},
    creatorAttested: { type: 'boolean' },
  },
} as const;

const packEnableBody = {
  type: 'object', additionalProperties: false, required: ['enabled'],
  properties: { enabled: { type: 'boolean' } },
} as const;

const packSelectionBody = {
  type: 'object', additionalProperties: false, required: ['orderId', 'packStickerId'],
  properties: { orderId: uuid, packStickerId: uuid },
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
 * NOT built here, on purpose: any endpoint reachable by an unauthenticated
 * viewer that accepts sticker bytes from a request body. The two public
 * routes below (list-for-viewer + attach-to-tip, for both the platform
 * catalogue and creator packs) only ever resolve an id server-side — a
 * viewer never uploads. See migration 0110/sticker-import-validation.ts
 * for the platform catalogue's one legitimate way to add an entry.
 *
 * L22 gap-fill (migration 0119): this file also registers three
 * AUTHENTICATED, owner/admin-only creator-pack routes — including the one
 * endpoint in this whole feature that accepts asset bytes in a request
 * body (POST .../sticker-pack). That is CREATOR upload, not viewer
 * upload: gated by requireAuthAndTerms, re-gated server-side by
 * app_private.import_creator_pack_sticker's has_channel_role check, and
 * every byte passes validateCreatorPackUpload (which routes through the
 * same asset-scan-pipeline.ts the platform catalogue uses) before the
 * store is ever called. This is the exact creator-supplied-vs-viewer-
 * supplied distinction migration 0110's header documents — it does not
 * change on this file's side of that line.
 */
export async function registerStickerRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: StickerCatalogueStore,
  account?: AccountStore,
  publicStore?: PublicStickerCatalogueStore,
  selections?: StickerSelectionStore,
  creatorPack?: CreatorPackStore,
  publicCreatorPack?: PublicCreatorPackStore,
  creatorPackSelections?: CreatorPackSelectionStore,
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

  // ---------------------------------------------------------------------
  // L22 gap-fill: creator-approved packs (migration 0119). Owner/admin
  // uploads only — validateCreatorPackUpload runs the same shared
  // structural walk as the platform catalogue
  // (asset-scan-pipeline.ts/sticker-import-validation.ts) before any
  // bytes reach the store; app_private.import_creator_pack_sticker
  // re-checks size/shape/tier/quota/attestation server-side anyway. There
  // is still no endpoint anywhere in this file that lets a viewer supply
  // an asset — a viewer only ever selects an id from this already-
  // uploaded, already-validated, already-reviewed set.
  // ---------------------------------------------------------------------

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/sticker-pack', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!creatorPack || !request.auth) return unavailable(reply, request.id);
    try {
      const items = await creatorPack.listForChannel(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    } catch (error) {
      logSafeError(request, 'creator_pack_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{ Params: { channelId: string }; Body: { displayName: string; category: string; renderDocument: unknown; creatorAttested: boolean } }>('/v1/channels/:channelId/sticker-pack', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: packUploadBody },
  }, async (request, reply) => {
    if (!creatorPack || !request.auth) return unavailable(reply, request.id);
    const validation = validateCreatorPackUpload(request.body);
    if (!validation.ok) {
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_creator_pack_asset', message: validation.reason, traceId: request.id });
    }
    try {
      const result = await creatorPack.upload(
        request.auth.userId, request.params.channelId,
        request.body.displayName, request.body.category, validation.assetBytes, request.body.creatorAttested,
      );
      switch (result.outcome) {
        case 'created': return reply.code(201).send({ schemaVersion: 'v1', id: result.id, status: result.status });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'tier_not_eligible': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'creator_pack_not_available', message: 'Creator packs are not available at your current tier', traceId: request.id });
        case 'attestation_required': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'attestation_required', message: 'Confirm you hold the rights to this asset before uploading', traceId: request.id });
        case 'limit_reached': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'creator_pack_limit_reached', message: 'Your creator pack is full for your current tier', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_creator_pack_asset', message: result.reason, traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'creator_pack_upload_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'sticker_store_unavailable', message: 'The pack sticker could not be uploaded', traceId: request.id, retryable: true });
    }
  });

  app.patch<{ Params: { channelId: string; packStickerId: string }; Body: { enabled: boolean } }>('/v1/channels/:channelId/sticker-pack/:packStickerId', {
    preHandler: termsAuth,
    schema: { params: packStickerParams, body: packEnableBody },
  }, async (request, reply) => {
    if (!creatorPack || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await creatorPack.setEnabled(request.auth.userId, request.params.channelId, request.params.packStickerId, request.body.enabled);
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', id: request.params.packStickerId, enabled: result.enabled });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Pack sticker not found', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'creator_pack_enable_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'sticker_store_unavailable', message: 'The pack sticker setting could not be updated', traceId: request.id, retryable: true });
    }
  });

  // Public/unauthenticated — the tip page's creator-pack sticker picker.
  app.get<{ Params: { channelId: string } }>('/v1/public/channels/:channelId/sticker-pack', {
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!publicCreatorPack) return unavailable(reply, request.id);
    try {
      const items = await publicCreatorPack.listEnabledForChannel(request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    } catch (error) {
      logSafeError(request, 'public_creator_pack_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // Public/unauthenticated — attaches a creator-pack sticker to an
  // already-paid tip order. Independent of the catalogue selection route
  // above; the two coexist without shadowing each other (migration
  // 0119's header).
  app.post<{ Params: { channelId: string }; Body: { orderId: string; packStickerId: string } }>('/v1/public/channels/:channelId/sticker-pack/selections', {
    schema: { params: channelParams, body: packSelectionBody },
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!creatorPackSelections) return unavailable(reply, request.id);
    try {
      const result = await creatorPackSelections.attach(request.params.channelId, request.body.orderId, request.body.packStickerId);
      switch (result.outcome) {
        case 'attached': return reply.code(201).send({ schemaVersion: 'v1', selectionId: result.selectionId, packStickerId: request.body.packStickerId });
        case 'unknown_order': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Tip order not found', traceId: request.id });
        case 'order_not_paid': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'order_not_paid', message: 'This tip has not completed yet', traceId: request.id });
        case 'unknown_pack_sticker': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'unknown_sticker', message: 'That pack sticker does not exist', traceId: request.id });
        case 'not_available': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'sticker_not_available', message: 'That pack sticker is not available on this channel', traceId: request.id });
        case 'already_attached': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'sticker_already_attached', message: 'A creator-pack sticker is already attached to this tip', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'creator_pack_attach_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'sticker_store_unavailable', message: 'The pack sticker could not be attached', traceId: request.id, retryable: true });
    }
  });
}
