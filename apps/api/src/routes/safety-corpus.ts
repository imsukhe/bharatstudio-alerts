import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { SafetyCorpusStore } from '../domain/safety-corpus-store.js';
import type { ModeratorReviewDecisionValue, SafetyDecisionValue } from '../domain/safety-pipeline.js';
import { logSafeError } from '../observability/safe-log.js';

// SAF phase 1 (migration 0151): corpus management only -- add or remove
// a term in THIS channel's own corpus. There is no route here that runs
// text through the pipeline (apps/api/src/domain/safety-pipeline.ts) --
// nothing is wired into a live surface yet, see that file's and the
// migration's own headers. There is also no route for global-corpus
// management (staff-only, data-layer primitive only in this phase,
// exactly CTL-04's own admin-UI deferral, migration 0149).

const decisionValues: readonly SafetyDecisionValue[] = ['allow', 'mask', 'hold', 'block'];
const moderatorDecisionValues: readonly ModeratorReviewDecisionValue[] = ['allow', 'hold'];

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;
const termParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'termId'],
  properties: { channelId: { type: 'string', format: 'uuid' }, termId: { type: 'string', format: 'uuid' } },
} as const;

const createBody = {
  type: 'object', additionalProperties: false,
  required: ['term', 'displayDecision', 'ttsDecision', 'moderatorReviewDecision'],
  properties: {
    // 200-character bound reused verbatim from packages/db/migrations/0151's
    // own check (char_length(btrim(term)) between 1 and 200).
    term: { type: 'string', minLength: 1, maxLength: 200 },
    wholeWord: { type: 'boolean' },
    displayDecision: { type: 'string', enum: [...decisionValues] },
    ttsDecision: { type: 'string', enum: [...decisionValues] },
    moderatorReviewDecision: { type: 'string', enum: [...moderatorDecisionValues] },
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'safety_corpus_store_unavailable', message: 'The safety corpus is temporarily unavailable', traceId, retryable: true });
}

export async function registerSafetyCorpusRoutes(app: FastifyInstance, sessions?: SessionStore, store?: SafetyCorpusStore): Promise<void> {
  const auth = requireAuth(sessions);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/safety/corpus-terms', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const items = await store.list(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    } catch (error) {
      logSafeError(request, 'safety_corpus_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{
    Params: { channelId: string };
    Body: { term: string; wholeWord?: boolean; displayDecision: SafetyDecisionValue; ttsDecision: SafetyDecisionValue; moderatorReviewDecision: ModeratorReviewDecisionValue };
  }>('/v1/channels/:channelId/safety/corpus-terms', {
    preHandler: auth,
    schema: { params: channelParams, body: createBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.create(request.auth.userId, request.params.channelId, request.body);
      switch (result.outcome) {
        case 'created': return reply.code(201).send(result.term);
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'duplicate': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'term_already_exists', message: 'This term already exists in the corpus', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_corpus_term', message: 'The safety corpus term could not be created', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'safety_corpus_create_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'safety_corpus_store_unavailable', message: 'The safety corpus term could not be created', traceId: request.id, retryable: true });
    }
  });

  app.delete<{ Params: { channelId: string; termId: string } }>('/v1/channels/:channelId/safety/corpus-terms/:termId', {
    preHandler: auth,
    schema: { params: termParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.remove(request.auth.userId, request.params.channelId, request.params.termId);
      switch (result.outcome) {
        case 'ok': return reply.code(204).send();
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Safety corpus term not found', traceId: request.id });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Safety corpus term not found', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'safety_corpus_delete_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'safety_corpus_store_unavailable', message: 'The safety corpus term could not be deleted', traceId: request.id, retryable: true });
    }
  });
}
