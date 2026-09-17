import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { CompanionLiveOpsStore } from '../domain/companion-live-ops.js';
import { logSafeError } from '../observability/safe-log.js';

// CMP-94/CMP-22/CMP-30 (migration 0161): Companion live-ops -- Recent
// Actions on the Live Deck, quick-note stream markers, and the
// server-only half of Wrap Stream.
//
// ITS OWN FILE, DELIBERATELY. routes/companion.ts, routes/goals.ts and
// routes/goal-triggers.ts are owned by other lanes of this same
// coordinated build and are not touched here (per this task's own file-
// ownership boundary). Registered in apps/api/src/app.ts immediately
// after registerCompanionRoutes, and nowhere else.
//
// A NON-MEMBER/WRONG-ROLE CALLER GETS 404, NEVER 403 -- migration
// 0161's own functions collapse "channel does not exist" and "caller
// lacks a qualifying role" into one answer (raise 42501 for a write,
// zero rows for a read), and this file preserves that: distinguishing
// them would itself leak whether a channel the caller cannot see
// exists. Matches routes/safe-mode.ts's own documented posture.

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const markerParams = { type: 'object', additionalProperties: false, required: ['channelId', 'markerId'], properties: { channelId: uuid, markerId: uuid } } as const;
const wrapSessionParams = { type: 'object', additionalProperties: false, required: ['channelId', 'wrapSessionId'], properties: { channelId: uuid, wrapSessionId: uuid } } as const;

const createMarkerBody = {
  type: 'object', additionalProperties: false, required: ['label'],
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 500 },
    markerType: { type: 'string', enum: ['note', 'clip_moment', 'sponsor_mention', 'technical_issue'] },
    markerAt: { type: 'string', format: 'date-time' },
  },
} as const;

const recentActionsQuery = {
  type: 'object', additionalProperties: false,
  properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
} as const;

const confirmStopBody = {
  type: 'object', additionalProperties: false, required: ['obsStoppedConfirmed', 'broadcastCompleteConfirmed'],
  properties: { obsStoppedConfirmed: { enum: [true, false] }, broadcastCompleteConfirmed: { enum: [true, false] } },
} as const;

function unavailable(reply: FastifyReply, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'companion_live_ops_store_unavailable', message: 'This is temporarily unavailable', traceId, retryable: true });
}

function notFound(reply: FastifyReply, traceId: string) {
  return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found or not accessible', traceId });
}

function rejected(reply: FastifyReply, traceId: string, errorCode: string, message: string) {
  return reply.code(409).send({ schemaVersion: 'v1', errorCode, message, traceId });
}

