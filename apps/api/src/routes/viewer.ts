import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ViewerSessionPrincipal, ViewerStore } from '../domain/viewer-store.js';
import type { ViewerPlatformIdentityVerifier } from '../domain/viewer-platform-identity-verifier.js';

// Viewer identity is a SEPARATE auth surface from the creator surface (see
// packages/db/migrations/0084's header comment for why). It therefore gets
// its own request property and its own bearer-token pre-handler, entirely
// local to this file, rather than reusing auth/pre-handler.ts's
// requireAuth/request.auth which are scoped to creator sessions.
declare module 'fastify' {
  interface FastifyRequest {
    viewerAuth: ViewerSessionPrincipal | null;
  }
}

function requireViewerAuth(store?: ViewerStore) {
  return async function authenticateViewer(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    request.viewerAuth = null;
    if (!store) {
      await reply.code(503).send({
        schemaVersion: 'v1',
        errorCode: 'viewer_auth_unavailable',
        message: 'Viewer authentication is temporarily unavailable',
        traceId: request.id,
        retryable: true,
      });
      return;
    }
    const header = request.headers.authorization;
    const token = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
    if (!token || token.length < 32) {
      await reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Viewer authentication required', traceId: request.id });
      return;
    }
    const principal = await store.lookup(token);
    if (!principal) {
      await reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Viewer authentication required', traceId: request.id });
      return;
    }
    request.viewerAuth = principal;
  };
}

const EMAIL_SCHEMA = { type: 'string', minLength: 5, maxLength: 254, format: 'email' } as const;
const PASSWORD_SCHEMA = { type: 'string', minLength: 8, maxLength: 200 } as const;

function databaseErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/**
 * Registers viewer-facing routes only (signup/login/logout/session
 * management/private dashboard/deletion request). buildApp composes the
 * SQL-backed viewer store in the production entrypoint.
 */
