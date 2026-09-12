import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { PaymentAccountStore } from '../domain/payment-account.js';
import type { AccountStore } from '../domain/account-store.js';
import { createRazorpayPaymentProvider } from '../domain/payment-provider-razorpay.js';

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;

// This route is the one live caller of the connect/verify group on
// CreatorPaymentProvider (see src/domain/payment-provider-creator.ts).
// The exported function signature below is unchanged — apps/api/src/app.ts
// still passes a plain PaymentAccountStore — so every existing caller and
// test is unaffected; the abstraction is applied internally by wrapping
// that same store in the Razorpay provider before the handlers touch it.
export async function registerPaymentAccountRoutes(app: FastifyInstance, sessions?: SessionStore, store?: PaymentAccountStore, account?: AccountStore): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);
  const provider = store ? createRazorpayPaymentProvider(store) : undefined;
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/payment-accounts', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!provider || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_account_store_unavailable', message: 'Payment account settings are temporarily unavailable', traceId: request.id, retryable: true });
    return reply.send({ schemaVersion: 'v1', accounts: await provider.listAccounts(request.auth.userId, request.params.channelId) });
  });

  // Creator-UI-facing capability reporting (master plan L19: "the creator
  // UI exposes capabilities, never provider plumbing"). Read-only, same
  // auth as the list route above; returns the connected rail's real,
  // repo-evidenced capabilities — see payment-provider-razorpay.ts.
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/payment-accounts/razorpay/capabilities', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!provider || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_account_store_unavailable', message: 'Payment account settings are temporarily unavailable', traceId: request.id, retryable: true });
    return reply.send(provider.connectionCapabilities());
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
      if (!provider || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_account_store_unavailable', message: 'Payment account settings are temporarily unavailable', traceId: request.id, retryable: true });
      try {
        const account = await provider.connectAccount(request.auth.userId, request.params.channelId, request.body.environment, request.body.connectedAccountRef);
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
      if (!provider || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_account_store_unavailable', message: 'Payment account settings are temporarily unavailable', traceId: request.id, retryable: true });
      const revoked = await provider.revokeAccount(request.auth.userId, request.params.channelId, request.query.environment);
      return revoked ? reply.code(204).send() : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'payment_account_not_found', message: 'Payment account not found', traceId: request.id });
    },
  );

  // Records an explicit "Skip for now" on the onboarding payout step —
  // see migration 0079_v1_l03_payout_onboarding_gate.sql. Owner/admin
  // only, enforced by app_private.skip_payout_onboarding, matching every
  // other payment-account route's role gate.
  app.post<{ Params: { channelId: string } }>(
    '/v1/channels/:channelId/payout-onboarding/skip',
    { preHandler: termsAuth, schema: { params: channelParams } },
    async (request, reply) => {
      if (!provider || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_account_store_unavailable', message: 'Payment account settings are temporarily unavailable', traceId: request.id, retryable: true });
      try {
        const skippedAt = await provider.skipAccountOnboarding(request.auth.userId, request.params.channelId);
        return reply.code(200).send({ schemaVersion: 'v1', channelId: request.params.channelId, payoutOnboardingSkippedAt: skippedAt });
      } catch {
        return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'payout_onboarding_skip_failed', message: 'Payout onboarding could not be skipped', traceId: request.id });
      }
    },
  );
}
