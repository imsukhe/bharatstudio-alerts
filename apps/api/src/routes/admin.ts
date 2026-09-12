import type { FastifyInstance } from 'fastify';
import { requirePlatformAdmin } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AdminStore, DlqStatusFilter } from '../domain/admin.js';
import type { IngestFailureAdminStore } from '../domain/ingest-failure-admin.js';
import { logSafeError } from '../observability/safe-log.js';

const dlqStatuses: DlqStatusFilter[] = ['held', 'suppressed', 'quarantined_outbox', 'all'];

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'admin_unavailable', message: 'Admin tooling is temporarily unavailable', traceId, retryable: true });
}

// API-only — no admin UI, matching BharatStudio Alerts legacy's own scope
// boundary for this exact feature. See packages/db/migrations/
// 0073_v1_l03_admin_dlq_tooling.sql for the full design rationale.
export async function registerAdminRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: AdminStore,
  ingestFailureStore?: IngestFailureAdminStore,
): Promise<void> {
  // Same role gate as every other admin route on this file — reuses
  // `store.isPlatformAdmin`, the existing AdminStore's own method, rather
  // than duplicating an isPlatformAdmin on IngestFailureAdminStore. That
  // lets the ingest-failure routes reuse the existing platform-admin gate.
  // buildApp supplies the SQL-backed ingest-failure store in normal runtime;
  // an intentionally unconfigured test instance still fails closed with 503.
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

  // L15 operator surface for youtube_event_ingest_failures (migration
  // 0094) — see domain/ingest-failure-admin.ts's header comment for why
  // `ingestFailureStore` has no real backing implementation until a future
  // migration adds the read/acknowledge SQL surface this pass may not
  // write. Same auth, same role gate, same response-shape idiom as the DLQ
  // routes above — no parallel admin surface.
  const ingestFailureIdParams = {
    type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } },
  } as const;

  app.get<{ Querystring: { limit?: number; cursor?: string } }>('/v1/admin/ingest-failures', {
    preHandler: adminAuth,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, cursor: { type: 'string', maxLength: 2048 } },
      },
    },
  }, async (request, reply) => {
    if (!ingestFailureStore || !request.auth) return unavailable(reply, request.id);
    try {
      const page = await ingestFailureStore.listIngestFailures(request.auth.userId, request.query.limit ?? 50, request.query.cursor ?? null);
      return reply.code(200).send({ schemaVersion: 'v1', entries: page.entries, nextCursor: page.nextCursor });
    } catch (error) {
      logSafeError(request, 'admin_ingest_failure_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.get<{ Params: { id: string } }>('/v1/admin/ingest-failures/:id', { preHandler: adminAuth, schema: { params: ingestFailureIdParams } }, async (request, reply) => {
    if (!ingestFailureStore || !request.auth) return unavailable(reply, request.id);
    try {
      const entry = await ingestFailureStore.getIngestFailure(request.auth.userId, request.params.id);
      return entry
        ? reply.code(200).send({ schemaVersion: 'v1', ...entry })
        : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Ingest failure not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'admin_ingest_failure_get_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // Acknowledge is the ONLY disposition action offered — see
  // domain/ingest-failure-admin.ts's header comment on why replay and
  // discard are both wrong for a permanent (SQLSTATE class 22/23) failure.
  app.post<{ Params: { id: string }; Body: { note: string } }>('/v1/admin/ingest-failures/:id/acknowledge', {
    preHandler: adminAuth,
    schema: {
      params: ingestFailureIdParams,
      body: { type: 'object', additionalProperties: false, required: ['note'], properties: { note: { type: 'string', minLength: 1, maxLength: 500 } } },
    },
  }, async (request, reply) => {
    if (!ingestFailureStore || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await ingestFailureStore.acknowledgeIngestFailure(request.auth.userId, request.params.id, request.body.note);
      return result
        ? reply.code(200).send({ schemaVersion: 'v1', ...result })
        : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_acknowledgeable', message: 'Ingest failure was not found or is already acknowledged', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'admin_ingest_failure_acknowledge_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
