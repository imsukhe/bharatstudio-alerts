import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import type { ContributionSourceStore, ContributionSourceType } from '../domain/contribution-source-types.js';
import type { GoalStore, GoalWindow, OverlayGoalStore } from '../domain/goal-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const goalWindows: readonly GoalWindow[] = ['stream', 'daily', 'monthly', 'open'];
const contributionSourceTypes: readonly ContributionSourceType[] = ['payment', 'youtube_superchat'];

const sourceInclusionBody = {
  type: 'object', additionalProperties: false, required: ['sourceType', 'included'],
  properties: {
    sourceType: { type: 'string', enum: [...contributionSourceTypes] },
    included: { type: 'boolean' },
  },
} as const;

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const goalParams = { type: 'object', additionalProperties: false, required: ['channelId', 'goalId'], properties: { channelId: uuid, goalId: uuid } } as const;
const overlayParams = { type: 'object', additionalProperties: false, required: ['overlayId'], properties: { overlayId: uuid } } as const;

const createBody = {
  type: 'object', additionalProperties: false, required: ['title', 'targetAmountPaise', 'window'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    targetAmountPaise: { type: 'integer', minimum: 1000 },
    window: { type: 'string', enum: [...goalWindows] },
    isPublic: { type: 'boolean' },
  },
} as const;

const updateBody = {
  type: 'object', additionalProperties: false, minProperties: 1,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    targetAmountPaise: { type: 'integer', minimum: 1000 },
  },
} as const;

// GOA-03: reason bound reused verbatim from 0059's manual-review reason
// (packages/db/migrations/0059_v1_l04_reconciliation_manual_review_quarantine.sql,
// `check (char_length(reason) between 1 and 500)`).
const reopenBody = {
  type: 'object', additionalProperties: false, required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'goal_store_unavailable', message: 'Support goals are temporarily unavailable', traceId, retryable: true });
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1];
}

