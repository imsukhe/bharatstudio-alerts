// L23: AI assist, bounded. See packages/db/migrations/0121's header and
// apps/api/src/domain/assist-provider.ts's data-contract comment for the
// design this route enforces. NOT wired into app.ts by this lane — see the
// ownership boundary note in test/l23-assist-routes.test.ts and this task's
// return report's "Wiring needed" section.
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import { ASSIST_SURFACES, type AssistDecision, type AssistStore, type AssistSurface } from '../domain/assist-types.js';
import { createLocalAssistProvider, type AssistSuggestionProvider } from '../domain/assist-provider.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const surfaces: readonly AssistSurface[] = ASSIST_SURFACES;
const decisions: readonly AssistDecision[] = ['accepted', 'rejected'];
const tiers = ['free', 'pro', 'creator', 'studio'] as const;

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const suggestionParams = { type: 'object', additionalProperties: false, required: ['channelId', 'suggestionId'], properties: { channelId: uuid, suggestionId: uuid } } as const;

// The request body carries ONLY surface + tier + a flat, primitive-valued
// `signal` object — the same shape AssistGenerationRequest requires. There
// is no field here a caller could use to smuggle a donor name, a message,
// or payment data through to the provider seam; additionalProperties:
// false on every level enforces that at the schema layer, not just by
// convention.
const generateBody = {
  type: 'object', additionalProperties: false, required: ['surface', 'tier'],
  properties: {
    surface: { type: 'string', enum: [...surfaces] },
    tier: { type: 'string', enum: [...tiers] },
    signal: {
      type: 'object',
      additionalProperties: { type: ['string', 'number', 'boolean'] },
    },
  },
} as const;

const decideBody = {
  type: 'object', additionalProperties: false, required: ['decision'],
  properties: {
    decision: { type: 'string', enum: [...decisions] },
    appliedPayload: { type: 'object' },
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'assist_store_unavailable', message: 'AI assist is temporarily unavailable', traceId, retryable: true });
}

export async function registerAssistRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: AssistStore,
  account?: AccountStore,
  provider: AssistSuggestionProvider = createLocalAssistProvider(),
): Promise<void> {
  const termsAuth = requireAuthAndTerms(sessions, account);
  const auth = requireAuth(sessions);

  // Generate a suggestion. This calls the provider seam (local, zero-
  // network default unless a real provider is injected — see
  // assist-provider.ts) and then persists the result via
  // AssistStore#create, which is the only path that can reach
  // app_private.create_assist_suggestion. Nothing here writes to any
  // surface directly; the response is a suggestion object, never an
  // applied change.
  app.post<{ Params: { channelId: string }; Body: { surface: AssistSurface; tier: (typeof tiers)[number]; signal?: Record<string, string | number | boolean> } }>(
    '/v1/channels/:channelId/assist/suggestions',
    { preHandler: termsAuth, schema: { params: channelParams, body: generateBody } },
    async (request, reply) => {
      if (!store || !request.auth) return unavailable(reply, request.id);
      try {
        const generated = await provider.generate({ surface: request.body.surface, tier: request.body.tier, signal: request.body.signal ?? {} });
        const result = await store.create(request.auth.userId, request.params.channelId, {
          surface: request.body.surface,
          suggestedPayload: generated.suggestedPayload,
          basis: generated.basis,
        });
        switch (result.outcome) {
          case 'created': return reply.code(201).send(result.suggestion);
          case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
          case 'tier_not_entitled': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'assist_not_entitled', message: 'AI assist is not available on this tier', traceId: request.id });
          case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_assist_suggestion', message: 'The assist suggestion could not be created', traceId: request.id });
        }
      } catch (error) {
        logSafeError(request, 'assist_suggestion_create_failed', error);
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'assist_store_unavailable', message: 'The assist suggestion could not be created', traceId: request.id, retryable: true });
      }
    },
  );

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/assist/suggestions', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const items = await store.list(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    } catch (error) {
      logSafeError(request, 'assist_suggestion_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // The human-confirmation step. This is the ONLY endpoint that can move a
  // suggestion out of 'pending', and it never touches anything but
  // assist_suggestions/assist_confirmations (see the migration). Applying
  // an accepted suggestion to a live surface still requires the creator to
  // separately use the existing config/challenge/alert-style/moderation
  // endpoints — this route does not call them.
  app.post<{ Params: { channelId: string; suggestionId: string }; Body: { decision: AssistDecision; appliedPayload?: Record<string, unknown> } }>(
    '/v1/channels/:channelId/assist/suggestions/:suggestionId/decide',
    { preHandler: termsAuth, schema: { params: suggestionParams, body: decideBody } },
    async (request, reply) => {
      if (!store || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await store.decide(request.auth.userId, request.params.suggestionId, {
          decision: request.body.decision,
          appliedPayload: request.body.appliedPayload,
        });
        switch (result.outcome) {
          case 'decided': return reply.code(200).send(result.confirmation);
          case 'forbidden': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'assist_decision_forbidden', message: 'You are not authorized to decide this suggestion', traceId: request.id });
          case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Assist suggestion not found', traceId: request.id });
          case 'already_decided': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'assist_already_decided', message: 'This suggestion has already been decided', traceId: request.id });
          case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_assist_decision', message: 'The decision could not be recorded', traceId: request.id });
        }
      } catch (error) {
        logSafeError(request, 'assist_suggestion_decide_failed', error);
        return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'assist_store_unavailable', message: 'The decision could not be recorded', traceId: request.id, retryable: true });
      }
    },
  );

  app.get<{ Params: { channelId: string; suggestionId: string } }>('/v1/channels/:channelId/assist/suggestions/:suggestionId/audit', {
    preHandler: auth,
    schema: { params: suggestionParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const audit = await store.getAudit(request.auth.userId, request.params.suggestionId);
      return audit ? reply.code(200).send(audit) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Assist suggestion not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'assist_suggestion_audit_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
