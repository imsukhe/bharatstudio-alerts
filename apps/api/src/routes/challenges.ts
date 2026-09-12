import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import { CHALLENGE_FAILURE_COPY } from '../domain/challenge-store.js';
import type { ChallengeKind, ChallengeStore, OverlayChallengeStore } from '../domain/challenge-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const challengeKinds: readonly ChallengeKind[] = ['stake', 'bounty'];
const transitionTargets = ['active', 'succeeded', 'failed', 'cancelled'] as const;

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const challengeParams = { type: 'object', additionalProperties: false, required: ['channelId', 'challengeId'], properties: { channelId: uuid, challengeId: uuid } } as const;
const overlayParams = { type: 'object', additionalProperties: false, required: ['overlayId'], properties: { overlayId: uuid } } as const;

const createBody = {
  type: 'object', additionalProperties: false, required: ['title', 'kind', 'targetAmountPaise'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 500 },
    kind: { type: 'string', enum: [...challengeKinds] },
    targetAmountPaise: { type: 'integer', minimum: 1000 },
    isPublic: { type: 'boolean' },
  },
} as const;

const transitionBody = {
  type: 'object', additionalProperties: false, required: ['toState'],
  properties: { toState: { type: 'string', enum: [...transitionTargets] } },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'challenge_store_unavailable', message: 'Challenges are temporarily unavailable', traceId, retryable: true });
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1];
}

/**
 * L17: paid challenges. Role-gated like every other channel-management
 * route (registerGoalRoutes is the direct model): create/transition go
 * through requireAuthAndTerms and are further enforced, per-role, inside
 * the security-definer SQL functions (app_private.create_challenge /
 * transition_challenge, packages/db/migrations/0109) — owner/admin only.
 * A state transition is validated against a fixed edge list on the SQL
 * side, never free-form; this route layer only maps outcomes to HTTP
 * status codes, exactly like sendMutateResult in routes/goals.ts.
 *
 * Registered by buildApp with SQL-backed stores from the production entrypoint.
 */
export async function registerChallengeRoutes(app: FastifyInstance, sessions?: SessionStore, store?: ChallengeStore, account?: AccountStore, overlayChallenges?: OverlayChallengeStore): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.post<{ Params: { channelId: string }; Body: { title: string; description?: string; kind: ChallengeKind; targetAmountPaise: number; isPublic?: boolean } }>('/v1/channels/:channelId/challenges', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: createBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.create(request.auth.userId, request.params.channelId, request.body);
      switch (result.outcome) {
        case 'created': return reply.code(201).send(result.challenge);
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'tier_limit_reached': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'challenge_limit_reached', message: 'This tier\'s challenge limit has been reached', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_challenge', message: 'The challenge could not be created', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'challenge_create_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'challenge_store_unavailable', message: 'The challenge could not be created', traceId: request.id, retryable: true });
    }
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/challenges', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const items = await store.list(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', failureCopy: CHALLENGE_FAILURE_COPY, items });
    } catch (error) {
      logSafeError(request, 'challenge_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.get<{ Params: { channelId: string; challengeId: string } }>('/v1/channels/:channelId/challenges/:challengeId', {
    preHandler: auth,
    schema: { params: challengeParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const challenge = await store.get(request.auth.userId, request.params.channelId, request.params.challengeId);
      return challenge
        ? reply.code(200).send({ ...challenge, failureCopy: CHALLENGE_FAILURE_COPY })
        : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Challenge not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'challenge_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{ Params: { channelId: string; challengeId: string }; Body: { toState: 'active' | 'succeeded' | 'failed' | 'cancelled' } }>('/v1/channels/:channelId/challenges/:challengeId/transition', {
    preHandler: termsAuth,
    schema: { params: challengeParams, body: transitionBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.transition(request.auth.userId, request.params.channelId, request.params.challengeId, request.body.toState);
      return sendTransitionResult(reply, request.id, result);
    } catch (error) {
      logSafeError(request, 'challenge_transition_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'challenge_store_unavailable', message: 'The challenge could not be transitioned', traceId: request.id, retryable: true });
    }
  });

  // Overlay browser-source read. Deliberately outside the session-cookie
  // auth chain — same shape as registerGoalRoutes's /v1/overlay-goals
  // route: no preHandler, a scoped bearer token read from the
  // Authorization header, all channel/session/privacy scoping enforced
  // inside app_private.list_overlay_challenge (0109). This reuses the
  // existing overlay_sessions table and token-fingerprint model — it does
  // not invent a new auth path.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-challenges/:overlayId', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Challenge widget is not available', traceId: request.id });
    if (!overlayChallenges) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'challenge_store_unavailable', message: 'Challenge widget is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const challenge = await overlayChallenges.getForOverlay(token, request.params.overlayId);
      return reply.code(200).send({
        schemaVersion: 'v1',
        challenge: challenge === null ? null : {
          schemaVersion: 'v1', challengeId: challenge.challengeId, title: challenge.title,
          kind: challenge.kind, targetAmountPaise: challenge.targetAmountPaise,
          state: challenge.state, progressPaise: challenge.progressPaise,
          targetReached: challenge.targetReached,
        },
      });
    } catch (error) {
      logSafeError(request, 'overlay_challenge_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'challenge_store_unavailable', message: 'Challenge widget is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
}

function sendTransitionResult(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  traceId: string,
  result: { outcome: 'ok'; challenge: unknown } | { outcome: 'forbidden' | 'not_found' | 'invalid_transition' | 'invalid' },
) {
  switch (result.outcome) {
    case 'ok': return reply.code(200).send({ ...(result.challenge as object), failureCopy: CHALLENGE_FAILURE_COPY });
    case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Challenge not found', traceId });
    case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Challenge not found', traceId });
    case 'invalid_transition': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'invalid_transition', message: 'That state change is not valid for this challenge', traceId });
    case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_challenge', message: 'The challenge could not be transitioned', traceId });
  }
}
