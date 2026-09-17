import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import {
  QR_SMART_CARD_TEXT_MAX_LENGTH,
  QR_SMART_CARD_TEXT_MIN_LENGTH,
  type QrSmartCardStore,
} from '../domain/qr-smart-card-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;

// The 1-120 bound, taken from the domain constants rather than retyped
// -- themselves migration 0109 line 67's already-decided challenge-title
// bound, reused per the owner's 2026-09-17 decision (§6 module #10).
//
// `additionalProperties: false` is load-bearing: a body carrying a scan
// count, an allow-list, a short-link flag or a scene id is a 400 at the
// schema layer, before the store is ever called -- this module holds no
// such concept and this is where that is enforced on the wire.
const upsertBody = {
  type: 'object', additionalProperties: false, required: ['destination', 'label'],
  properties: {
    destination: { type: 'string', minLength: QR_SMART_CARD_TEXT_MIN_LENGTH, maxLength: QR_SMART_CARD_TEXT_MAX_LENGTH },
    label: { type: 'string', minLength: QR_SMART_CARD_TEXT_MIN_LENGTH, maxLength: QR_SMART_CARD_TEXT_MAX_LENGTH },
  },
} as const;

// The single toggle the owner decision names. Nothing else is settable
// through this route.
//
// `enum: [true, false]`, NOT `type: 'boolean'` -- the same fix
// routes/safe-mode.ts's own `setBody` already carries, for the same
// measured reason: this API's shared AJV configuration coerces types,
// so a bare `type: 'boolean'` would accept `"true"`/`"false"` strings
// (and coerce other truthy/falsy values) rather than rejecting them.
// `enum` declares the two allowed VALUES instead of a type, so nothing
// is silently turned into a switch position.
const enabledBody = {
  type: 'object', additionalProperties: false, required: ['enabled'],
  properties: { enabled: { enum: [true, false] } },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'qr_smart_card_store_unavailable', message: 'The QR smart card is temporarily unavailable', traceId, retryable: true });
}

// PRF-02 slice 7: §6 catalogue module #10, QR Smart Card. Two route
// groups, mirroring routes/stream-mission.ts exactly:
//   - creator-facing (session auth): read the current card, set the
//     destination/label, toggle visibility. Never tier-gated -- §12.6:
//     storing, viewing and exporting a durable creator record is
//     available at every tier. The §30.3 module cap (migration 0131,
//     'qr_smart_card' already one of its twenty catalogue keys) gates
//     only whether the Canvas RENDERS the card, and there is no second
//     tier gate anywhere in this file.
//   - overlay-facing (bearer overlay-session token, browser-source-
//     shaped): registered in routes/master-canvas.ts alongside every
//     other module's overlay read, not here -- this file owns only the
//     creator-facing CRUD surface, the same structural split
//     routes/lobby-session.ts and routes/safe-mode.ts already have
//     relative to their own overlay reads in master-canvas.ts.
export async function registerQrSmartCardRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: QrSmartCardStore,
  account?: AccountStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/qr-smart-card', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const card = await store.getCurrent(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', card });
    } catch (error) {
      logSafeError(request, 'qr_smart_card_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // Upsert: creates the card on first call, updates destination/label on
  // every later call. Never touches is_enabled either way -- two
  // independent writes for two independent decisions (migration 0144's
  // header).
  app.put<{ Params: { channelId: string }; Body: { destination: string; label: string } }>('/v1/channels/:channelId/qr-smart-card', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: upsertBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.upsert(request.auth.userId, request.params.channelId, request.body.destination, request.body.label);
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', card: result.card });
        // Non-owner/admin. Mapped to 404, never a leaking 403 -- the
        // same mapping master-canvas.ts and routes/stream-mission.ts
        // already use.
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_qr_smart_card', message: 'The QR smart card could not be saved', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'qr_smart_card_upsert_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'qr_smart_card_store_unavailable', message: 'The QR smart card could not be saved', traceId: request.id, retryable: true });
    }
  });

  // The single toggle. Never creates a card -- see migration 0144's
  // header: toggling before a destination/label has been set is a
  // not-found, never an implicit create.
  app.put<{ Params: { channelId: string }; Body: { enabled: boolean } }>('/v1/channels/:channelId/qr-smart-card/enabled', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: enabledBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.setEnabled(request.auth.userId, request.params.channelId, request.body.enabled);
      if (result.outcome === 'not_found') {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'QR smart card not found', traceId: request.id });
      }
      return reply.code(200).send({ schemaVersion: 'v1', card: result.card });
    } catch (error) {
      logSafeError(request, 'qr_smart_card_toggle_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'qr_smart_card_store_unavailable', message: 'The QR smart card could not be updated', traceId: request.id, retryable: true });
    }
  });
}
