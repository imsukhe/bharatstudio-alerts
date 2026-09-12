import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { TemplateCatalogueStore } from '../domain/template-catalogue.js';

const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: { type: 'string', format: 'uuid' } } } as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'template_store_unavailable', message: 'The template library is temporarily unavailable', traceId, retryable: true });
}

// Read-only: this task has no creator-authored template, only the
// imported catalogue (migration 0106) filtered live by the channel's
// current entitlement tier. Plain requireAuth, not requireAuthAndTerms —
// mirrors branding.ts's read (GET) route, not its write (PUT) route,
// since listing changes nothing.
export async function registerTemplateRoutes(app: FastifyInstance, sessions?: SessionStore, store?: TemplateCatalogueStore): Promise<void> {
  const auth = requireAuth(sessions);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/templates', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const items = await store.listForChannel(request.auth.userId, request.params.channelId);
    return reply.code(200).send({ schemaVersion: 'v1', items });
  });
}
