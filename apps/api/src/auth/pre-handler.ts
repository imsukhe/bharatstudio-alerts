import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionPrincipal, SessionStore } from './session-store.js';
import type { AccountStore } from '../domain/account-store.js';

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

/**
 * Product mutations must be gated by the currently published legal documents.
 * Keep this as a separate pre-handler so account routes can remain available
 * for acceptance and privacy access while all other writes fail closed when
 * the account adapter is unavailable or the user has not accepted the active
 * documents.
 */
export function requireAcceptedTerms(account?: AccountStore) {
  return async function checkAcceptedTerms(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.auth) return;
    if (!account) {
      await reply.code(503).send({
        schemaVersion: 'v1',
        errorCode: 'terms_unavailable',
        message: 'Terms acceptance status is temporarily unavailable',
        traceId: request.id,
        retryable: true,
      });
      return;
    }
    try {
      if (await account.hasAcceptedActiveDocuments(request.auth.userId)) return;
    } catch {
      await reply.code(503).send({
        schemaVersion: 'v1',
        errorCode: 'terms_unavailable',
        message: 'Terms acceptance status is temporarily unavailable',
        traceId: request.id,
        retryable: true,
      });
      return;
    }
    await reply.code(428).send({
      schemaVersion: 'v1',
      errorCode: 'terms_acceptance_required',
      message: 'Accept the current Terms and Privacy Notice before continuing',
      traceId: request.id,
      retryable: false,
    });
  };
}

export function requireAuthAndTerms(sessions?: SessionStore, account?: AccountStore) {
  return account ? [requireAuth(sessions), requireAcceptedTerms(account)] : requireAuth(sessions);
}
