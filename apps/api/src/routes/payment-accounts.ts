import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { PaymentAccountStore } from '../domain/payment-account.js';
import type { AccountStore } from '../domain/account-store.js';
import { createRazorpayPaymentProvider } from '../domain/payment-provider-razorpay.js';
import { buildRazorpayAuthorizeUrl, exchangeRazorpayOAuthCode, type RazorpayOAuthConfig, type RazorpayOAuthHttpClient } from '../domain/payment-provider-razorpay-oauth.js';
import { UPI_APP_PREFERENCES, type ProviderCapabilitySnapshotStore } from '../domain/payment-provider-creator.js';
import { logSafeError } from '../observability/safe-log.js';

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;

// This route is the one live caller of the connect/verify group on
// CreatorPaymentProvider (see src/domain/payment-provider-creator.ts).
// The exported function signature below keeps its original four
// parameters positionally unchanged — apps/api/src/app.ts still passes a
// plain PaymentAccountStore — so every existing caller and test is
// unaffected; the abstraction is applied internally by wrapping that same
// store in the Razorpay provider before the handlers touch it. New
// dependencies (Razorpay OAuth config, capability-snapshot persistence)
// are appended as optional parameters — this file's own new tests supply
// them; app.ts is untouched and unaffected either way, per this task's
// file-ownership boundary.
export async function registerPaymentAccountRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: PaymentAccountStore,
  account?: AccountStore,
  oauthConfig?: RazorpayOAuthConfig,
  capabilitySnapshots?: ProviderCapabilitySnapshotStore,
  // Test-only seam: overrides exchangeRazorpayOAuthCode's real network
  // call. Never supplied by app.ts (which stays on the real fetch-backed
  // default) — this file's own l19c tests are the only caller.
  oauthHttpClient?: RazorpayOAuthHttpClient,
): Promise<void> {
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
  app.get<{ Params: { channelId: string }; Querystring: { environment?: 'test' | 'live' } }>(
    '/v1/channels/:channelId/payment-accounts/razorpay/capabilities',
    { preHandler: auth, schema: { params: channelParams, querystring: { type: 'object', additionalProperties: false, properties: { environment: { type: 'string', enum: ['test', 'live'] } } } } },
    async (request, reply) => {
      if (!provider || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_account_store_unavailable', message: 'Payment account settings are temporarily unavailable', traceId: request.id, retryable: true });
      const capabilities = provider.connectionCapabilities();

      // Persist a snapshot of what was just reported (L19 task 2,
      // migration 0118) — best-effort, exactly like the vote-payment-tag
      // pattern in routes/public.ts: the live capability read this
      // request came here for must never fail because the snapshot write
      // did. Environment defaults to this deployment's paymentEnvironment
      // when the caller doesn't specify one, matching how every other
      // route in this file already treats environment.
      if (capabilitySnapshots) {
        try {
          await capabilitySnapshots.upsert(request.auth.userId, request.params.channelId, request.query.environment ?? 'test', capabilities);
        } catch (error) {
          logSafeError(request, 'provider_capability_snapshot_write_failed', error);
        }
      }

      // supportedUpiApps: the closed, non-secret allowlist a client uses
      // to offer the L19-task-5 "preferred UPI app" choice. This is the
      // one piece of that feature this task's file ownership can safely
      // own (see payment-provider-creator.ts's UPI_APP_PREFERENCES doc
      // comment) — the actual browser-scoped remembered choice lives in
      // apps/web, out of scope here. Appending this field does not change
      // provider.connectionCapabilities()'s own shape/values, so it
      // cannot affect any deepEqual assertion on that method's return.
      return reply.send({ ...capabilities, supportedUpiApps: UPI_APP_PREFERENCES });
    },
  );

  // Razorpay OAuth (Technology Partner) connection — L19 task 3. Step 1:
  // hand the browser a ready-to-redirect authorize URL plus the CSRF
  // `state` it must echo back on the callback below. Coexists with the
  // manual PUT route below without any shared code path branching on
  // "how was this ref obtained" — see payment-provider-razorpay-oauth.ts.
  app.get<{ Params: { channelId: string } }>(
    '/v1/channels/:channelId/payment-accounts/razorpay/oauth/authorize-url',
    { preHandler: termsAuth, schema: { params: channelParams } },
    async (request, reply) => {
      if (!oauthConfig || !request.auth) {
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'razorpay_oauth_unavailable', message: 'Razorpay OAuth connection is temporarily unavailable', traceId: request.id, retryable: true });
      }
      const state = randomBytes(24).toString('base64url');
      return reply.send({ schemaVersion: 'v1', url: buildRazorpayAuthorizeUrl(oauthConfig, state), state });
    },
  );

  // Step 2: exchange the authorization code Razorpay redirected back with
  // for the linked account id, then register it through the EXACT SAME
  // provider.connectAccount call the manual PUT route below uses — this
  // is what keeps OAuth and manual as two ways of obtaining a
  // connectedAccountRef rather than two separate connection code paths.
  app.post<{ Params: { channelId: string }; Body: { code: string; environment: 'test' | 'live' } }>(
    '/v1/channels/:channelId/payment-accounts/razorpay/oauth/callback',
    {
      preHandler: termsAuth,
      schema: {
        params: channelParams,
        body: {
          type: 'object', additionalProperties: false, required: ['code', 'environment'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 2048 }, environment: { type: 'string', enum: ['test', 'live'] } },
        },
      },
    },
    async (request, reply) => {
      if (!oauthConfig || !provider || !request.auth) {
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'razorpay_oauth_unavailable', message: 'Razorpay OAuth connection is temporarily unavailable', traceId: request.id, retryable: true });
      }
      try {
        const linked = oauthHttpClient
          ? await exchangeRazorpayOAuthCode(oauthConfig, request.body.code, request.body.environment, oauthHttpClient)
          : await exchangeRazorpayOAuthCode(oauthConfig, request.body.code, request.body.environment);
        const registered = await provider.connectAccount(request.auth.userId, request.params.channelId, linked.environment, linked.connectedAccountRef);
        return reply.code(200).send(registered);
      } catch (error) {
        logSafeError(request, 'razorpay_oauth_callback_failed', error);
        return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'razorpay_oauth_failed', message: 'Razorpay OAuth connection could not be completed', traceId: request.id, retryable: false });
      }
    },
  );

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
