import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';

export async function registerAccountRoutes(app: FastifyInstance, sessions?: SessionStore, account?: AccountStore): Promise<void> {
  const auth = requireAuth(sessions);
  app.get('/v1/me/terms', { preHandler: auth }, async (request, reply) => {
    if (!account) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'account_store_unavailable', message: 'Account controls are temporarily unavailable', traceId: request.id, retryable: true });
    return reply.send({ schemaVersion: 'v1', documents: await account.listActiveDocuments(), accepted: request.auth ? await account.hasAcceptedActiveDocuments(request.auth.userId) : false });
  });
  app.post<{ Body: { documentKey: 'terms_of_service' | 'privacy_notice'; version: string; contentHash: string } }>('/v1/me/terms/accept', { preHandler: auth, schema: { body: { type: 'object', additionalProperties: false, required: ['documentKey', 'version', 'contentHash'], properties: { documentKey: { type: 'string', enum: ['terms_of_service', 'privacy_notice'] }, version: { type: 'string', minLength: 1, maxLength: 80 }, contentHash: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' } } } } }, async (request, reply) => {
    if (!account || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'account_store_unavailable', message: 'Account controls are temporarily unavailable', traceId: request.id, retryable: true });
    try { return reply.send({ schemaVersion: 'v1', accepted: await account.acceptDocument(request.auth.userId, request.body.documentKey, request.body.version, request.body.contentHash) }); } catch { return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'terms_not_active', message: 'The requested document is not active', traceId: request.id, retryable: false }); }
  });
  app.get('/v1/me/export', { preHandler: auth }, async (request, reply) => {
    if (!account || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'account_store_unavailable', message: 'Account controls are temporarily unavailable', traceId: request.id, retryable: true });
    return reply.send(await account.exportAccount(request.auth.userId));
  });
  app.get('/v1/me/privacy/requests', { preHandler: auth }, async (request, reply) => {
    if (!account || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'account_store_unavailable', message: 'Account controls are temporarily unavailable', traceId: request.id, retryable: true });
    return reply.send({ schemaVersion: 'v1', requests: await account.listPrivacyRequests(request.auth.userId) });
  });
  app.post<{ Body: { requestType: 'access' | 'correction' | 'erasure_review' | 'privacy_concern'; details: string } }>('/v1/me/privacy/requests', { preHandler: auth, schema: { body: { type: 'object', additionalProperties: false, required: ['requestType', 'details'], properties: { requestType: { type: 'string', enum: ['access', 'correction', 'erasure_review', 'privacy_concern'] }, details: { type: 'string', maxLength: 2000 } } } } }, async (request, reply) => {
    if (!account || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'account_store_unavailable', message: 'Account controls are temporarily unavailable', traceId: request.id, retryable: true });
    return reply.code(201).send({ schemaVersion: 'v1', request: await account.createPrivacyRequest(request.auth.userId, request.body.requestType, request.body.details) });
  });
  app.post<{ Body: { reason: string } }>('/v1/me/close', { preHandler: auth, schema: { body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', maxLength: 500 } } } } }, async (request, reply) => {
    if (!account || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'account_store_unavailable', message: 'Account controls are temporarily unavailable', traceId: request.id, retryable: true });
    const closedAt = await account.closeAccount(request.auth.userId, request.body.reason);
    return reply.send({ schemaVersion: 'v1', status: 'deactivated', accessRevokedAt: closedAt, retainedData: 'limited data may remain for payments, taxes, fraud prevention, disputes, security and legal obligations' });
  });
}
