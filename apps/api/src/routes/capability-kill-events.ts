import type { FastifyInstance } from 'fastify';
import { requirePlatformAdminMfa } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import { CapabilityKillEventError, type CapabilityKillEventStore } from '../domain/capability-kill-events.js';
import { logSafeError } from '../observability/safe-log.js';
import type { AdminPasskeyStore, AdminWebAuthnConfig } from '../domain/admin-passkeys.js';

// Migration 0155, Job 2. Platform-staff-only surface over §20.6.1's
// emergency global_kill path -- fire, ratify, propose/approve an
// extension, file a post-incident review, get/list. Same
// requirePlatformAdminMfa gate, same unavailable-but-safe-503 posture as
// every other admin route in this codebase. Its own file, its own
// migration, its own subsystem -- distinct from routes/capability-
// change-management.ts's existing kill (migration 0152's ordinary,
// no-expiry, no-ratification per-capability kill_switch path, untouched
// here).

const killEventIdParams = {
  type: 'object', additionalProperties: false, required: ['killEventId'],
  properties: { killEventId: { type: 'string', format: 'uuid' } },
} as const;

const capabilityKeyParams = {
  type: 'object', additionalProperties: false, required: ['capabilityKey'],
  properties: { capabilityKey: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,99}$' } },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'capability_kill_events_unavailable', message: 'Emergency kill administration is temporarily unavailable', traceId, retryable: true });
}

function errorResponse(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string, error: CapabilityKillEventError) {
  const status = error.reason === 'capability_not_found' || error.reason === 'kill_event_not_found' || error.reason === 'extension_request_not_found'
    ? 404
    : error.reason === 'duplicate_action' || error.reason === 'blocked_on_missing_review'
      ? 409
      : error.reason === 'self_action_forbidden'
        ? 403
        : 400;
  return reply.code(status).send({ schemaVersion: 'v1', errorCode: error.reason, message: error.message, traceId, retryable: false });
}

export async function registerCapabilityKillEventRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: CapabilityKillEventStore,
  adminGate?: { isPlatformAdmin(userId: string): Promise<boolean> },
  adminPasskeys?: AdminPasskeyStore,
  adminWebAuthn?: AdminWebAuthnConfig,
): Promise<void> {
  const adminAuth = requirePlatformAdminMfa(sessions, adminGate, adminPasskeys, adminWebAuthn?.mfaMaxAgeSeconds);

  // WHO MAY FIRE / WHAT IT DOES: one admin, alone, immediate. Reason
  // mandatory; affected/live channel counts caller-supplied (§20.6's own
  // impact-preview feature, a separate admin-UI concern, not built here
  // -- see migration 0155's own Job 2 header).
  app.post<{ Params: { capabilityKey: string }; Body: { reason: string; affectedChannelCount: number; liveChannelCount: number } }>(
    '/v1/admin/capability-registry/:capabilityKey/emergency-kill', {
    preHandler: adminAuth,
    schema: {
      params: capabilityKeyParams,
      body: {
        type: 'object', additionalProperties: false,
        required: ['reason', 'affectedChannelCount', 'liveChannelCount'],
        properties: {
          reason: { type: 'string', minLength: 1, maxLength: 500 },
          affectedChannelCount: { type: 'integer', minimum: 0 },
          liveChannelCount: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const event = await store.fireKill(request.auth.userId, {
        capabilityKey: request.params.capabilityKey,
        reason: request.body.reason,
        affectedChannelCount: request.body.affectedChannelCount,
        liveChannelCount: request.body.liveChannelCount,
      });
      return reply.code(201).send(event);
    } catch (error) {
      if (error instanceof CapabilityKillEventError) return errorResponse(reply, request.id, error);
      logSafeError(request, 'capability_emergency_kill_fire_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // Ratification: a second, distinct admin, within the 4-hour window
  // (escalatedToOwner reads true past that mark until this call lands).
  app.post<{ Params: { killEventId: string } }>('/v1/admin/emergency-kills/:killEventId/ratify', {
    preHandler: adminAuth,
    schema: { params: killEventIdParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const event = await store.ratifyKill(request.auth.userId, request.params.killEventId);
      return reply.code(200).send(event);
    } catch (error) {
      if (error instanceof CapabilityKillEventError) return errorResponse(reply, request.id, error);
      logSafeError(request, 'capability_emergency_kill_ratify_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // Extension, propose half -- capped at requestedAt + 24 hours, must
  // move the effective expiry forward. There is no indefinite kill.
  app.post<{ Params: { killEventId: string }; Body: { newExpiresAt: string; reason: string } }>('/v1/admin/emergency-kills/:killEventId/extensions', {
    preHandler: adminAuth,
    schema: {
      params: killEventIdParams,
      body: {
        type: 'object', additionalProperties: false, required: ['newExpiresAt', 'reason'],
        properties: { newExpiresAt: { type: 'string', format: 'date-time' }, reason: { type: 'string', minLength: 1, maxLength: 500 } },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const extension = await store.proposeExtension(request.auth.userId, {
        killEventId: request.params.killEventId, newExpiresAt: request.body.newExpiresAt, reason: request.body.reason,
      });
      return reply.code(201).send(extension);
    } catch (error) {
      if (error instanceof CapabilityKillEventError) return errorResponse(reply, request.id, error);
      logSafeError(request, 'capability_emergency_kill_extension_propose_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // Extension, approve half -- a SECOND, distinct admin. Only then does
  // the effective expiry actually move.
  app.post<{ Params: { extensionRequestId: string } }>('/v1/admin/emergency-kills/extensions/:extensionRequestId/approve', {
    preHandler: adminAuth,
    schema: {
      params: {
        type: 'object', additionalProperties: false, required: ['extensionRequestId'],
        properties: { extensionRequestId: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const event = await store.approveExtension(request.auth.userId, request.params.extensionRequestId);
      return reply.code(200).send(event);
    } catch (error) {
      if (error instanceof CapabilityKillEventError) return errorResponse(reply, request.id, error);
      logSafeError(request, 'capability_emergency_kill_extension_approve_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // Post-incident review -- mandatory; a kill with none blocks this
  // actor's next fire (surfaced as 409 blocked_on_missing_review there).
  app.post<{ Params: { killEventId: string }; Body: { reviewText: string } }>('/v1/admin/emergency-kills/:killEventId/review', {
    preHandler: adminAuth,
    schema: {
      params: killEventIdParams,
      body: { type: 'object', additionalProperties: false, required: ['reviewText'], properties: { reviewText: { type: 'string', minLength: 1, maxLength: 5000 } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const event = await store.fileReview(request.auth.userId, request.params.killEventId, request.body.reviewText);
      return reply.code(200).send(event);
    } catch (error) {
      if (error instanceof CapabilityKillEventError) return errorResponse(reply, request.id, error);
      logSafeError(request, 'capability_emergency_kill_review_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.get<{ Params: { killEventId: string } }>('/v1/admin/emergency-kills/:killEventId', {
    preHandler: adminAuth,
    schema: { params: killEventIdParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const event = await store.getKillEvent(request.auth.userId, request.params.killEventId);
    if (!event) {
      return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'kill_event_not_found', message: 'Emergency kill event not found', traceId: request.id });
    }
    return reply.code(200).send(event);
  });

  app.get<{ Querystring: { capabilityKey?: string; limit?: number } }>('/v1/admin/emergency-kills', {
    preHandler: adminAuth,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          capabilityKey: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,99}$' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const events = await store.listKillEvents(request.auth.userId, request.query.capabilityKey ?? null, request.query.limit ?? 50);
    return reply.code(200).send({ schemaVersion: 'v1', events });
  });
}
