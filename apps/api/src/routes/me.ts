import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { NotificationStore } from '../domain/notification-store.js';
import type { NotificationTokenProtector } from '../notifications/token-crypto.js';
import type { AccountStore } from '../domain/account-store.js';

export async function registerMeRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  notifications?: NotificationStore,
  tokenProtector?: NotificationTokenProtector,
  account?: AccountStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);
  app.get('/v1/me', { preHandler: auth }, async (request, reply) => {
    if (!sessions || !request.auth) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Authentication required', traceId: request.id });
    return sessions.getCurrentUser(request.auth.userId);
  });

  app.get('/v1/me/sessions', { preHandler: auth }, async (request, reply) => {
    if (!sessions || !request.auth) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Authentication required', traceId: request.id });
    const sessionsList = await sessions.list(request.auth.userId);
    const current = sessionsList.map((session) => ({ ...session, current: session.sessionId === request.auth?.sessionId }));
    return { schemaVersion: 'v1', sessions: current };
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/v1/me/sessions/:sessionId',
    {
      preHandler: termsAuth,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['sessionId'],
          properties: { sessionId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      if (!sessions || !request.auth) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Authentication required', traceId: request.id });
      const revoked = await sessions.revoke(request.auth.userId, request.params.sessionId);
      return revoked ? reply.code(204).send() : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Session not found', traceId: request.id });
    },
  );

  app.get('/v1/me/notifications/preferences', { preHandler: auth }, async (request, reply) => {
    if (!notifications || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'notification_store_unavailable', message: 'Notification settings are temporarily unavailable', traceId: request.id, retryable: true });
    return notifications.getPreferences(request.auth.userId);
  });

  app.put<{ Body: { connectionAlerts: boolean; securityAlerts: boolean; actionFailures: boolean } }>(
    '/v1/me/notifications/preferences',
    {
      preHandler: termsAuth,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['connectionAlerts', 'securityAlerts', 'actionFailures'],
          properties: {
            connectionAlerts: { type: 'boolean' },
            securityAlerts: { type: 'boolean' },
            actionFailures: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!notifications || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'notification_store_unavailable', message: 'Notification settings are temporarily unavailable', traceId: request.id, retryable: true });
      return notifications.updatePreferences(request.auth.userId, request.body);
    },
  );

  app.get('/v1/me/notifications/devices', { preHandler: auth }, async (request, reply) => {
    if (!notifications || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'notification_store_unavailable', message: 'Notification devices are temporarily unavailable', traceId: request.id, retryable: true });
    return { schemaVersion: 'v1', devices: await notifications.listDevices(request.auth.userId) };
  });

  app.put<{ Body: { platform: 'ios' | 'android'; token: string } }>(
    '/v1/me/notifications/devices',
    {
      preHandler: termsAuth,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['platform', 'token'],
          properties: {
            platform: { type: 'string', enum: ['ios', 'android'] },
            token: { type: 'string', minLength: 16, maxLength: 4096, pattern: '^[A-Za-z0-9:_.\\-]+$' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!notifications || !tokenProtector || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'notification_store_unavailable', message: 'Notification registration is temporarily unavailable', traceId: request.id, retryable: true });
      const fingerprint = tokenProtector.fingerprint(request.body.token);
      const ciphertext = tokenProtector.encrypt(request.body.token);
      const device = await notifications.registerDevice(request.auth.userId, request.body.platform, ciphertext, fingerprint);
      return reply.code(200).send(device);
    },
  );

  app.delete<{ Params: { deviceId: string } }>(
    '/v1/me/notifications/devices/:deviceId',
    {
      preHandler: termsAuth,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['deviceId'],
          properties: { deviceId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      if (!notifications || !request.auth) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'notification_store_unavailable', message: 'Notification devices are temporarily unavailable', traceId: request.id, retryable: true });
      return (await notifications.revokeDevice(request.auth.userId, request.params.deviceId))
        ? reply.code(204).send()
        : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Notification device not found', traceId: request.id });
    },
  );
}
