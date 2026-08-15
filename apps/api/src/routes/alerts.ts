import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AlertStore } from '../domain/alert-store.js';
import type { PaymentSubscriptionService } from '../domain/payment-subscription.js';
import { parseHistoryCursor } from '../db/history-cursor.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const alertParams = { type: 'object', additionalProperties: false, required: ['channelId', 'alertId'], properties: { channelId: uuid, alertId: uuid } } as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'alert_store_unavailable', message: 'Alert data is temporarily unavailable', traceId, retryable: true });
}

export async function registerAlertRoutes(app: FastifyInstance, sessions?: SessionStore, store?: AlertStore, paymentSubscriptions?: PaymentSubscriptionService, paymentEnvironment: 'test' | 'live' = 'test'): Promise<void> {
  const auth = requireAuth(sessions);

  app.post<{ Params: { channelId: string }; Body: { displayName: string; message?: string; queueIds?: string[] } }>('/v1/channels/:channelId/test-alert', {
    preHandler: auth,
    schema: {
      params: channelParams,
      body: {
        type: 'object', additionalProperties: false, required: ['displayName'],
        properties: {
          displayName: { type: 'string', minLength: 1, maxLength: 80 },
          message: { type: 'string', maxLength: 500 },
          queueIds: { type: 'array', maxItems: 64, items: uuid },
        },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      return reply.code(202).send(await store.createTestAlert(request.auth.userId, request.params.channelId, request.body.displayName, request.body.message ?? '', request.body.queueIds));
    } catch (error) {
      logSafeError(request, 'test_alert_failed', error);
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'alert_not_accepted', message: 'Test alert could not be accepted', traceId: request.id, retryable: true });
    }
  });

  app.get<{ Params: { channelId: string }; Querystring: { cursor?: string; pageSize?: number } }>('/v1/channels/:channelId/alert-history', {
    preHandler: auth,
    schema: {
      params: channelParams,
      querystring: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string', maxLength: 64 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 25 } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const cursor = parseHistoryCursor(request.query.cursor);
    if (request.query.cursor !== undefined && !cursor) {
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'bad_cursor', message: 'Cursor is invalid', traceId: request.id });
    }
    const page = await store.listHistory(request.auth.userId, request.params.channelId, request.query.cursor, request.query.pageSize ?? 25);
    return reply.code(200).send({ schemaVersion: 'v1', ...page });
  });

  app.post<{ Params: { channelId: string; alertId: string }; Body: { action: 'approve' | 'hold' | 'suppress' | 'replay'; reason?: string } }>('/v1/channels/:channelId/moderation/:alertId', {
    preHandler: auth,
    schema: {
      params: alertParams,
      body: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['approve', 'hold', 'suppress', 'replay'] }, reason: { type: 'string', maxLength: 500 } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const result = await store.moderate(request.auth.userId, request.params.channelId, request.params.alertId, request.body.action, request.body.reason ?? null);
    return result ? reply.code(200).send(result) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Alert not found', traceId: request.id });
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/billing', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const result = await store.getBilling(request.auth.userId, request.params.channelId);
    return result ? reply.code(200).send(result) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Billing view not found', traceId: request.id });
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/entitlements', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const result = await store.getEntitlements(request.auth.userId, request.params.channelId);
    return result ? reply.code(200).send(result) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Entitlements not found', traceId: request.id });
  });

  app.post<{ Params: { channelId: string }; Body: { tier: 'pro' | 'creator' | 'studio'; billingInterval: 'monthly' | 'annual' } }>('/v1/channels/:channelId/billing/subscription', {
    preHandler: auth,
    schema: {
      params: channelParams,
      body: {
        type: 'object', additionalProperties: false, required: ['tier', 'billingInterval'],
        properties: {
          tier: { type: 'string', enum: ['pro', 'creator', 'studio'] },
          billingInterval: { type: 'string', enum: ['monthly', 'annual'] },
        },
      },
    },
  }, async (request, reply) => {
    if (!paymentSubscriptions || !request.auth) {
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'subscription_unavailable', message: 'Subscription billing is temporarily unavailable', traceId: request.id, retryable: true });
    }
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_idempotency_key', message: 'A valid Idempotency-Key header is required', traceId: request.id, retryable: false });
    }
    try {
      const result = await paymentSubscriptions.createSubscription({
        userId: request.auth.userId,
        channelId: request.params.channelId,
        environment: paymentEnvironment,
        idempotencyKey,
        tier: request.body.tier,
        billingInterval: request.body.billingInterval,
      }, request.id);
      return reply.code(201).send(result);
    } catch (error) {
      logSafeError(request, 'subscription_creation_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'subscription_unavailable', message: 'Subscription billing is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
}
