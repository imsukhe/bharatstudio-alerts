import type { FastifyInstance } from 'fastify';
import { requirePlatformAdmin } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AdminStore, DlqStatusFilter } from '../domain/admin.js';
import { logSafeError } from '../observability/safe-log.js';

const dlqStatuses: DlqStatusFilter[] = ['held', 'suppressed', 'quarantined_outbox', 'all'];

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'admin_unavailable', message: 'Admin tooling is temporarily unavailable', traceId, retryable: true });
}

// API-only — no admin UI, matching BharatStudio Alerts legacy's own scope
// boundary for this exact feature. See packages/db/migrations/
// 0073_v1_l03_admin_dlq_tooling.sql for the full design rationale.
export async function registerAdminRoutes(app: FastifyInstance, sessions?: SessionStore, store?: AdminStore): Promise<void> {
  const adminAuth = requirePlatformAdmin(sessions, store);

  app.get<{ Querystring: { status?: DlqStatusFilter; limit?: number } }>('/v1/admin/dlq', {
    preHandler: adminAuth,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { status: { type: 'string', enum: dlqStatuses, default: 'all' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const entries = await store.listDlq(request.auth.userId, request.query.status ?? 'all', request.query.limit ?? 50);
    return reply.code(200).send({ schemaVersion: 'v1', entries });
  });

  app.post<{ Params: { deliveryId: string }; Body: { reason?: string } }>('/v1/admin/dlq/:deliveryId/replay', {
    preHandler: adminAuth,
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['deliveryId'], properties: { deliveryId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.replayDlqDelivery(request.auth.userId, request.params.deliveryId, request.body?.reason ?? null);
      return result
        ? reply.code(200).send({ schemaVersion: 'v1', ...result })
        : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_replayable', message: 'Delivery was not found or is not in a replayable state', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'admin_dlq_replay_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{ Params: { deliveryId: string }; Body: { reason: string } }>('/v1/admin/dlq/:deliveryId/discard', {
    preHandler: adminAuth,
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['deliveryId'], properties: { deliveryId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.discardDlqDelivery(request.auth.userId, request.params.deliveryId, request.body.reason);
      return result
        ? reply.code(200).send({ schemaVersion: 'v1', ...result })
        : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_discardable', message: 'Delivery was not found or is not in a discardable state', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'admin_dlq_discard_failed', error);
      return unavailable(reply, request.id);
    }
  });

  const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;

  app.get<{ Params: { channelId: string } }>('/v1/admin/channels/:channelId/entitlement', { preHandler: adminAuth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const entitlement = await store.getChannelEntitlement(request.auth.userId, request.params.channelId);
    return entitlement
      ? reply.code(200).send({ schemaVersion: 'v1', ...entitlement })
      : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel entitlement not found', traceId: request.id });
  });

  app.get<{ Params: { channelId: string }; Querystring: { limit?: number } }>('/v1/admin/channels/:channelId/entitlement/history', {
    preHandler: adminAuth,
    schema: { params: channelParams, querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } } },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const history = await store.listChannelEntitlementHistory(request.auth.userId, request.params.channelId, request.query.limit ?? 50);
    return reply.code(200).send({ schemaVersion: 'v1', history });
  });

  app.post<{ Params: { channelId: string }; Body: { queueCount: number; reason: string } }>('/v1/admin/channels/:channelId/entitlement/override', {
    preHandler: adminAuth,
    schema: {
      params: channelParams,
      body: {
        type: 'object', additionalProperties: false, required: ['queueCount', 'reason'],
        properties: { queueCount: { type: 'integer', minimum: 1, maximum: 1000 }, reason: { type: 'string', minLength: 1, maxLength: 500 } },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const entitlement = await store.overrideChannelEntitlement(request.auth.userId, request.params.channelId, request.body.queueCount, request.body.reason);
      return entitlement
        ? reply.code(200).send({ schemaVersion: 'v1', ...entitlement })
        : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'channel_not_found', message: 'Channel was not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'admin_entitlement_override_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
