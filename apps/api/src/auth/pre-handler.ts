import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionPrincipal, SessionStore } from './session-store.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: SessionPrincipal | null;
  }
}

export function installAuthState(request: FastifyRequest): void {
  request.auth = null;
}

export function requireAuth(store?: SessionStore) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!store) {
      await reply.code(503).send({
        schemaVersion: 'v1',
        errorCode: 'auth_unavailable',
        message: 'Authentication is temporarily unavailable',
        traceId: request.id,
        retryable: true,
      });
      return;
    }
    const header = request.headers.authorization;
    const token = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
    if (!token || token.length < 32) {
      await reply.code(401).send({
        schemaVersion: 'v1',
        errorCode: 'unauthorized',
        message: 'Authentication required',
        traceId: request.id,
      });
      return;
    }
    const principal = await store.lookup(token);
    if (!principal) {
      await reply.code(401).send({
        schemaVersion: 'v1',
        errorCode: 'unauthorized',
        message: 'Authentication required',
        traceId: request.id,
      });
      return;
    }
    request.auth = principal;
  };
}
