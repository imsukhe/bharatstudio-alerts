import type { FastifyInstance } from 'fastify';
import { maintenanceJobs, type MaintenanceJob, type MaintenanceStore, type ServiceIdentityVerifier } from '../domain/maintenance.js';
import { logSafeError } from '../observability/safe-log.js';

// This API process owns only overlay-session maintenance today. Payment and
// refund reconciliation belong to the private Go payment service, outbox
// recovery belongs to the alert worker, and archival handlers are not enabled
// until their retention/ownership contract is approved. Keeping this route
// allowlist narrower than the shared schedule vocabulary prevents a future
// scheduler configuration from turning an unsupported job into a false 202.
const apiOwnedMaintenanceJobs = new Set<MaintenanceJob>(['overlay-sessions', 'overlay-expiry-reminder']);

export async function registerMaintenanceRoutes(app: FastifyInstance, store?: MaintenanceStore, identity?: ServiceIdentityVerifier): Promise<void> {
  app.post<{ Params: { job: MaintenanceJob }; Body: { idempotencyKey: string; window?: string } }>('/internal/maintenance/:job', {
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['job'], properties: { job: { type: 'string', enum: [...maintenanceJobs] } } },
      body: { type: 'object', additionalProperties: false, required: ['idempotencyKey'], properties: { idempotencyKey: { type: 'string', minLength: 16, maxLength: 160 }, window: { type: 'string', minLength: 1, maxLength: 80 } } },
    },
  }, async (request, reply) => {
    if (!identity) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'maintenance_unavailable', message: 'Maintenance service is not configured', traceId: request.id, retryable: true });
    if (!await identity.verify(request.headers.authorization)) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Internal service authorization required', traceId: request.id });
    if (!apiOwnedMaintenanceJobs.has(request.params.job)) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'maintenance_unavailable', message: 'Maintenance job is owned by another private service', traceId: request.id, retryable: true });
    if (!store) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'maintenance_unavailable', message: 'Maintenance service is not configured', traceId: request.id, retryable: true });
    try {
      return reply.code(202).send(await store.execute({ job: request.params.job, idempotencyKey: request.body.idempotencyKey, window: request.body.window }));
    } catch (error) {
      logSafeError(request, 'maintenance_job_failed', error, { job: request.params.job });
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'maintenance_unavailable', message: 'Maintenance job could not be completed', traceId: request.id, retryable: true });
    }
  });
}
