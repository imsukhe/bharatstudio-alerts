import type { FastifyInstance } from 'fastify';
import { requirePlatformAdminMfa } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { CapabilityMatrixAdminStore } from '../domain/capability-matrix-admin.js';
import type { MarketingRevalidateWebhook } from '../domain/marketing-revalidate-webhook.js';
import { logSafeError } from '../observability/safe-log.js';
import type { AdminPasskeyStore, AdminWebAuthnConfig } from '../domain/admin-passkeys.js';

// CTL-10/CTL-11 (migration 0160). Platform-staff-only publish surface,
// same requirePlatformAdminMfa gate as routes/capability-registry-admin.ts.
// Own file, own store -- this is the publish/introspection half of the
// public matrix plane; routes/public-capability-matrix.ts is the public
// read half.
//
// CTL-11's own hard constraint ("the webhook must not become an
// authenticated hole -- no capability data flows in") is why this route
// calls OUT to the marketing webhook only AFTER the database publish has
// already succeeded, and why a webhook failure never fails the request
// or rolls back the publish: the snapshot is already durable and already
// servable from GET /v1/public/capability-matrix the moment the store
// call above returns. webhookDelivered in the response is diagnostic
// only, for the admin who triggered the publish to see at a glance
// whether marketing was reachable -- not a correctness signal for the
// publish itself.
function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({
    schemaVersion: 'v1',
    errorCode: 'capability_matrix_admin_unavailable',
    message: 'Capability matrix administration is temporarily unavailable',
    traceId,
    retryable: true,
  });
}

export async function registerCapabilityMatrixAdminRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: CapabilityMatrixAdminStore,
  webhook?: MarketingRevalidateWebhook,
  adminGate?: { isPlatformAdmin(userId: string): Promise<boolean> },
  adminPasskeys?: AdminPasskeyStore,
  adminWebAuthn?: AdminWebAuthnConfig,
): Promise<void> {
  const adminAuth = requirePlatformAdminMfa(sessions, adminGate, adminPasskeys, adminWebAuthn?.mfaMaxAgeSeconds);

  app.post<{ Body: { reason: string } }>('/v1/admin/capability-matrix/publish', {
    preHandler: adminAuth,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['reason'],
        properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);

    let snapshot;
    try {
      snapshot = await store.publish(request.auth.userId, request.body.reason);
    } catch (error) {
      logSafeError(request, 'capability_matrix_publish_failed', error);
      return unavailable(reply, request.id);
    }

    // CTL-11: trigger only, after the publish already committed. Never
    // awaited in a way that could fail the publish response -- caught
    // and folded into the diagnostic field below instead.
    let webhookResult: { attempted: boolean; delivered: boolean; statusCode?: number } = { attempted: false, delivered: false };
    if (webhook) {
      try {
        webhookResult = await webhook.notify(snapshot.version, snapshot.publishedAt);
      } catch (error) {
        logSafeError(request, 'marketing_revalidate_webhook_failed', error);
        webhookResult = { attempted: true, delivered: false };
      }
    }

    return reply.code(200).send({
      schemaVersion: 'v1',
      id: snapshot.id,
      version: snapshot.version,
      publishedAt: snapshot.publishedAt,
      publishedBy: snapshot.publishedBy,
      reason: snapshot.reason,
      rowCount: snapshot.rowCount,
      webhookAttempted: webhookResult.attempted,
      webhookDelivered: webhookResult.delivered,
    });
  });

  app.get('/v1/admin/capability-matrix/snapshots', {
    preHandler: adminAuth,
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const snapshots = await store.listSnapshots(request.auth.userId);
    return reply.code(200).send({ schemaVersion: 'v1', snapshots });
  });
}
