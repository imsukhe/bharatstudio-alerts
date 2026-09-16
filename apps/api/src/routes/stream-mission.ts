import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import {
  STREAM_MISSION_OBJECTIVE_MAX_LENGTH,
  STREAM_MISSION_OBJECTIVE_MIN_LENGTH,
  type StreamMissionOverlayStore,
  type StreamMissionStore,
} from '../domain/stream-mission-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const missionParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'missionId'],
  properties: { channelId: uuid, missionId: uuid },
} as const;
const overlayParams = { type: 'object', additionalProperties: false, required: ['overlayId'], properties: { overlayId: uuid } } as const;

// The 1-120 bound, taken from the domain constants rather than retyped --
// which are themselves migration 0109 line 67's already-decided
// challenge-title bound, reused per the owner's 2026-09-16 decision.
//
// `additionalProperties: false` is load-bearing here, not boilerplate: it
// is what makes a body carrying `durationSeconds`/`endsAt`/`expiresAt` a
// 400 at the schema layer, before the store is ever called. The mission is
// session-bounded, not clock-bounded, and this is where that decision is
// enforced on the wire.
const startBody = {
  type: 'object', additionalProperties: false, required: ['objective'],
  properties: {
    objective: {
      type: 'string',
      minLength: STREAM_MISSION_OBJECTIVE_MIN_LENGTH,
      maxLength: STREAM_MISSION_OBJECTIVE_MAX_LENGTH,
    },
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'stream_mission_store_unavailable', message: 'The stream mission is temporarily unavailable', traceId, retryable: true });
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1];
}

// PRF-02 slice 5: §6 catalogue module #9, Stream Mission Card. Two route
// groups, mirroring the goals.ts / master-canvas.ts split exactly:
//   - creator-facing (session auth): read the current mission, start one,
//     end one. Never tier-gated -- §12.6: storing, viewing and exporting a
//     durable creator record is available at every tier. The §30.3 module
//     cap (migration 0131) gates only whether the Canvas RENDERS the card,
//     and there is no second tier gate anywhere in this file.
//   - overlay-facing (bearer overlay-session token, browser-source-shaped):
//     the current mission the Master Canvas module paints, §12.7-bounded to
//     at most one mission and never a history.
export async function registerStreamMissionRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: StreamMissionStore,
  account?: AccountStore,
  overlayMission?: StreamMissionOverlayStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/stream-mission', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const mission = await store.getCurrent(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', mission });
    } catch (error) {
      logSafeError(request, 'stream_mission_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{ Params: { channelId: string }; Body: { objective: string } }>('/v1/channels/:channelId/stream-mission', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: startBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.start(request.auth.userId, request.params.channelId, request.body.objective);
      switch (result.outcome) {
        case 'ok': return reply.code(201).send({ schemaVersion: 'v1', mission: result.mission });
        // A mission is already running. Deliberately a conflict the creator
        // resolves, never a silent supersede that destroys the running one.
        case 'conflict': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'stream_mission_already_running', message: 'A stream mission is already running for this channel. End it before starting another.', traceId: request.id });
        // Non-owner/admin. Mapped to 404, never a leaking 403 -- the same
        // mapping master-canvas.ts already uses.
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_stream_mission', message: 'The stream mission could not be started', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'stream_mission_start_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'stream_mission_store_unavailable', message: 'The stream mission could not be started', traceId: request.id, retryable: true });
    }
  });

  // Addressed, not ambient: the mission id is required, so a stale
  // dashboard tab cannot end a mission started after that tab loaded.
  app.post<{ Params: { channelId: string; missionId: string } }>('/v1/channels/:channelId/stream-mission/:missionId/end', {
    preHandler: termsAuth,
    schema: { params: missionParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.end(request.auth.userId, request.params.channelId, request.params.missionId);
      if (result.outcome === 'not_found') {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Stream mission not found', traceId: request.id });
      }
      return reply.code(204).send();
    } catch (error) {
      logSafeError(request, 'stream_mission_end_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'stream_mission_store_unavailable', message: 'The stream mission could not be ended', traceId: request.id, retryable: true });
    }
  });

  // Overlay browser-source read. Deliberately outside the session-cookie
  // auth chain -- the same shape registerGoalRoutes's /v1/overlay-goals and
  // registerMasterCanvasRoutes's own overlay read already have: no
  // preHandler, a scoped bearer token read from the Authorization header,
  // and all channel/session scoping enforced inside
  // app_private.list_overlay_stream_mission (migration 0135). Reuses the
  // existing overlay_sessions table and token-fingerprint model -- this
  // route opens no second overlay session and no second transport.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/stream-mission', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'The stream mission is not available', traceId: request.id });
    // A missing store is a retryable 503, never a 200 with `mission: null`
    // masquerading as "no mission is running".
    if (!overlayMission) return unavailable(reply, request.id);
    try {
      const mission = await overlayMission.getForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', mission });
    } catch (error) {
      logSafeError(request, 'overlay_stream_mission_read_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
