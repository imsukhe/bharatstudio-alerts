import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { InsightsStore } from '../domain/insights-store.js';
import { logSafeError } from '../observability/safe-log.js';

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;
const revenueKpiQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    windowStart: { type: 'string', format: 'date-time' },
    windowEnd: { type: 'string', format: 'date-time' },
  },
} as const;

// OPS-08 (activation instrumentation) and the derivable half of OPS-11
// (revenue KPIs). Both are read-only, both are pure derived reads over
// durable records (§19.6) -- see apps/api/src/domain/insights-store.ts and
// packages/db/migrations/0133_v1_ops08_ops11_activation_and_revenue_kpis.sql.
//
// §7.1's dashboard screen inventory is where each of these is intended to
// surface -- activation state on Home/Today ("anything needing
// attention"), revenue KPIs under Money/Insights -- but this task builds
// only the instrument (the API), the same posture RT-06 took for its own
// histograms: it produces the reading, not the screen that renders it.
export async function registerInsightsRoutes(app: FastifyInstance, sessions?: SessionStore, store?: InsightsStore): Promise<void> {
  const auth = requireAuth(sessions);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/activation-state', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) {
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'insights_store_unavailable', message: 'Activation state is temporarily unavailable', traceId: request.id, retryable: true });
    }
    try {
      const state = await store.getActivationState(request.auth.userId, request.params.channelId);
      if (!state) {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'channel_not_found', message: 'Channel not found or not accessible', traceId: request.id });
      }
      return reply.code(200).send(state);
    } catch (error) {
      logSafeError(request, 'activation_state_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'insights_store_unavailable', message: 'Activation state is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });

  app.get<{ Params: { channelId: string }; Querystring: { windowStart?: string; windowEnd?: string } }>('/v1/channels/:channelId/revenue-kpis', {
    preHandler: auth,
    schema: { params: channelParams, querystring: revenueKpiQuery },
  }, async (request, reply) => {
    if (!store || !request.auth) {
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'insights_store_unavailable', message: 'Revenue KPIs are temporarily unavailable', traceId: request.id, retryable: true });
    }
    try {
      const kpis = await store.getRevenueKpis(request.auth.userId, request.params.channelId, request.query.windowStart ?? null, request.query.windowEnd ?? null);
      // No row is returned for both "channel not found" and "caller lacks
      // owner/admin financial visibility" (app_private.get_channel_revenue_
      // kpis' own has_channel_role guard) -- deliberately the same 404
      // either way, so this endpoint cannot be used to enumerate channel
      // membership from the distinction between "not found" and "not
      // permitted" (same posture as list_channel_payments' empty page).
      if (!kpis) {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'channel_not_found', message: 'Channel not found or not accessible', traceId: request.id });
      }
      return reply.code(200).send(kpis);
    } catch (error) {
      logSafeError(request, 'revenue_kpis_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'insights_store_unavailable', message: 'Revenue KPIs are temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
}
