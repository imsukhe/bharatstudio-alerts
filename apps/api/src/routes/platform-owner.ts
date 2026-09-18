import type { FastifyInstance } from 'fastify';
import { requirePlatformAdminMfa } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import { PlatformOwnerError, type PlatformOwnerStore } from '../domain/platform-owner.js';
import { logSafeError } from '../observability/safe-log.js';
import type { AdminPasskeyStore, AdminWebAuthnConfig } from '../domain/admin-passkeys.js';

// Migration 0155, Job 1. Platform-staff-only surface over app_private.
// staff_set_platform_owner -- the ONE path that can ever change
// app_users.is_platform_owner. Same requirePlatformAdminMfa gate, same
// unavailable-but-safe-503 posture as every other admin route in this
// codebase. Deliberately its own file, not folded into admin.ts -- this
// is a distinct, narrow, security-sensitive surface (see domain/
// platform-owner.ts).

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'platform_owner_unavailable', message: 'Platform owner administration is temporarily unavailable', traceId, retryable: true });
}

function errorResponse(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string, error: PlatformOwnerError) {
  const status = error.reason === 'target_not_found'
    ? 404
    : error.reason === 'self_conferral_forbidden'
      ? 403
      : error.reason === 'singleton_violation'
        ? 409
        : 400;
  return reply.code(status).send({ schemaVersion: 'v1', errorCode: error.reason, message: error.message, traceId, retryable: false });
}

export async function registerPlatformOwnerRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: PlatformOwnerStore,
  adminGate?: { isPlatformAdmin(userId: string): Promise<boolean> },
  adminPasskeys?: AdminPasskeyStore,
  adminWebAuthn?: AdminWebAuthnConfig,
): Promise<void> {
  const adminAuth = requirePlatformAdminMfa(sessions, adminGate, adminPasskeys, adminWebAuthn?.mfaMaxAgeSeconds);

  // Owner decision 2026-09-17: never self-conferred (app_private.
  // staff_set_platform_owner rejects actor = targetUserId, 403), always
  // requires a reason, always audited.
  app.put<{ Params: { userId: string }; Body: { isPlatformOwner: boolean; reason: string } }>('/v1/admin/platform-owner/:userId', {
    preHandler: adminAuth,
    schema: {
      params: {
        type: 'object', additionalProperties: false, required: ['userId'],
        properties: { userId: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object', additionalProperties: false, required: ['isPlatformOwner', 'reason'],
        properties: {
          isPlatformOwner: { type: 'boolean' },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const change = await store.setOwner(request.auth.userId, {
        targetUserId: request.params.userId,
        isPlatformOwner: request.body.isPlatformOwner,
        reason: request.body.reason,
      });
      return reply.code(200).send(change);
    } catch (error) {
      if (error instanceof PlatformOwnerError) return errorResponse(reply, request.id, error);
      logSafeError(request, 'platform_owner_set_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
