import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { PaymentLedgerStore } from '../domain/payment-ledger.js';

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;

export async function registerPaymentLedgerRoutes(app: FastifyInstance, sessions?: SessionStore, store?: PaymentLedgerStore): Promise<void> {
  const auth = requireAuth(sessions);

  // Owner/admin only, per 00_LAUNCH_SCOPE_AUTHORITY.md's role-scoped
  // financial-visibility rule — enforced at the database layer (RLS +
  // an explicit has_channel_role check inside list_channel_payments), not
  // here: a non-owner/admin caller gets an empty page, not a 403, matching
  // how GET /billing and /entitlements already behave in this codebase.
  app.get<{ Params: { channelId: string }; Querystring: { cursor?: string; pageSize?: number } }>('/v1/channels/:channelId/payments', {
    preHandler: auth,
    schema: {
      params: channelParams,
      querystring: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string', maxLength: 64 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 25 } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) {
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'payment_ledger_unavailable', message: 'The payment ledger is temporarily unavailable', traceId: request.id, retryable: true });
    }
    try {
      const page = await store.listPayments(request.auth.userId, request.params.channelId, request.query.cursor, request.query.pageSize ?? 25);
      return reply.code(200).send(page);
    } catch {
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'bad_cursor', message: 'Cursor is invalid', traceId: request.id });
    }
  });
}
