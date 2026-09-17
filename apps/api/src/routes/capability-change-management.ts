import type { FastifyInstance } from 'fastify';
import { requirePlatformAdmin } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import { CapabilityChangeManagementError, type CapabilityChangeManagementStore, type CapabilityChangeStatus } from '../domain/capability-change-management.js';
import { logSafeError } from '../observability/safe-log.js';

// CTL phase 2, Lane A (migration 0152). Platform-staff-only governance
// surface over the phase-1 capability control plane -- same
// requirePlatformAdmin gate, same unavailable-but-safe-503 posture, and
// the same response-envelope idiom as every route in routes/admin.ts.
// Deliberately its OWN file, not folded into admin.ts -- this plane is a
// distinct subsystem (staged changes, approvals, kill, revert) built
// against its own migration, the same posture routes/capabilities.ts
// already took for CTL phase 1.
//
// This is the "-> alerts API" half of CTL phase 2 Lane A
// (bharatstudio-requirements/active/tasks/CTL-01-capability-control-plane.md's
// own phase-2 lane table). It is NOT CTL-04's admin UI -- that is a
// different repository (Lane C) that will eventually call these routes.

const changeIdParams = {
  type: 'object', additionalProperties: false, required: ['changeRequestId'],
  properties: { changeRequestId: { type: 'string', format: 'uuid' } },
} as const;

const capabilityKeyParams = {
  type: 'object', additionalProperties: false, required: ['capabilityKey'],
  properties: { capabilityKey: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,99}$' } },
} as const;

const statuses: CapabilityChangeStatus[] = ['pending_approval', 'approved', 'applied', 'rejected'];
const capacityClasses = [
  'active_connector', 'active_widget', 'ai_usage', 'media_upload',
  'custom_asset', 'team_seat', 'automation_volume', 'master_canvas_module',
] as const;
const tiers = ['free', 'pro', 'creator', 'studio'] as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'capability_change_management_unavailable', message: 'Capability change management is temporarily unavailable', traceId, retryable: true });
}

// Maps CapabilityChangeManagementError.reason to the response this route
// layer sends -- the one place that translates the SQL layer's business
// rules into HTTP semantics. See domain/capability-change-management.ts
// for why a single SQLSTATE (22023) needed this richer classification.
function errorResponse(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string, error: CapabilityChangeManagementError) {
  const status = error.reason === 'not_found' || error.reason === 'capability_not_found'
    ? 404
    : error.reason === 'duplicate_approval' || error.reason === 'not_open'
      ? 409
      : error.reason === 'self_approval_forbidden'
        ? 403
        : 400;
  return reply.code(status).send({ schemaVersion: 'v1', errorCode: error.reason, message: error.message, traceId, retryable: false });
}

export async function registerCapabilityChangeManagementRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: CapabilityChangeManagementStore,
  adminGate?: { isPlatformAdmin(userId: string): Promise<boolean> },
): Promise<void> {
  const adminAuth = requirePlatformAdmin(sessions, adminGate);

  // CTL-06: propose an ordinary governed change. effectiveAt omitted
  // means "now" -- an unstaged change still goes through the same
  // CTL-07 approval gate.
  app.post<{ Body: {
    capabilityKey: string; capacityClass: typeof capacityClasses[number]; description: string;
    killSwitch?: boolean; rolloutPercentage?: number; minTier?: typeof tiers[number] | null;
    effectiveAt?: string; reason?: string;
  } }>('/v1/admin/capability-registry/changes', {
    preHandler: adminAuth,
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['capabilityKey', 'capacityClass', 'description'],
        properties: {
          capabilityKey: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,99}$' },
          capacityClass: { type: 'string', enum: [...capacityClasses] },
          description: { type: 'string', minLength: 1, maxLength: 500 },
          killSwitch: { type: 'boolean' },
          rolloutPercentage: { type: 'integer', minimum: 0, maximum: 100 },
          minTier: { type: ['string', 'null'], enum: [...tiers, null] },
          effectiveAt: { type: 'string', format: 'date-time' },
          reason: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const change = await store.proposeChange(request.auth.userId, {
        capabilityKey: request.body.capabilityKey,
        capacityClass: request.body.capacityClass,
        description: request.body.description,
        killSwitch: request.body.killSwitch ?? false,
        rolloutPercentage: request.body.rolloutPercentage ?? 100,
        minTier: request.body.minTier ?? null,
        effectiveAt: request.body.effectiveAt ?? null,
        reason: request.body.reason ?? null,
      });
      return reply.code(201).send(change);
    } catch (error) {
      if (error instanceof CapabilityChangeManagementError) return errorResponse(reply, request.id, error);
      logSafeError(request, 'capability_change_propose_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.get<{ Querystring: { status?: CapabilityChangeStatus; limit?: number } }>('/v1/admin/capability-registry/changes', {
    preHandler: adminAuth,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { status: { type: 'string', enum: statuses }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const changes = await store.listChanges(request.auth.userId, request.query.status ?? null, request.query.limit ?? 50);
    return reply.code(200).send({ schemaVersion: 'v1', changes });
  });

  app.get<{ Params: { changeRequestId: string } }>('/v1/admin/capability-registry/changes/:changeRequestId', {
    preHandler: adminAuth,
    schema: { params: changeIdParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const change = await store.getChange(request.auth.userId, request.params.changeRequestId);
    if (!change) {
      return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Capability change request not found', traceId: request.id });
    }
    const approvals = await store.listApprovals(request.auth.userId, request.params.changeRequestId);
    return reply.code(200).send({ ...change, approvals });
  });

  // CTL-07: record one approval. approvalKind='owner' is rejected by
  // the SQL layer when the change does not require it (400,
  // owner_signoff_not_required) -- see this migration's own header note
  // on the identity gap an 'owner' approval still has.
  app.post<{ Params: { changeRequestId: string }; Body: { approvalKind: 'staff' | 'owner' } }>('/v1/admin/capability-registry/changes/:changeRequestId/approve', {
    preHandler: adminAuth,
    schema: {
      params: changeIdParams,
      body: { type: 'object', additionalProperties: false, required: ['approvalKind'], properties: { approvalKind: { type: 'string', enum: ['staff', 'owner'] } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const change = await store.approveChange(request.auth.userId, request.params.changeRequestId, request.body.approvalKind);
      return reply.code(200).send(change);
    } catch (error) {
      if (error instanceof CapabilityChangeManagementError) return errorResponse(reply, request.id, error);
      logSafeError(request, 'capability_change_approve_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{ Params: { changeRequestId: string }; Body: { reason: string } }>('/v1/admin/capability-registry/changes/:changeRequestId/reject', {
    preHandler: adminAuth,
    schema: {
      params: changeIdParams,
      body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const change = await store.rejectChange(request.auth.userId, request.params.changeRequestId, request.body.reason);
      return reply.code(200).send(change);
    } catch (error) {
      if (error instanceof CapabilityChangeManagementError) return errorResponse(reply, request.id, error);
      logSafeError(request, 'capability_change_reject_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // CTL-07 rule 3: single-admin global_kill, immediate. No approval body
  // at all -- see this migration's own header for why.
  app.post<{ Params: { capabilityKey: string }; Body: { reason?: string } }>('/v1/admin/capability-registry/:capabilityKey/kill', {
    preHandler: adminAuth,
    schema: {
      params: capabilityKeyParams,
      body: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const change = await store.killCapability(request.auth.userId, request.params.capabilityKey, request.body?.reason ?? null);
      return reply.code(200).send(change);
    } catch (error) {
      if (error instanceof CapabilityChangeManagementError) return errorResponse(reply, request.id, error);
      logSafeError(request, 'capability_kill_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // CTL-08: one-action revert, immediate.
  app.post<{ Params: { capabilityKey: string }; Body: { reason?: string } }>('/v1/admin/capability-registry/:capabilityKey/revert', {
    preHandler: adminAuth,
    schema: {
      params: capabilityKeyParams,
      body: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const change = await store.revertCapability(request.auth.userId, request.params.capabilityKey, request.body?.reason ?? null);
      return reply.code(200).send(change);
    } catch (error) {
      if (error instanceof CapabilityChangeManagementError) return errorResponse(reply, request.id, error);
      logSafeError(request, 'capability_revert_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
