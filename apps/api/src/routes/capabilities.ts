import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { CapabilityStore } from '../domain/capability-store.js';
import { logSafeError } from '../observability/safe-log.js';

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;

// CTL phase 1 (migration 0149). The ONLY route this plane exposes in
// phase 1: read a channel's resolved capability blob. There is no
// write route here -- CTL-04's admin UI (phase 2, a different
// repository) is what will eventually call the staff write function --
// this file never does.
//
// Deliberately its own file, not folded into routes/insights.ts or any
// other existing registrar -- CTL is its own subsystem (registry,
// resolver, cache), not a dashboard analytics read that happens to
// share a shape. registerMasterCanvasRoutes is untouched: this plane
// has no overlay-facing surface in phase 1, so it does not take a
// position in that registrar's positional argument list at all.
export async function registerCapabilityRoutes(app: FastifyInstance, sessions?: SessionStore, store?: CapabilityStore): Promise<void> {
  const auth = requireAuth(sessions);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/capabilities', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) {
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'capability_store_unavailable', message: 'Capabilities are temporarily unavailable', traceId: request.id, retryable: true });
    }
    try {
      const resolved = await store.getResolvedCapabilities(request.auth.userId, request.params.channelId);
      // No row for BOTH "channel not found" and "caller is not a member"
      // -- app_private.get_channel_capabilities' own has_channel_role
      // guard (migration 0149) already collapses the two; the same 404
      // either way keeps this endpoint from being usable to enumerate
      // channel membership, the same posture routes/insights.ts already
      // takes for revenue-kpis.
      if (!resolved) {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'channel_not_found', message: 'Channel not found or not accessible', traceId: request.id });
      }
      return reply.code(200).send(resolved);
    } catch (error) {
      logSafeError(request, 'capabilities_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'capability_store_unavailable', message: 'Capabilities are temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
}
