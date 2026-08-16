import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AlertStore } from '../domain/alert-store.js';
import type { AccountStore } from '../domain/account-store.js';
import type { PaymentSubscriptionService } from '../domain/payment-subscription.js';
import { parseHistoryCursor } from '../db/history-cursor.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const alertParams = { type: 'object', additionalProperties: false, required: ['channelId', 'alertId'], properties: { channelId: uuid, alertId: uuid } } as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'alert_store_unavailable', message: 'Alert data is temporarily unavailable', traceId, retryable: true });
}

export async function registerAlertRoutes(app: FastifyInstance, sessions?: SessionStore, store?: AlertStore, paymentSubscriptions?: PaymentSubscriptionService, paymentEnvironment: 'test' | 'live' = 'test', account?: AccountStore): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.post<{ Params: { channelId: string }; Body: { displayName: string; message?: string; queueIds?: string[] } }>('/v1/channels/:channelId/test-alert', {
    preHandler: termsAuth,
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
    preHandler: termsAuth,
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
    preHandler: termsAuth,
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
    preHandler: termsAuth,
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

  function requireIdempotencyKey(request: { headers: Record<string, unknown> }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string): string | null {
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_idempotency_key', message: 'A valid Idempotency-Key header is required', traceId, retryable: false });
      return null;
    }
    return idempotencyKey;
  }

  // Maps the lifecycle client's own thrown/rejected outcomes to safe, stable
  // HTTP responses without ever forwarding provider error text to the
  // browser — mirrors createSubscription's failure handling above. The
  // client only throws for transport/validation failures; provider-side
  // outcomes (no_active_subscription, provider_rejected_request, etc.) are
  // carried as HTTP error responses that surface as thrown errors with a
  // `code` from the underlying request library, which we do not trust
  // enough to relay verbatim — every case still fails closed as 503.
  function subscriptionLifecycleUnavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
    return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'subscription_lifecycle_unavailable', message: 'Subscription billing changes are temporarily unavailable', traceId, retryable: true });
  }

  app.post<{ Params: { channelId: string } }>('/v1/channels/:channelId/billing/subscription/cancel', {
    preHandler: termsAuth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!paymentSubscriptions || !request.auth) return subscriptionLifecycleUnavailable(reply, request.id);
    const idempotencyKey = requireIdempotencyKey(request, reply, request.id);
    if (!idempotencyKey) return;
    try {
      const result = await paymentSubscriptions.cancelSubscription({
        userId: request.auth.userId, channelId: request.params.channelId, environment: paymentEnvironment, idempotencyKey,
      }, request.id);
      return reply.code(200).send(result);
    } catch (error) {
      logSafeError(request, 'subscription_cancel_failed', error);
      return subscriptionLifecycleUnavailable(reply, request.id);
    }
  });

  app.post<{ Params: { channelId: string }; Body: { targetTier: 'pro' | 'creator' | 'studio'; billingInterval: 'monthly' | 'annual' } }>('/v1/channels/:channelId/billing/subscription/upgrade', {
    preHandler: termsAuth,
    schema: {
      params: channelParams,
      body: {
        type: 'object', additionalProperties: false, required: ['targetTier', 'billingInterval'],
        properties: { targetTier: { type: 'string', enum: ['pro', 'creator', 'studio'] }, billingInterval: { type: 'string', enum: ['monthly', 'annual'] } },
      },
    },
  }, async (request, reply) => {
    if (!paymentSubscriptions || !request.auth) return subscriptionLifecycleUnavailable(reply, request.id);
    const idempotencyKey = requireIdempotencyKey(request, reply, request.id);
    if (!idempotencyKey) return;
    try {
      const result = await paymentSubscriptions.changeSubscriptionPlan({
        userId: request.auth.userId, channelId: request.params.channelId, environment: paymentEnvironment, idempotencyKey,
        targetTier: request.body.targetTier, billingInterval: request.body.billingInterval,
      }, 'upgrade', request.id);
      return reply.code(200).send(result);
    } catch (error) {
      logSafeError(request, 'subscription_upgrade_failed', error);
      return subscriptionLifecycleUnavailable(reply, request.id);
    }
  });

  // Per the launch authority's pricing rules, an upgrade takes effect
  // immediately (the creator pays the new price now) while a downgrade only
  // takes effect at the end of the already-paid cycle (never a mid-cycle
  // refund) — the two are separate routes so the client's intent is
  // explicit rather than inferred server-side from a tier comparison.
  app.post<{ Params: { channelId: string }; Body: { targetTier: 'pro' | 'creator' | 'studio'; billingInterval: 'monthly' | 'annual' } }>('/v1/channels/:channelId/billing/subscription/downgrade', {
    preHandler: termsAuth,
    schema: {
      params: channelParams,
      body: {
        type: 'object', additionalProperties: false, required: ['targetTier', 'billingInterval'],
        properties: { targetTier: { type: 'string', enum: ['pro', 'creator', 'studio'] }, billingInterval: { type: 'string', enum: ['monthly', 'annual'] } },
      },
    },
  }, async (request, reply) => {
    if (!paymentSubscriptions || !request.auth) return subscriptionLifecycleUnavailable(reply, request.id);
    const idempotencyKey = requireIdempotencyKey(request, reply, request.id);
    if (!idempotencyKey) return;
    try {
      const result = await paymentSubscriptions.changeSubscriptionPlan({
        userId: request.auth.userId, channelId: request.params.channelId, environment: paymentEnvironment, idempotencyKey,
        targetTier: request.body.targetTier, billingInterval: request.body.billingInterval,
      }, 'downgrade', request.id);
      return reply.code(200).send(result);
    } catch (error) {
      logSafeError(request, 'subscription_downgrade_failed', error);
      return subscriptionLifecycleUnavailable(reply, request.id);
    }
  });

  app.post<{ Params: { channelId: string } }>('/v1/channels/:channelId/billing/subscription/reactivate', {
    preHandler: termsAuth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!paymentSubscriptions || !request.auth) return subscriptionLifecycleUnavailable(reply, request.id);
    const idempotencyKey = requireIdempotencyKey(request, reply, request.id);
    if (!idempotencyKey) return;
    try {
      const result = await paymentSubscriptions.reactivateSubscription({
        userId: request.auth.userId, channelId: request.params.channelId, environment: paymentEnvironment, idempotencyKey,
      }, request.id);
      return reply.code(200).send(result);
    } catch (error) {
      logSafeError(request, 'subscription_reactivate_failed', error);
      return subscriptionLifecycleUnavailable(reply, request.id);
    }
  });
}