export async function registerCompanionLiveOpsRoutes(app: FastifyInstance, sessions?: SessionStore, store?: CompanionLiveOpsStore): Promise<void> {
  const auth = requireAuth(sessions);

  app.post<{ Params: { channelId: string }; Body: { label: string; markerType?: string; markerAt?: string } }>(
    '/v1/channels/:channelId/companion/stream-markers',
    { preHandler: auth, schema: { params: channelParams, body: createMarkerBody } },
    async (request, reply) => {
      if (!store || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await store.createStreamMarker(
          request.auth.userId, request.params.channelId, request.body.label, request.body.markerType ?? 'note', request.body.markerAt ?? null,
        );
        if (result.outcome === 'not_found') return notFound(reply, request.id);
        if (result.outcome === 'rejected') return rejected(reply, request.id, 'stream_marker_rejected', result.message);
        return reply.code(201).send({ schemaVersion: 'v1', marker: result.value });
      } catch (error) {
        logSafeError(request, 'companion_stream_marker_create_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  app.delete<{ Params: { channelId: string; markerId: string } }>(
    '/v1/channels/:channelId/companion/stream-markers/:markerId',
    { preHandler: auth, schema: { params: markerParams } },
    async (request, reply) => {
      if (!store || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await store.deleteStreamMarker(request.auth.userId, request.params.channelId, request.params.markerId);
        if (result.outcome === 'not_found') return notFound(reply, request.id);
        if (result.outcome === 'rejected') return rejected(reply, request.id, 'stream_marker_delete_rejected', result.message);
        return reply.code(200).send({ schemaVersion: 'v1', markerId: result.value.markerId, deletedAt: result.value.deletedAt });
      } catch (error) {
        logSafeError(request, 'companion_stream_marker_delete_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  app.get<{ Params: { channelId: string } }>(
    '/v1/channels/:channelId/companion/stream-markers',
    { preHandler: auth, schema: { params: channelParams } },
    async (request, reply) => {
      if (!store || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await store.listStreamMarkers(request.auth.userId, request.params.channelId);
        return reply.code(200).send({ schemaVersion: 'v1', channelId: request.params.channelId, markers: result.outcome === 'ok' ? result.value : [] });
      } catch (error) {
        logSafeError(request, 'companion_stream_marker_list_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  // CMP-94. Deliberately GET-only, no write surface here -- "undo" IS
  // DELETE /stream-markers/:markerId above, the one real inverse this
  // lane found; this endpoint only ever reads.
  app.get<{ Params: { channelId: string }; Querystring: { limit?: number } }>(
    '/v1/channels/:channelId/companion/recent-actions',
    { preHandler: auth, schema: { params: channelParams, querystring: recentActionsQuery } },
    async (request, reply) => {
      if (!store || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await store.getRecentActions(request.auth.userId, request.params.channelId, request.query.limit ?? null);
        return reply.code(200).send({ schemaVersion: 'v1', channelId: request.params.channelId, actions: result.outcome === 'ok' ? result.value : [] });
      } catch (error) {
        logSafeError(request, 'companion_recent_actions_read_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  app.post<{ Params: { channelId: string } }>(
    '/v1/channels/:channelId/companion/wrap-stream',
    { preHandler: auth, schema: { params: channelParams } },
    async (request, reply) => {
      if (!store || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await store.beginWrapStream(request.auth.userId, request.params.channelId);
        if (result.outcome === 'not_found') return notFound(reply, request.id);
        if (result.outcome === 'rejected') return rejected(reply, request.id, 'wrap_stream_begin_rejected', result.message);
        return reply.code(201).send({ schemaVersion: 'v1', ...result.value });
      } catch (error) {
        logSafeError(request, 'companion_wrap_stream_begin_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  // Irreversible-adjacent: no undo route exists for this, deliberately
  // (S5.1's posture: ending a broadcast is explicitly confirmed, not
  // reversible). Not in the CMP-94 reversible set either.
  app.post<{ Params: { channelId: string; wrapSessionId: string }; Body: { obsStoppedConfirmed: boolean; broadcastCompleteConfirmed: boolean } }>(
    '/v1/channels/:channelId/companion/wrap-stream/:wrapSessionId/confirm-stop',
    { preHandler: auth, schema: { params: wrapSessionParams, body: confirmStopBody } },
    async (request, reply) => {
      if (!store || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await store.confirmWrapStreamStop(
          request.auth.userId, request.params.channelId, request.params.wrapSessionId,
          request.body.obsStoppedConfirmed, request.body.broadcastCompleteConfirmed,
        );
        if (result.outcome === 'not_found') return notFound(reply, request.id);
        if (result.outcome === 'rejected') return rejected(reply, request.id, 'wrap_stream_confirm_stop_rejected', result.message);
        return reply.code(200).send({ schemaVersion: 'v1', ...result.value });
      } catch (error) {
        logSafeError(request, 'companion_wrap_stream_confirm_stop_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  // Generates the private summary and the fire_mode='prepare'-only
  // deliverables (S5.5). Nothing this route returns is ever posted
  // anywhere by this API -- see migration 0161's header for the
  // structural CHECK constraint that makes that impossible even for a
  // future caller.
  app.post<{ Params: { channelId: string; wrapSessionId: string } }>(
    '/v1/channels/:channelId/companion/wrap-stream/:wrapSessionId/summary',
    { preHandler: auth, schema: { params: wrapSessionParams } },
    async (request, reply) => {
      if (!store || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await store.generateWrapStreamSummary(request.auth.userId, request.params.channelId, request.params.wrapSessionId);
        if (result.outcome === 'not_found') return notFound(reply, request.id);
        if (result.outcome === 'rejected') return rejected(reply, request.id, 'wrap_stream_summary_rejected', result.message);
        return reply.code(200).send({ schemaVersion: 'v1', session: result.value });
      } catch (error) {
        logSafeError(request, 'companion_wrap_stream_summary_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  app.get<{ Params: { channelId: string; wrapSessionId: string } }>(
    '/v1/channels/:channelId/companion/wrap-stream/:wrapSessionId',
    { preHandler: auth, schema: { params: wrapSessionParams } },
    async (request, reply) => {
      if (!store || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await store.getWrapStreamSession(request.auth.userId, request.params.channelId, request.params.wrapSessionId);
        if (result.outcome === 'not_found') return notFound(reply, request.id);
        if (result.outcome === 'rejected') return rejected(reply, request.id, 'wrap_stream_read_rejected', result.message);
        return reply.code(200).send({ schemaVersion: 'v1', session: result.value.session, preparedItems: result.value.preparedItems });
      } catch (error) {
        logSafeError(request, 'companion_wrap_stream_read_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );
}
