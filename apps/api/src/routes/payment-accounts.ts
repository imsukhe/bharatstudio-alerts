import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { PaymentAccountStore } from '../domain/payment-account.js';
import type { AccountStore } from '../domain/account-store.js';

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;

export async function registerPaymentAccountRoutes(app: FastifyInstance, sessions?: SessionStore, store?: PaymentAccountStore, account?: AccountStore): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/payment-accounts', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_account_store_unavailable', message: 'Payment account settings are temporarily unavailable', traceId: request.id, retryable: true });
    return reply.send({ schemaVersion: 'v1', accounts: await store.list(request.auth.userId, request.params.channelId) });
  });

  app.put<{ Params: { channelId: string }; Body: { environment: 'test' | 'live'; connectedAccountRef: string } }>(
    '/v1/channels/:channelId/payment-accounts/razorpay',
    {
      preHandler: termsAuth,
      schema: {
        params: channelParams,
        body: {
          type: 'object', additionalProperties: false, required: ['environment', 'connectedAccountRef'],
          properties: {
            environment: { type: 'string', enum: ['test', 'live'] },
            connectedAccountRef: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!store || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_account_store_unavailable', message: 'Payment account settings are temporarily unavailable', traceId: request.id, retryable: true });
      try {
        const account = await store.register(request.auth.userId, request.params.channelId, request.body.environment, request.body.connectedAccountRef);
        return reply.code(200).send(account);
      } catch {
        return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'payment_account_registration_failed', message: 'Payment account could not be registered', traceId: request.id, retryable: false });
      }
    },
  );

  app.delete<{ Params: { channelId: string }; Querystring: { environment: 'test' | 'live' } }>(
    '/v1/channels/:channelId/payment-accounts/razorpay',
    { preHandler: termsAuth, schema: { params: channelParams, querystring: { type: 'object', additionalProperties: false, required: ['environment'], properties: { environment: { type: 'string', enum: ['test', 'live'] } } } } },
    async (request, reply) => {
      if (!store || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_account_store_unavailable', message: 'Payment account settings are temporarily unavailable', traceId: request.id, retryable: true });
      const revoked = await store.revoke(request.auth.userId, request.params.channelId, request.query.environment);
      return revoked ? reply.code(204).send() : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'payment_account_not_found', message: 'Payment account not found', traceId: request.id });
    },
  );
}
