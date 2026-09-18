import type { FastifyInstance } from 'fastify';
import { requirePlatformAdmin, requirePlatformAdminMfa } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import { AdminPasskeyError, AdminPasskeyService, type AdminPasskeyStore, type AdminWebAuthnConfig } from '../domain/admin-passkeys.js';
import { logSafeError } from '../observability/safe-log.js';

function unavailable(reply: { code(status: number): { send(body: unknown): unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'admin_mfa_unavailable', message: 'Privileged passkey authentication is temporarily unavailable', traceId, retryable: true });
}
function failure(reply: { code(status: number): { send(body: unknown): unknown } }, traceId: string, error: AdminPasskeyError) {
  const status = error.code === 'unavailable' ? 503 : error.code === 'not_verified' ? 428 : 400;
  return reply.code(status).send({ schemaVersion: 'v1', errorCode: error.code === 'unavailable' ? 'admin_mfa_unavailable' : error.code, message: error.message, traceId, retryable: error.code === 'unavailable' });
}
function recoveryFailure(reply: { code(status: number): { send(body: unknown): unknown } }, traceId: string, error: unknown) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
  const status = code === '23505' ? 409 : code === '22023' ? 400 : code === '42501' ? 403 : 503;
  const errorCode = status === 409 ? 'admin_mfa_recovery_pending' : status === 400 ? 'admin_mfa_recovery_unavailable' : status === 403 ? 'admin_mfa_recovery_forbidden' : 'admin_mfa_unavailable';
  const message = status === 409 ? 'A passkey recovery request is already pending' : status === 400 ? 'Passkey recovery is unavailable' : status === 403 ? 'Passkey recovery is not permitted' : 'Privileged passkey authentication is temporarily unavailable';
  return reply.code(status).send({ schemaVersion: 'v1', errorCode, message, traceId, retryable: status === 503 });
}

export async function registerAdminPasskeyRoutes(app: FastifyInstance, sessions?: SessionStore, store?: AdminPasskeyStore, config?: AdminWebAuthnConfig, adminGate?: { isPlatformAdmin(userId: string): Promise<boolean> }) {
  const adminAuth = requirePlatformAdmin(sessions, adminGate);
  const adminMfa = requirePlatformAdminMfa(sessions, adminGate, store, config?.mfaMaxAgeSeconds);
  const service = new AdminPasskeyService(store, config);
  app.get('/v1/admin/mfa/status', { preHandler: adminAuth }, async (request, reply) => {
    if (!request.auth) return unavailable(reply, request.id);
    try { return reply.send(await service.status(request.auth)); } catch (error) { if (error instanceof AdminPasskeyError) return failure(reply, request.id, error); logSafeError(request, 'admin_mfa_status_failed', error); return unavailable(reply, request.id); }
  });
  app.post('/v1/admin/mfa/passkeys/registration/options', { preHandler: adminAuth }, async (request, reply) => {
    if (!request.auth) return unavailable(reply, request.id);
    try { return reply.send(await service.registrationOptions(request.auth, request.auth.userId)); } catch (error) { if (error instanceof AdminPasskeyError) return failure(reply, request.id, error); logSafeError(request, 'admin_mfa_registration_options_failed', error); return unavailable(reply, request.id); }
  });
  app.post<{ Body: { ceremonyId: string; response: Parameters<AdminPasskeyService['verifyRegistration']>[2] } }>('/v1/admin/mfa/passkeys/registration/verify', { preHandler: adminAuth, schema: { body: { type: 'object', additionalProperties: false, required: ['ceremonyId', 'response'], properties: { ceremonyId: { type: 'string', format: 'uuid' }, response: { type: 'object' } } } } }, async (request, reply) => {
    if (!request.auth) return unavailable(reply, request.id);
    try { await service.verifyRegistration(request.auth, request.body.ceremonyId, request.body.response); return reply.code(204).send(); } catch (error) { if (error instanceof AdminPasskeyError) return failure(reply, request.id, error); logSafeError(request, 'admin_mfa_registration_verify_failed', error); return unavailable(reply, request.id); }
  });
  app.post('/v1/admin/mfa/assertion/options', { preHandler: adminAuth }, async (request, reply) => {
    if (!request.auth) return unavailable(reply, request.id);
    try { return reply.send(await service.assertionOptions(request.auth)); } catch (error) { if (error instanceof AdminPasskeyError) return failure(reply, request.id, error); logSafeError(request, 'admin_mfa_assertion_options_failed', error); return unavailable(reply, request.id); }
  });
  app.post<{ Body: { ceremonyId: string; response: Parameters<AdminPasskeyService['verifyAssertion']>[2] } }>('/v1/admin/mfa/assertion/verify', { preHandler: adminAuth, schema: { body: { type: 'object', additionalProperties: false, required: ['ceremonyId', 'response'], properties: { ceremonyId: { type: 'string', format: 'uuid' }, response: { type: 'object' } } } } }, async (request, reply) => {
    if (!request.auth) return unavailable(reply, request.id);
    try { const verifiedAt = await service.verifyAssertion(request.auth, request.body.ceremonyId, request.body.response); return reply.send({ schemaVersion: 'v1', verifiedAt }); } catch (error) { if (error instanceof AdminPasskeyError) return failure(reply, request.id, error); logSafeError(request, 'admin_mfa_assertion_verify_failed', error); return unavailable(reply, request.id); }
  });
  app.post('/v1/admin/mfa/recovery/request', { preHandler: adminAuth }, async (request, reply) => {
    if (!request.auth) return unavailable(reply, request.id);
    try { const recoveryId = await service.requestRecovery(request.auth); return reply.code(202).send({ schemaVersion: 'v1', recoveryId }); } catch (error) { logSafeError(request, 'admin_mfa_recovery_request_failed', error); return recoveryFailure(reply, request.id, error); }
  });
  app.get('/v1/admin/mfa/recovery/pending', { preHandler: adminMfa }, async (request, reply) => {
    if (!request.auth) return unavailable(reply, request.id);
    try { return reply.send({ schemaVersion: 'v1', recoveries: await service.listPendingRecoveries(request.auth) }); } catch (error) { logSafeError(request, 'admin_mfa_recovery_pending_failed', error); return recoveryFailure(reply, request.id, error); }
  });
  app.post<{ Params: { recoveryId: string } }>('/v1/admin/mfa/recovery/:recoveryId/approve', { preHandler: adminMfa, schema: { params: { type: 'object', additionalProperties: false, required: ['recoveryId'], properties: { recoveryId: { type: 'string', format: 'uuid' } } } } }, async (request, reply) => {
    if (!request.auth) return unavailable(reply, request.id);
    try { const result = await service.approveRecovery(request.auth, request.params.recoveryId); return reply.send({ schemaVersion: 'v1', ...result }); } catch (error) { logSafeError(request, 'admin_mfa_recovery_approval_failed', error); return recoveryFailure(reply, request.id, error); }
  });
}