export async function registerViewerRoutes(app: FastifyInstance, dependencies?: { viewer?: ViewerStore; platformIdentityVerifier?: ViewerPlatformIdentityVerifier }): Promise<void> {
  const viewer = dependencies?.viewer;
  const platformIdentityVerifier = dependencies?.platformIdentityVerifier;
  const viewerAuth = requireViewerAuth(viewer);

  app.post<{ Body: { email: string; password: string; displayName?: string; deviceLabel: string } }>(
    '/v1/viewer/signup',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password', 'deviceLabel'],
          properties: {
            email: EMAIL_SCHEMA,
            password: PASSWORD_SCHEMA,
            displayName: { type: 'string', minLength: 1, maxLength: 80 },
            deviceLabel: { type: 'string', minLength: 1, maxLength: 80 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!viewer) {
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'viewer_auth_unavailable', message: 'Viewer signup is temporarily unavailable', traceId: request.id, retryable: true });
      }
      try {
        const created = await viewer.signup(request.body.email, request.body.password, request.body.displayName, request.body.deviceLabel);
        return reply.code(201).send({ schemaVersion: 'v1', accessToken: created.accessToken, expiresAt: created.expiresAt });
      } catch {
        // Deliberately generic: never confirm/deny an email's registration
        // status to an unauthenticated caller (enumeration).
        return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'viewer_signup_failed', message: 'Could not create viewer account', traceId: request.id });
      }
    },
  );

  app.post<{ Body: { email: string; password: string; deviceLabel: string } }>(
    '/v1/viewer/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password', 'deviceLabel'],
          properties: { email: EMAIL_SCHEMA, password: PASSWORD_SCHEMA, deviceLabel: { type: 'string', minLength: 1, maxLength: 80 } },
        },
      },
    },
    async (request, reply) => {
      if (!viewer) {
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'viewer_auth_unavailable', message: 'Viewer login is temporarily unavailable', traceId: request.id, retryable: true });
      }
      const result = await viewer.login(request.body.email, request.body.password, request.body.deviceLabel);
      if (!result) {
        return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'invalid_viewer_credentials', message: 'Email or password is incorrect', traceId: request.id });
      }
      return reply.code(201).send({ schemaVersion: 'v1', accessToken: result.accessToken, expiresAt: result.expiresAt });
    },
  );

  app.post('/v1/viewer/logout', { preHandler: viewerAuth }, async (request, reply) => {
    if (!viewer || !request.viewerAuth) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Viewer authentication required', traceId: request.id });
    await viewer.revokeSession(request.viewerAuth.viewerAccountId, request.viewerAuth.sessionId);
    return reply.code(204).send();
  });

  app.get('/v1/viewer/sessions', { preHandler: viewerAuth }, async (request, reply) => {
    if (!viewer || !request.viewerAuth) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Viewer authentication required', traceId: request.id });
    const sessions = await viewer.listSessions(request.viewerAuth.viewerAccountId);
    const withCurrent = sessions.map((session) => ({ ...session, current: session.sessionId === request.viewerAuth?.sessionId }));
    return { schemaVersion: 'v1', sessions: withCurrent };
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/v1/viewer/sessions/:sessionId',
    {
      preHandler: viewerAuth,
      schema: { params: { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId: { type: 'string', format: 'uuid' } } } },
    },
    async (request, reply) => {
      if (!viewer || !request.viewerAuth) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Viewer authentication required', traceId: request.id });
      const revoked = await viewer.revokeSession(request.viewerAuth.viewerAccountId, request.params.sessionId);
      return revoked ? reply.code(204).send() : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Session not found', traceId: request.id });
    },
  );

  // Private lifetime dashboard: the viewer's OWN support history across
  // every creator they have supported. Never reachable by a creator route —
  // gated only by request.viewerAuth, which a creator session can never
  // populate (separate token namespace, separate lookup function).
  app.get('/v1/viewer/dashboard', { preHandler: viewerAuth }, async (request, reply) => {
    if (!viewer || !request.viewerAuth) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Viewer authentication required', traceId: request.id });
    const rows = await viewer.getDashboard(request.viewerAuth.viewerAccountId);
    return { schemaVersion: 'v1', supportedChannels: rows };
  });

  app.post('/v1/viewer/deletion-requests', { preHandler: viewerAuth }, async (request, reply) => {
    if (!viewer || !request.viewerAuth) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Viewer authentication required', traceId: request.id });
    const erasure = await viewer.requestDeletion(request.viewerAuth.viewerAccountId);
    return reply.code(202).send(erasure);
  });

  // Batch 3: password reset. See migration 0088 for the token/enumeration
  // design; this route's own responsibility is narrow — call the store and
  // send back one fixed shape regardless of what the store found, so no
  // response ever confirms/denies whether an email is registered.
  //
  // Throttled tighter than the app-wide 120/min limiter (app.ts) — this is
  // the one unauthenticated, email-triggering surface in this file.
  app.post<{ Body: { email: string } }>(
    '/v1/viewer/password/forgot',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email'],
          properties: { email: EMAIL_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      if (!viewer) {
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'viewer_auth_unavailable', message: 'Password reset is temporarily unavailable', traceId: request.id, retryable: true });
      }
      // Deliberately unconditional: requestPasswordReset never reveals
      // whether `email` matched an account (enumeration defence), so this
      // response is identical for a known and an unknown address. A
      // downstream store failure is treated the same way — never turned
      // into a distinguishing error — for the same reason.
      try {
        await viewer.requestPasswordReset(request.body.email);
      } catch {
        // swallow: same generic response either way
      }
      return reply.code(202).send({ schemaVersion: 'v1', status: 'requested', message: 'If that email is registered, a reset link has been sent' });
    },
  );

  app.post<{ Body: { token: string; newPassword: string } }>(
    '/v1/viewer/password/reset',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['token', 'newPassword'],
          properties: {
            token: { type: 'string', minLength: 16, maxLength: 512 },
            newPassword: PASSWORD_SCHEMA,
          },
        },
      },
    },
    async (request, reply) => {
      if (!viewer) {
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'viewer_auth_unavailable', message: 'Password reset is temporarily unavailable', traceId: request.id, retryable: true });
      }
      const ok = await viewer.resetPassword(request.body.token, request.body.newPassword);
      if (!ok) {
        // One generic failure shape for invalid, already-used, and expired
        // tokens — never distinguished (see ViewerPasswordResetStore's own
        // contract comment).
        return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_reset_token', message: 'This reset link is invalid or has expired', traceId: request.id });
      }
      return reply.code(200).send({ schemaVersion: 'v1', status: 'reset', message: 'Your password has been reset. Please sign in again.' });
    },
  );

  // ---------------------------------------------------------------------
  // L14 missing slices: no-account receipt, platform claim, badges,
  // opt-in public profile search. See domain/viewer-profile-store.ts.
  // ---------------------------------------------------------------------

  // Public, no auth: the payer's own browser calls this right after
  // checkout with the intent id it already polled for status. Never
  // returns the same token twice for one payment (see mintReceipt's
  // contract) — a 409 on repeat is deliberate, not a bug.
  app.post<{ Body: { intentId: string } }>(
    '/v1/public/receipts',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: { type: 'object', additionalProperties: false, required: ['intentId'], properties: { intentId: { type: 'string', format: 'uuid' } } },
      },
    },
    async (request, reply) => {
      if (!viewer || !viewer.profile) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'viewer_auth_unavailable', message: 'Receipts are temporarily unavailable', traceId: request.id, retryable: true });
      const result = await viewer.profile.mintReceipt(request.body.intentId);
      if (!result.minted) {
        return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'receipt_unavailable', message: 'No new receipt is available for this payment', traceId: request.id });
      }
      return reply.code(201).send({ schemaVersion: 'v1', token: result.token });
    },
  );

  // Public, no auth, no account: the receipt page itself. Token is an
  // opaque fingerprint match only (see migration 0107) — this route
  // never trusts or decodes anything from the token beyond that lookup.
  app.get<{ Params: { token: string } }>(
    '/v1/public/receipts/:token',
    { schema: { params: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: { type: 'string', minLength: 8, maxLength: 32 } } } } },
    async (request, reply) => {
      if (!viewer || !viewer.profile) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'viewer_auth_unavailable', message: 'Receipts are temporarily unavailable', traceId: request.id, retryable: true });
      const receipt = await viewer.profile.resolveReceipt(request.params.token);
      if (!receipt) return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Receipt not found', traceId: request.id });
      return { schemaVersion: 'v1', receipt };
    },
  );

  // Platform-identity claim. The request names the provider only; the L15
  // adapter must resolve its server-verified identity for this viewer. Never
  // accept a provider user id or display name from the browser.
  app.post<{ Body: { provider: 'youtube' } }>(
    '/v1/viewer/platform-claims',
    {
      preHandler: viewerAuth,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['provider'],
          properties: {
            provider: { type: 'string', enum: ['youtube'] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!viewer || !viewer.profile || !request.viewerAuth) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Viewer authentication required', traceId: request.id });
      if (!platformIdentityVerifier) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'platform_identity_unavailable', message: 'Platform linking is temporarily unavailable', traceId: request.id, retryable: true });
      const verified = await platformIdentityVerifier.getVerifiedIdentity(request.viewerAuth.viewerAccountId, request.body.provider);
      if (!verified) return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'platform_identity_not_verified', message: 'Verify this platform account before claiming its history', traceId: request.id });
      const outcome = await viewer.profile.claimPlatformIdentity(
        request.viewerAuth.viewerAccountId,
        request.body.provider,
        verified.providerUserId,
        verified.displayName,
      );
      if (outcome.result === 'rejected_contested') {
        return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'platform_identity_already_claimed', message: 'This platform account is already linked to a different BharatStudio account', traceId: request.id });
      }
      return reply.code(outcome.result === 'claimed' ? 201 : 200).send({ schemaVersion: 'v1', viewerIdentityId: outcome.viewerIdentityId, result: outcome.result });
    },
  );

  // Own badges for one channel — never a creator-scoped route, gated only
  // by request.viewerAuth exactly like /v1/viewer/dashboard above.
  app.get<{ Params: { channelId: string } }>(
    '/v1/viewer/channels/:channelId/badges',
    { preHandler: viewerAuth, schema: { params: { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } } },
    async (request, reply) => {
      if (!viewer || !request.viewerAuth) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Viewer authentication required', traceId: request.id });
      if (!viewer.profile) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'viewer_auth_unavailable', message: 'Viewer profiles are temporarily unavailable', traceId: request.id, retryable: true });
      const badges = await viewer.profile.getChannelBadges(request.viewerAuth.viewerAccountId, request.params.channelId);
      // Do not spread a persistence object into a response. This is a
      // deliberate narrow projection: account, payment, provider and future
      // store-only fields must not become a client contract by accident.
      return {
        schemaVersion: 'v1',
        badges: {
          netTipCount: badges.netTipCount,
          netLifetimeAmountPaise: badges.netLifetimeAmountPaise,
          firstSupportedAt: badges.firstSupportedAt,
          currentStreakDays: badges.currentStreakDays,
          badges: badges.badges,
        },
      };
    },
  );

  app.put<{ Body: { visibility: 'private' | 'public'; slug?: string | null } }>(
    '/v1/viewer/profile-visibility',
    {
      preHandler: viewerAuth,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['visibility'],
          properties: { visibility: { type: 'string', enum: ['private', 'public'] }, slug: { type: ['string', 'null'], minLength: 3, maxLength: 60 } },
          allOf: [
            {
              if: { required: ['visibility'], properties: { visibility: { const: 'public' } } },
              then: { required: ['slug'], properties: { slug: { type: 'string', minLength: 3, maxLength: 60 } } },
            },
            {
              if: { required: ['visibility'], properties: { visibility: { const: 'private' } } },
              then: { properties: { slug: { type: 'null' } } },
            },
          ],
        },
      },
    },
    async (request, reply) => {
      if (!viewer || !request.viewerAuth) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Viewer authentication required', traceId: request.id });
      if (!viewer.profile) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'viewer_auth_unavailable', message: 'Viewer profiles are temporarily unavailable', traceId: request.id, retryable: true });
      try {
        const result = await viewer.profile.setProfileVisibility(request.viewerAuth.viewerAccountId, request.body.visibility, request.body.slug ?? null);
        return { schemaVersion: 'v1', visibility: result.visibility, slug: result.slug };
      } catch (error) {
        if (databaseErrorCode(error) !== '23505' && databaseErrorCode(error) !== '22023') {
          return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'viewer_auth_unavailable', message: 'Viewer profiles are temporarily unavailable', traceId: request.id, retryable: true });
        }
        return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'profile_slug_taken', message: 'That profile link is already taken or invalid', traceId: request.id });
      }
    },
  );

  // Public search + profile lookup: structurally can never return a
  // private profile (see app_private.search_public_viewer_profiles /
  // get_public_viewer_profile — the where clause is not caller-supplied).
  app.get<{ Querystring: { q?: string } }>('/v1/public/viewer-profiles', async (request) => {
    if (!viewer || !viewer.profile) return { schemaVersion: 'v1', profiles: [] };
    const profiles = await viewer.profile.searchPublicProfiles(request.query.q ?? null);
    return { schemaVersion: 'v1', profiles };
  });

  app.get<{ Params: { slug: string } }>(
    '/v1/public/viewer-profiles/:slug',
    { schema: { params: { type: 'object', additionalProperties: false, required: ['slug'], properties: { slug: { type: 'string', minLength: 1, maxLength: 60 } } } } },
    async (request, reply) => {
      if (!viewer || !viewer.profile) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'viewer_auth_unavailable', message: 'Profiles are temporarily unavailable', traceId: request.id, retryable: true });
      const profile = await viewer.profile.getPublicProfile(request.params.slug);
      if (!profile) return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Profile not found', traceId: request.id });
      return { schemaVersion: 'v1', profile };
    },
  );
}
