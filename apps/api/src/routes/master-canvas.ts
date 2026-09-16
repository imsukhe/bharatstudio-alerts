import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import {
  MASTER_CANVAS_MODULE_KEYS,
  type MasterCanvasModuleKey,
  type MasterCanvasOverlayStore,
  type MasterCanvasStore,
} from '../domain/master-canvas-store.js';
import {
  projectModeratorStatus,
  type ModeratorStatusOverlayStore,
} from '../domain/moderator-status-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const moduleParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'moduleKey'],
  properties: { channelId: uuid, moduleKey: { type: 'string', enum: [...MASTER_CANVAS_MODULE_KEYS] } },
} as const;
const overlayParams = { type: 'object', additionalProperties: false, required: ['overlayId'], properties: { overlayId: uuid } } as const;

const upsertBody = {
  type: 'object', additionalProperties: false, required: ['enabled'],
  properties: { enabled: { type: 'boolean' } },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Master Canvas module configuration is temporarily unavailable', traceId, retryable: true });
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1];
}

// PRF-02: the server-owned §30.3 module cap (Free 2 / Pro 5 / Creator 12 /
// Studio all) and the durable per-channel module configuration it gates.
// Two route groups, mirroring the goals.ts split exactly:
//   - creator-facing (session auth, dashboard-shaped): list + toggle. This
//     is deliberately NOT the canvas designer UI (§7, out of this task's
//     scope) -- it is the same kind of undocumented internal CRUD surface
//     goals.ts's own POST/PATCH routes already are (neither is in
//     contracts/openapi/v1.yaml; only overlay/browser-source reads are).
//   - overlay-facing (bearer overlay-session token, browser-source-shaped):
//     the active module key list the Master Canvas runtime mounts from.
export async function registerMasterCanvasRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: MasterCanvasStore,
  account?: AccountStore,
  overlayModules?: MasterCanvasOverlayStore,
  overlayModeratorStatus?: ModeratorStatusOverlayStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/master-canvas/modules', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const modules = await store.list(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', modules });
    } catch (error) {
      logSafeError(request, 'master_canvas_module_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.put<{ Params: { channelId: string; moduleKey: MasterCanvasModuleKey }; Body: { enabled: boolean } }>('/v1/channels/:channelId/master-canvas/modules/:moduleKey', {
    preHandler: termsAuth,
    schema: { params: moduleParams, body: upsertBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.upsert(request.auth.userId, request.params.channelId, request.params.moduleKey, request.body.enabled);
      switch (result.outcome) {
        case 'ok': return reply.code(200).send(result.module);
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_master_canvas_module', message: 'The module could not be configured', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'master_canvas_module_upsert_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The module could not be configured', traceId: request.id, retryable: true });
    }
  });

  // Overlay browser-source read. Deliberately outside the session-cookie
  // auth chain -- same shape as registerGoalRoutes's /v1/overlay-goals: no
  // preHandler, a scoped bearer token read from the Authorization header,
  // all channel/session/tier/cap scoping enforced inside
  // app_private.list_overlay_master_canvas_modules (0131). Reuses the
  // existing overlay_sessions table and token-fingerprint model.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/master-canvas/modules', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Master Canvas is not available', traceId: request.id });
    if (!overlayModules) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Master Canvas is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const moduleKeys = await overlayModules.listActiveForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', moduleKeys });
    } catch (error) {
      logSafeError(request, 'overlay_master_canvas_modules_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Master Canvas is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });

  // PRF-02 slice 5, §6 module #12 (Moderator Status Card) -- HELD HALF
  // ONLY. Same overlay browser-source shape as the route just above, and
  // deliberately in this file rather than interactions.ts: this is a
  // Master Canvas module read, not an interaction, and this file already
  // owns the bearer-token helper and the master_canvas_store_unavailable
  // envelope.
  //
  // THE RESPONSE CARRIES A COUNT AND NOTHING ELSE. §6: "never private
  // content", which the owner's 2026-09-16 decision requires to be a
  // property of the query -- app_private.list_overlay_moderator_status
  // (migration 0136) returns a single held_count column, so no supporter
  // name, message, amount, delivery id, queue id or viewer identifier
  // exists to be leaked here. projectModeratorStatus() then narrows a
  // SECOND, independent time in front of whatever the store hands up, so
  // the guarantee does not rest on a single layer.
  //
  // NO SAFE-MODE FIELD. Safe mode is NOT the queue-paused flag (owner
  // decision, 2026-09-16); it is a separate moderation control that does
  // not exist in this schema and needs its own record and decision. This
  // response has no field for it, and 0136 reads no queue-lifecycle
  // column at all.
  //
  // A VALID SESSION WITH NOTHING HELD ANSWERS 200 WITH heldCount: 0; an
  // unrecognised/expired/revoked/foreign token answers 200 with
  // moderatorStatus: null. The Canvas module renders those differently
  // (a real zero hides the card; a null snapshot leaves it hidden
  // without claiming anything), so collapsing them would be a bug.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/moderator-status', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Moderator status is not available', traceId: request.id });
    if (!overlayModeratorStatus) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Moderator status is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const status = await overlayModeratorStatus.getForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', moderatorStatus: projectModeratorStatus(status) });
    } catch (error) {
      logSafeError(request, 'overlay_moderator_status_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Moderator status is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
}
