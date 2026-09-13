import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { ReputationStore } from '../domain/reputation-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const supporterParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'viewerIdentityId'],
  properties: { channelId: uuid, viewerIdentityId: uuid },
} as const;

// Response serialization schema doubles as a hard runtime guarantee, not
// just documentation: fastify's serializer drops any property not listed
// here, so even a future store bug that attaches evidence to the verdict
// object (a signal, a source, another channel's id) can never reach the
// wire — the exact key set below is enforced on every response, not just
// asserted in a test.
const verdictResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'viewerIdentityId', 'verdict', 'recommendedAction'],
  properties: {
    schemaVersion: { type: 'string' },
    viewerIdentityId: uuid,
    verdict: { type: 'string', enum: ['clear', 'flagged'] },
    recommendedAction: { type: 'string', enum: ['none', 'review_before_payout'] },
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'reputation_store_unavailable', message: 'Supporter reputation is temporarily unavailable', traceId, retryable: true });
}

// L02b: supporter reputation (packages/db/migrations/0120). This route is
// tested directly against a bare Fastify instance, the same way
// routes/goals.ts's own test lane does it — this lane owns routes/
// reputation.ts but deliberately does not edit app.ts (see the task's
// ownership boundary); app.ts wiring is applied at review, see the
// delivery report's "Wiring needed" section.
//
// This route is READ-ONLY and verdict-only, on purpose: the response shape
// below is exactly {schemaVersion, viewerIdentityId, verdict,
// recommendedAction} — never a signal, a source, or a channel_id belonging
// to another creator's channel. See domain/reputation-store.ts and
// migration 0120's header for the cross-creator boundary this is built on.
export async function registerReputationRoutes(app: FastifyInstance, sessions?: SessionStore, store?: ReputationStore): Promise<void> {
  const auth = requireAuth(sessions);

  app.get<{ Params: { channelId: string; viewerIdentityId: string } }>('/v1/channels/:channelId/supporters/:viewerIdentityId/reputation', {
    preHandler: auth,
    schema: { params: supporterParams, response: { 200: verdictResponseSchema } },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.getVerdict(request.auth.userId, request.params.channelId, request.params.viewerIdentityId);
      switch (result.outcome) {
        case 'ok':
          return reply.code(200).send(result.verdict);
        case 'forbidden':
        case 'not_found':
          return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Supporter reputation not found', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'reputation_verdict_read_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
