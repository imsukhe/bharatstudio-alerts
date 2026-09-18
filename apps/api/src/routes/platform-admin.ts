import type { FastifyInstance } from 'fastify';
import { requirePlatformAdminMfa } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import { PlatformAdminError, type PlatformAdminStore } from '../domain/platform-admin.js';
import { logSafeError } from '../observability/safe-log.js';
import type { AdminPasskeyStore, AdminWebAuthnConfig } from '../domain/admin-passkeys.js';

// Migration 0156 (ADM-07). Platform-staff-only surface over app_private.
// staff_set_platform_admin -- the ONE path that can ever change
// app_users.is_platform_admin through the application layer -- and
// app_private.staff_list_platform_admins, a read of the current
// registry. Same requirePlatformAdminMfa gate, same unavailable-but-safe-503
// posture as every other admin route in this codebase. Modelled directly
// on routes/platform-owner.ts (migration 0155, Job 1); its own file for
// the same reason that one is its own file -- a distinct, narrow,
// security-sensitive surface (see domain/platform-admin.ts).

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'platform_admin_unavailable', message: 'Platform admin administration is temporarily unavailable', traceId, retryable: true });
}

function errorResponse(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string, error: PlatformAdminError) {
  const status = error.reason === 'target_not_found'
    ? 404
    : error.reason === 'self_conferral_forbidden'
      ? 403
      : 400;
  return reply.code(status).send({ schemaVersion: 'v1', errorCode: error.reason, message: error.message, traceId, retryable: false });
}

export async function registerPlatformAdminRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: PlatformAdminStore,
  adminGate?: { isPlatformAdmin(userId: string): Promise<boolean> },
  adminPasskeys?: AdminPasskeyStore,
  adminWebAuthn?: AdminWebAuthnConfig,
): Promise<void> {
  const adminAuth = requirePlatformAdminMfa(sessions, adminGate, adminPasskeys, adminWebAuthn?.mfaMaxAgeSeconds);

  // ADM-07: never self-conferred (app_private.staff_set_platform_admin
  // rejects actor = targetUserId, 403, in both the grant and the revoke
  // direction), always requires a reason, always audited.
  app.put<{ Params: { userId: string }; Body: { isPlatformAdmin: boolean; reason: string } }>('/v1/admin/platform-admins/:userId', {
    preHandler: adminAuth,
    schema: {
      params: {
        type: 'object', additionalProperties: false, required: ['userId'],
        properties: { userId: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object', additionalProperties: false, required: ['isPlatformAdmin', 'reason'],
        properties: {
          isPlatformAdmin: { type: 'boolean' },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const change = await store.setAdmin(request.auth.userId, {
        targetUserId: request.params.userId,
        isPlatformAdmin: request.body.isPlatformAdmin,
        reason: request.body.reason,
      });
      return reply.code(200).send(change);
    } catch (error) {
      if (error instanceof PlatformAdminError) return errorResponse(reply, request.id, error);
      logSafeError(request, 'platform_admin_set_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.get('/v1/admin/platform-admins', { preHandler: adminAuth }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const admins = await store.listAdmins(request.auth.userId);
      return reply.code(200).send({ schemaVersion: 'v1', admins });
    } catch (error) {
      logSafeError(request, 'platform_admin_list_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