export async function registerGoalRoutes(app: FastifyInstance, sessions?: SessionStore, store?: GoalStore, account?: AccountStore, overlayGoals?: OverlayGoalStore, contributionSources?: ContributionSourceStore): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.post<{ Params: { channelId: string }; Body: { title: string; targetAmountPaise: number; window: GoalWindow; isPublic?: boolean } }>('/v1/channels/:channelId/goals', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: createBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.create(request.auth.userId, request.params.channelId, request.body);
      switch (result.outcome) {
        case 'created': return reply.code(201).send(result.goal);
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'tier_limit_reached': return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'goal_limit_reached', message: 'This tier\'s support goal limit has been reached', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_goal', message: 'The support goal could not be created', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'goal_create_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'goal_store_unavailable', message: 'The support goal could not be created', traceId: request.id, retryable: true });
    }
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/goals', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const items = await store.list(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    } catch (error) {
      logSafeError(request, 'goal_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.get<{ Params: { channelId: string; goalId: string } }>('/v1/channels/:channelId/goals/:goalId', {
    preHandler: auth,
    schema: { params: goalParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const goal = await store.get(request.auth.userId, request.params.channelId, request.params.goalId);
      return goal ? reply.code(200).send(goal) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Support goal not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'goal_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.patch<{ Params: { channelId: string; goalId: string }; Body: { title?: string; targetAmountPaise?: number } }>('/v1/channels/:channelId/goals/:goalId', {
    preHandler: termsAuth,
    schema: { params: goalParams, body: updateBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.update(request.auth.userId, request.params.channelId, request.params.goalId, request.body);
      return sendMutateResult(reply, request.id, result);
    } catch (error) {
      logSafeError(request, 'goal_update_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'goal_store_unavailable', message: 'The support goal could not be updated', traceId: request.id, retryable: true });
    }
  });

  app.post<{ Params: { channelId: string; goalId: string } }>('/v1/channels/:channelId/goals/:goalId/end', {
    preHandler: termsAuth,
    schema: { params: goalParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.end(request.auth.userId, request.params.channelId, request.params.goalId);
      return sendMutateResult(reply, request.id, result);
    } catch (error) {
      logSafeError(request, 'goal_end_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'goal_store_unavailable', message: 'The support goal could not be ended', traceId: request.id, retryable: true });
    }
  });

  // GOA-01/GOA-02: completion read. app_private.get_channel_goal_completion
  // (0150) opportunistically latches (writes goal_completed once,
  // idempotently) on every read, so this is always current. A refund never
  // un-completes a goal — see domain/goal-store.ts's GoalCompletion doc
  // comment for what each field freezes vs. stays live.
  app.get<{ Params: { channelId: string; goalId: string } }>('/v1/channels/:channelId/goals/:goalId/completion', {
    preHandler: auth,
    schema: { params: goalParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.getCompletion(request.auth.userId, request.params.channelId, request.params.goalId);
      return result.outcome === 'ok'
        ? reply.code(200).send(result.completion)
        : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Support goal not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'goal_completion_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // GOA-03: manual reopen — explicit, reason-required, audited. Owner/admin
  // only, same role bound as /end and PATCH above.
  app.post<{ Params: { channelId: string; goalId: string }; Body: { reason: string } }>('/v1/channels/:channelId/goals/:goalId/reopen', {
    preHandler: termsAuth,
    schema: { params: goalParams, body: reopenBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.reopenCompletion(request.auth.userId, request.params.channelId, request.params.goalId, request.body);
      switch (result.outcome) {
        case 'ok': return reply.code(200).send(result.completion);
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Support goal not found', traceId: request.id });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Support goal not found', traceId: request.id });
        case 'not_completed': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'goal_not_completed', message: 'This support goal is not currently completed, so it cannot be reopened', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_reopen_reason', message: 'A reopen reason (1-500 characters) is required', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'goal_completion_reopen_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'goal_store_unavailable', message: 'The support goal could not be reopened', traceId: request.id, retryable: true });
    }
  });

  // L16c (0117): which sources (BharatStudio tips vs Super Chats etc.)
  // count toward this goal's progress. Include/exclude ONLY — see
  // domain/contribution-source-types.ts for why there is no percentage
  // field. Missing rows read back as included=true (aggregate everything
  // by default).
  app.get<{ Params: { channelId: string; goalId: string } }>('/v1/channels/:channelId/goals/:goalId/sources', {
    preHandler: auth,
    schema: { params: goalParams },
  }, async (request, reply) => {
    if (!contributionSources || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await contributionSources.list(request.auth.userId, request.params.channelId, 'goal', request.params.goalId);
      return result.outcome === 'ok'
        ? reply.code(200).send({ schemaVersion: 'v1', sources: result.sources })
        : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Support goal not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'goal_source_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.put<{ Params: { channelId: string; goalId: string }; Body: { sourceType: ContributionSourceType; included: boolean } }>('/v1/channels/:channelId/goals/:goalId/sources', {
    preHandler: termsAuth,
    schema: { params: goalParams, body: sourceInclusionBody },
  }, async (request, reply) => {
    if (!contributionSources || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await contributionSources.set(
        request.auth.userId, request.params.channelId, 'goal', request.params.goalId,
        request.body.sourceType, request.body.included,
      );
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', sources: result.sources });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Support goal not found', traceId: request.id });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Support goal not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_source_inclusion', message: 'That contribution source could not be updated', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'goal_source_update_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'goal_store_unavailable', message: 'The contribution source could not be updated', traceId: request.id, retryable: true });
    }
  });

  // Overlay browser-source read. Deliberately outside the session-cookie
  // auth chain — same shape as registerOverlayLottieRoutes
  // (routes/overlay-lottie.ts): no preHandler, a scoped bearer token read
  // from the Authorization header, all channel/session/privacy scoping
  // enforced inside app_private.list_overlay_goal (0102). This reuses the
  // existing overlay_sessions table and token-fingerprint model — it does
  // not invent a new auth path.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-goals/:overlayId', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Goal widget is not available', traceId: request.id });
    if (!overlayGoals) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'goal_store_unavailable', message: 'Goal widget is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const goal = await overlayGoals.getForOverlay(token, request.params.overlayId);
      return reply.code(200).send({
        schemaVersion: 'v1',
        goal: goal === null ? null : {
          schemaVersion: 'v1', goalId: goal.goalId, title: goal.title,
          targetAmountPaise: goal.targetAmountPaise, window: goal.window,
          progressPaise: goal.progressPaise, reached: goal.reached,
        },
      });
    } catch (error) {
      logSafeError(request, 'overlay_goal_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'goal_store_unavailable', message: 'Goal widget is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
}

function sendMutateResult(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  traceId: string,
  result: { outcome: 'ok'; goal: unknown } | { outcome: 'forbidden' | 'not_found' | 'ended' | 'invalid' },
) {
  switch (result.outcome) {
    case 'ok': return reply.code(200).send(result.goal);
    case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Support goal not found', traceId });
    case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Support goal not found', traceId });
    case 'ended': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'goal_ended', message: 'An ended support goal cannot be edited', traceId });
    case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_goal', message: 'The support goal could not be updated', traceId });
  }
}
