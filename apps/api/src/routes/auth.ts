import type { FastifyInstance } from 'fastify';
import type { GoogleIdentityVerifier } from '../auth/google.js';
import type { SessionStore } from '../auth/session-store.js';

export async function registerAuthRoutes(
  app: FastifyInstance,
  dependencies?: { google?: GoogleIdentityVerifier; sessions?: SessionStore },
): Promise<void> {
  app.post<{ Body: { idToken: string; deviceLabel: string } }>(
    '/v1/auth/google/exchange',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['idToken', 'deviceLabel'],
          properties: {
            idToken: { type: 'string', minLength: 20, maxLength: 8192 },
            deviceLabel: { type: 'string', minLength: 1, maxLength: 80 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!dependencies?.google || !dependencies.sessions) {
        return reply.code(503).send({
          schemaVersion: 'v1',
          errorCode: 'auth_unavailable',
          message: 'Authentication is temporarily unavailable',
          traceId: request.id,
          retryable: true,
        });
      }
      try {
        const identity = await dependencies.google.verify(request.body.idToken);
        const created = await dependencies.sessions.create(identity, request.body.deviceLabel);
        const user = await dependencies.sessions.getCurrentUser(created.principal.userId);
        return reply.code(201).send({
          schemaVersion: 'v1',
          accessToken: created.accessToken,
          expiresAt: created.principal.expiresAt,
          user,
        });
      } catch {
        return reply.code(401).send({
          schemaVersion: 'v1',
          errorCode: 'invalid_google_identity',
          message: 'Google identity could not be verified',
          traceId: request.id,
        });
      }
    },
  );
}
