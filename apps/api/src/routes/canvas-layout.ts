import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import type { CanvasLayoutStore } from '../domain/canvas-layout-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;

// `enum: ['horizontal', 'vertical']`, NOT `type: 'string'` -- the same
// fix routes/qr-smart-card.ts's own `enabledBody` and routes/safe-
// mode.ts's own `setBody` already carry, for the same measured reason:
// this API's shared AJV configuration coerces types, so a bare
// `type: 'string'` would accept any string rather than exactly these two
// values. `additionalProperties: false` is load-bearing too: a body
// carrying a variant id, an aspect ratio or a scene reference is a 400
// at the schema layer -- this setting holds no such concept (this
// task's own scope: "one fixed 9:16 arrangement. No variant selection,
// no variant system" -- that is CST-08, Phase 2).
const setBody = {
  type: 'object', additionalProperties: false, required: ['layout'],
  properties: { layout: { enum: ['horizontal', 'vertical'] } },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'canvas_layout_store_unavailable', message: 'The canvas layout is temporarily unavailable', traceId, retryable: true });
}

// PRF-02 slice 7, §6 module #14 (Vertical Stream Layout). A LAYOUT IS
// NOT A MODULE (migration 0147's header) -- this is deliberately its
// own route file, not part of routes/master-canvas.ts's module list/
// upsert pair, and it consumes no §30.3 cap slot. Two route groups,
// mirroring routes/qr-smart-card.ts exactly:
//   - creator-facing (session auth): read the configured layout and
//     whether vertical currently renders; set the layout. Never
//     tier-gated (§12.6) -- storing the preference is available at
//     every tier; only whether the overlay RENDERS vertical is gated,
//     and that gate lives in exactly one place,
//     app_private.list_overlay_canvas_layout, never duplicated here.
//   - overlay-facing (bearer overlay-session token, browser-source-
//     shaped): registered in routes/master-canvas.ts alongside every
//     other module's overlay read, not here -- this file owns only the
//     creator-facing read/write surface, the same structural split
//     routes/qr-smart-card.ts and routes/safe-mode.ts already have
//     relative to their own overlay reads in master-canvas.ts.
export async function registerCanvasLayoutRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: CanvasLayoutStore,
  account?: AccountStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/canvas-layout', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const channelLayout = await store.getCurrent(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', canvasLayout: channelLayout });
    } catch (error) {
      logSafeError(request, 'canvas_layout_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.put<{ Params: { channelId: string }; Body: { layout: 'horizontal' | 'vertical' } }>('/v1/channels/:channelId/canvas-layout', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: setBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.set(request.auth.userId, request.params.channelId, request.body.layout);
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', canvasLayout: result.channelLayout });
        // Non-owner/admin. Mapped to 404, never a leaking 403 -- the
        // same mapping master-canvas.ts and routes/qr-smart-card.ts
        // already use.
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_canvas_layout', message: 'The canvas layout could not be saved', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'canvas_layout_set_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'canvas_layout_store_unavailable', message: 'The canvas layout could not be saved', traceId: request.id, retryable: true });
    }
  });
}
