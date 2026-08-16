import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { ChannelStore } from '../domain/channel-store.js';
import type { AccountStore } from '../domain/account-store.js';
import { channelConfigValueSchema, validateChannelConfigSemantics } from '../domain/channel-config-schema.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const bindingParams = { type: 'object', additionalProperties: false, required: ['channelId', 'bindingId'], properties: { channelId: uuid, bindingId: uuid } } as const;
const bindingOverrideValuesSchema = {
  type: ['object', 'null'],
  maxProperties: 16,
  additionalProperties: false,
  properties: {
    style: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9._:-]+$' },
    displayStyle: { type: 'string', enum: ['small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration'] },
    anchor: { type: 'string', enum: ['top_left', 'top_center', 'top_right', 'center_left', 'center', 'center_right', 'bottom_left', 'bottom_center', 'bottom_right'] },
    scale: { type: 'number', minimum: 0.5, maximum: 2 },
    reducedMotion: { type: 'boolean' },
    ttsEnabled: { type: 'boolean' },
    rateLimitPerMinute: { type: 'integer', minimum: 1, maximum: 1000 },
    rateLimitPerMin: { type: 'integer', minimum: 1, maximum: 1000 },
    bracket: {
      type: 'object',
      maxProperties: 5,
      additionalProperties: false,
      properties: {
        charLimit: { type: 'integer', minimum: 10, maximum: 500 },
        displayMinMs: { type: 'integer', minimum: 4000, maximum: 60000 },
        displayStyle: { type: 'string', enum: ['small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration'] },
        ttsEligible: { type: 'boolean' },
        ttsOverflowPolicy: { type: 'string', enum: ['extend', 'truncate_speech', 'truncate_visual', 'visual_only', 'disable'] },
      },
    },
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'channel_store_unavailable', message: 'Channel data is temporarily unavailable', traceId, retryable: true });
}

