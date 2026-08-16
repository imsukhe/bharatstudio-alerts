import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { ReferralStore } from '../domain/referrals.js';

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'referral_store_unavailable', message: 'Referral data is temporarily unavailable', traceId, retryable: true });
}

export async function registerReferralRoutes(app: FastifyInstance, sessions?: SessionStore, store?: ReferralStore): Promise<void> {
  const auth = requireAuth(sessions);

  // Owner/admin only, enforced at the database layer (an explicit
  // has_channel_role check inside list_channel_referral_overview /
  // list_channel_referrals) — a non-owner/admin caller gets an empty
  // overview/history, not a 403, matching /billing and /entitlements.
  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/referrals/overview', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    return reply.code(200).send(await store.getOverview(request.auth.userId, request.params.channelId));
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/referrals', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    return reply.code(200).send(await store.listHistory(request.auth.userId, request.params.channelId));
  });
}
