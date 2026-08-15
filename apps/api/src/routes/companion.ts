import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AlertStore, CompanionAction, CompanionActionSlot, CompanionControlSession } from '../domain/alert-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const controlSessionParams = { type: 'object', additionalProperties: false, required: ['channelId', 'sessionId'], properties: { channelId: uuid, sessionId: uuid } } as const;
const idempotencyKeyPattern = '^[A-Za-z0-9._:-]+$';
const actions: CompanionAction[] = ['pause_queue', 'resume_queue', 'send_test_alert'];
const slotSchema = {
  type: 'object', additionalProperties: false,
  required: ['slotIndex', 'page', 'label', 'action', 'targetId'],
  properties: {
    slotIndex: { type: 'integer', minimum: 1, maximum: 64 },
    page: { type: 'integer', minimum: 1, maximum: 16 },
    label: { type: 'string', minLength: 1, maxLength: 80 },
    action: { type: 'string', enum: actions },
    targetId: uuid,
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'companion_store_unavailable', message: 'Companion controls are temporarily unavailable', traceId, retryable: true });
}

export async function registerCompanionRoutes(app: FastifyInstance, sessions?: SessionStore, store?: AlertStore): Promise<void> {
  const auth = requireAuth(sessions);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/companion/state', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const result = await store.getCompanionState(request.auth.userId, request.params.channelId);
    return result ? reply.code(200).send(result) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Companion state not found', traceId: request.id });
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/companion/layout', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const result = await store.getCompanionLayout(request.auth.userId, request.params.channelId);
    return result ? reply.code(200).send(result) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Companion layout not found', traceId: request.id });
  });

  app.patch<{
    Params: { channelId: string };
    Headers: { 'if-match-version'?: string };
    Body: { pageSize: 4 | 8 | 16; slots: CompanionActionSlot[] };
  }>('/v1/channels/:channelId/companion/layout', {
    preHandler: auth,
    schema: {
      params: channelParams,
      headers: { type: 'object', required: ['if-match-version'], properties: { 'if-match-version': { type: 'string', pattern: '^(0|[1-9][0-9]*)$' } } },
      body: { type: 'object', additionalProperties: false, required: ['pageSize', 'slots'], properties: { pageSize: { type: 'integer', enum: [4, 8, 16] }, slots: { type: 'array', maxItems: 64, items: slotSchema } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const expectedVersion = Number(request.headers['if-match-version']);
    try {
      const result = await store.updateCompanionLayout(request.auth.userId, request.params.channelId, expectedVersion, request.body.pageSize, request.body.slots);
      return result
        ? reply.code(200).send(result)
        : reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_layout_version_conflict', message: 'Companion layout changed; reload before saving', traceId: request.id, retryable: false });
    } catch (error) {
      logSafeError(request, 'companion_layout_update_failed', error);
      const message = error instanceof Error ? error.message : '';
      if (/layout version conflict/i.test(message)) return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_layout_version_conflict', message: 'Companion layout changed; reload before saving', traceId: request.id, retryable: false });
      if (/Companion|companion/i.test(message)) return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_layout_invalid', message: 'Companion layout could not be saved', traceId: request.id, retryable: false });
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_layout_rejected', message: 'Companion layout could not be saved', traceId: request.id, retryable: true });
    }
  });

  app.post<{
    Params: { channelId: string };
    Body: { clientType: CompanionControlSession['clientType']; clientInstanceId: string };
  }>('/v1/channels/:channelId/companion/control-session', {
    preHandler: auth,
    schema: {
      params: channelParams,
      body: {
        type: 'object', additionalProperties: false, required: ['clientType', 'clientInstanceId'],
        properties: {
          clientType: { type: 'string', enum: ['web', 'mobile', 'desktop'] },
          clientInstanceId: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
        },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      return reply.code(201).send(await store.acquireCompanionControlSession(request.auth.userId, request.params.channelId, request.body.clientType, request.body.clientInstanceId));
    } catch (error) {
      logSafeError(request, 'companion_control_session_acquire_failed', error);
      const message = error instanceof Error ? error.message : '';
      if (/already active/i.test(message)) return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_control_busy', message: 'Another Companion control session is active', traceId: request.id, retryable: true });
      if (/access denied|not found/i.test(message)) return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'forbidden', message: 'Companion control access denied', traceId: request.id, retryable: false });
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_control_invalid', message: 'Companion control session could not be created', traceId: request.id, retryable: false });
    }
  });

  app.delete<{ Params: { channelId: string; sessionId: string } }>('/v1/channels/:channelId/companion/control-session/:sessionId', {
    preHandler: auth,
    schema: { params: controlSessionParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const revoked = await store.revokeCompanionControlSession(request.auth.userId, request.params.channelId, request.params.sessionId);
      return revoked ? reply.code(204).send() : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Companion control session not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'companion_control_session_revoke_failed', error);
      return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'forbidden', message: 'Companion control access denied', traceId: request.id, retryable: false });
    }
  });

  app.post<{ Params: { channelId: string }; Headers: { 'idempotency-key'?: string }; Body: { action: CompanionAction; targetId?: string | null } }>('/v1/channels/:channelId/companion/actions', {
    preHandler: auth,
    schema: {
      params: channelParams,
      headers: { type: 'object', properties: { 'idempotency-key': { type: 'string', minLength: 16, maxLength: 128, pattern: idempotencyKeyPattern } } },
      body: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: actions }, targetId: { type: ['string', 'null'], format: 'uuid' } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'idempotency_key_required', message: 'Idempotency-Key is required', traceId: request.id });
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_idempotency_key', message: 'A valid Idempotency-Key header is required', traceId: request.id, retryable: false });
    if (!request.body.targetId) return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_target_required', message: 'A queue target is required for this Companion action', traceId: request.id, retryable: false });
    try {
      return reply.code(202).send(await store.executeCompanionAction(request.auth.userId, request.params.channelId, request.body.action, request.body.targetId ?? null, idempotencyKey));
    } catch (error) {
      logSafeError(request, 'companion_action_failed', error);
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_action_rejected', message: 'Companion action could not be accepted', traceId: request.id, retryable: true });
    }
  });
}
