import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { UrlDomainRuleStore, UrlDomainRuleValue } from '../domain/url-domain-rule-store.js';
import { logSafeError } from '../observability/safe-log.js';

// SAF-10 (migration 0154): URL allow/deny domain management only -- add
// or remove a domain rule in THIS channel's own list. Mirrors routes/
// safety-corpus.ts exactly. There is no route here that runs text
// through neutralizeUrls (apps/api/src/domain/url-neutralization.ts) --
// nothing is wired into a live surface yet, same posture as SAF phase 1.

const ruleValues: readonly UrlDomainRuleValue[] = ['allow', 'deny'];

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;
const ruleParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'ruleId'],
  properties: { channelId: { type: 'string', format: 'uuid' }, ruleId: { type: 'string', format: 'uuid' } },
} as const;

const createBody = {
  type: 'object', additionalProperties: false,
  required: ['domain', 'rule'],
  properties: {
    // RFC 1035 hostname shape/length reused verbatim from
    // packages/db/migrations/0154's own CHECK constraint.
    domain: { type: 'string', minLength: 1, maxLength: 253, pattern: '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' },
    rule: { type: 'string', enum: [...ruleValues] },
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'safety_domain_rules_store_unavailable', message: 'The safety domain rule list is temporarily unavailable', traceId, retryable: true });
}

export async function registerUrlDomainRuleRoutes(app: FastifyInstance, sessions?: SessionStore, store?: UrlDomainRuleStore): Promise<void> {
  const auth = requireAuth(sessions);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/safety/domain-rules', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const items = await store.list(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    } catch (error) {
      logSafeError(request, 'safety_domain_rules_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{
    Params: { channelId: string };
    Body: { domain: string; rule: UrlDomainRuleValue };
  }>('/v1/channels/:channelId/safety/domain-rules', {
    preHandler: auth,
    schema: { params: channelParams, body: createBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.create(request.auth.userId, request.params.channelId, request.body);
      switch (result.outcome) {
        case 'created': return reply.code(201).send(result.rule);
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'duplicate': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'domain_rule_already_exists', message: 'This domain already has a rule for this channel', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_domain_rule', message: 'The safety domain rule could not be created', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'safety_domain_rules_create_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'safety_domain_rules_store_unavailable', message: 'The safety domain rule could not be created', traceId: request.id, retryable: true });
    }
  });

  app.delete<{ Params: { channelId: string; ruleId: string } }>('/v1/channels/:channelId/safety/domain-rules/:ruleId', {
    preHandler: auth,
    schema: { params: ruleParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.remove(request.auth.userId, request.params.channelId, request.params.ruleId);
      switch (result.outcome) {
        case 'ok': return reply.code(204).send();
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Safety domain rule not found', traceId: request.id });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Safety domain rule not found', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'safety_domain_rules_delete_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'safety_domain_rules_store_unavailable', message: 'The safety domain rule could not be deleted', traceId: request.id, retryable: true });
    }
  });
}