export async function registerChannelRoutes(app: FastifyInstance, sessions?: SessionStore, store?: ChannelStore, account?: AccountStore): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.post<{ Body: { handle: string; displayName: string } }>('/v1/channels', {
    preHandler: termsAuth,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['handle', 'displayName'],
        properties: {
          handle: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
          displayName: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      return reply.code(201).send(await store.createChannel(request.auth.userId, { ...request.body, channelId: randomUUID() }));
    } catch (error) {
      logSafeError(request, 'channel_create_failed', error);
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'channel_create_conflict', message: 'Channel could not be created', traceId: request.id });
    }
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const channel = await store.getChannel(request.auth.userId, request.params.channelId);
    return channel ? reply.code(200).send(channel) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
  });

  app.patch<{ Params: { channelId: string }; Body: { displayName?: string; acceptingTips?: boolean } }>('/v1/channels/:channelId', { preHandler: termsAuth, schema: { params: channelParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { displayName: { type: 'string', minLength: 1, maxLength: 120 }, acceptingTips: { type: 'boolean' } } } } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const channel = await store.updateChannel(request.auth.userId, request.params.channelId, request.body);
    return channel ? reply.code(200).send(channel) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/config', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const config = await store.getConfig(request.auth.userId, request.params.channelId);
    return config ? reply.code(200).send(config) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel configuration not found', traceId: request.id });
  });

  app.patch<{ Params: { channelId: string }; Headers: { 'if-match-version': string }; Body: { values: Record<string, unknown> } }>('/v1/channels/:channelId/config', { preHandler: termsAuth, schema: { params: channelParams, headers: { type: 'object', required: ['if-match-version'], properties: { 'if-match-version': { type: 'string', pattern: '^[1-9][0-9]*$' } } }, body: { type: 'object', additionalProperties: false, required: ['values'], properties: { values: channelConfigValueSchema } } } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const issues = validateChannelConfigSemantics(request.body.values);
    if (issues.length > 0) {
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'config_invalid', message: 'Configuration cannot be saved', issues, traceId: request.id, retryable: false });
    }
    const expectedVersion = Number(request.headers['if-match-version']);
    try {
      const config = await store.updateConfig(request.auth.userId, request.params.channelId, request.body.values, expectedVersion);
      return config ? reply.code(200).send(config) : reply.code(409).send({ schemaVersion: 'v1', errorCode: 'config_version_conflict', message: 'Configuration changed; reload before saving', traceId: request.id, retryable: false });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Configuration exceeds entitlement:')) {
        return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'config_entitlement_limit', message: 'This configuration is not available on the channel plan', traceId: request.id, retryable: false });
      }
      logSafeError(request, 'config_update_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'channel_store_unavailable', message: 'Configuration could not be saved', traceId: request.id, retryable: true });
    }
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/queues', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    return { schemaVersion: 'v1', queues: await store.listQueues(request.auth.userId, request.params.channelId) };
  });

  app.post<{ Params: { channelId: string }; Body: { name: string } }>('/v1/channels/:channelId/queues', { preHandler: termsAuth, schema: { params: channelParams, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 } } } } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      return reply.code(201).send(await store.createQueue(request.auth.userId, request.params.channelId, { queueId: randomUUID(), name: request.body.name }));
    } catch (error) {
      logSafeError(request, 'queue_create_failed', error);
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'queue_create_conflict', message: 'Queue could not be created', traceId: request.id });
    }
  });

  app.patch<{ Params: { channelId: string; queueId: string }; Body: { name?: string; paused?: boolean; active?: boolean } }>('/v1/channels/:channelId/queues/:queueId', { preHandler: termsAuth, schema: { params: { type: 'object', additionalProperties: false, required: ['channelId', 'queueId'], properties: { channelId: uuid, queueId: uuid } }, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, paused: { type: 'boolean' }, active: { type: 'boolean' } } } } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const queue = await store.updateQueue(request.auth.userId, request.params.channelId, request.params.queueId, request.body);
    return queue ? reply.code(200).send(queue) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Queue not found', traceId: request.id });
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/bindings', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    return { schemaVersion: 'v1', bindings: await store.listBindings(request.auth.userId, request.params.channelId) };
  });

  app.patch<{
    Params: { channelId: string; bindingId: string };
    Body: { allowDuplicates?: boolean; priority?: number; overrideValues?: Record<string, unknown> | null; active?: boolean };
  }>('/v1/channels/:channelId/bindings/:bindingId', {
    preHandler: termsAuth,
    schema: {
      params: bindingParams,
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          allowDuplicates: { type: 'boolean' },
          priority: { type: 'integer', minimum: 0, maximum: 100000 },
          overrideValues: bindingOverrideValuesSchema,
          active: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const binding = await store.updateBinding(request.auth.userId, request.params.channelId, request.params.bindingId, request.body);
      return binding ? reply.code(200).send(binding) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Binding not found', traceId: request.id });
    } catch (error) {
      if (error instanceof Error && error.message === 'Default payment binding cannot be closed') {
        return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'default_binding_cannot_close', message: 'The channel default payment route must remain active', traceId: request.id, retryable: false });
      }
      logSafeError(request, 'binding_update_failed', error);
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'binding_update_conflict', message: 'Binding could not be updated', traceId: request.id, retryable: false });
    }
  });

  app.post<{
    Params: { channelId: string };
    Body: {
      queueId: string;
      sourceType: 'payment' | 'manual' | 'companion';
      sourceId: string;
      allowDuplicates: boolean;
      priority: number;
      overrideValues?: Record<string, unknown> | null;
    };
  }>(
    '/v1/channels/:channelId/bindings',
    {
      preHandler: termsAuth,
      schema: {
        params: channelParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['queueId', 'sourceType', 'sourceId', 'allowDuplicates', 'priority'],
          properties: {
            queueId: uuid,
            sourceType: { type: 'string', enum: ['payment', 'manual', 'companion'] },
            sourceId: { type: 'string', minLength: 1, maxLength: 160 },
            allowDuplicates: { type: 'boolean' },
            priority: { type: 'integer', minimum: 0, maximum: 100000 },
            overrideValues: bindingOverrideValuesSchema,
          },
        },
      },
    },
    async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      return reply.code(201).send(await store.createBinding(request.auth.userId, request.params.channelId, { ...request.body, overrideValues: request.body.overrideValues ?? null, bindingId: randomUUID() }));
    } catch (error) {
      logSafeError(request, 'binding_create_failed', error);
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'binding_create_conflict', message: 'Binding could not be created', traceId: request.id });
    }
  });
}
