import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { ServiceIdentityVerifier } from '../domain/maintenance.js';
import type { ApiMetrics } from '../observability/metrics.js';
import { runReliabilityReconciliation, defaultReconciliationThresholds, type ReconciliationThresholds } from '../observability/reconciliation.js';
import { persistReconciliationSnapshot, loadLatestReconciliationSnapshot } from '../observability/reconciliation-store.js';
import { logSafeError } from '../observability/safe-log.js';

export type OverlayWakeupHealth = { connected: boolean; reconnects: number; failures: number };

export type MetricsRouteDependencies = {
  metrics: ApiMetrics;
  serviceIdentity?: ServiceIdentityVerifier;
  // Optional: without a `sql` client, /internal/metrics/reconcile stays a
  // 503 rather than silently reporting zero (which would read as "healthy").
  sql?: Sql;
  reconciliationThresholds?: ReconciliationThresholds;
  overlayWakeupHealth?: () => OverlayWakeupHealth | undefined;
};

// Same private boundary as /internal/maintenance/:job (routes/maintenance.ts)
// and the /internal/metrics handler composed by buildApp.
// A metrics/reconcile response never carries a payment, order, event, donor
// or account identifier; it is bounded counts and a timestamp only (see
// ReconciliationSnapshot in observability/metrics.ts).
export async function registerMetricsRoutes(app: FastifyInstance, deps: MetricsRouteDependencies): Promise<void> {
  const { metrics, serviceIdentity } = deps;

  app.get('/internal/metrics', async (request, reply) => {
    if (!serviceIdentity || !await serviceIdentity.verify(request.headers.authorization)) {
      return reply.code(401).type('text/plain; version=0.0.4').send('unauthorized\n');
    }
    // RT-06 §3.4: the in-memory snapshot this process may hold (set by a
    // POST /internal/metrics/reconcile this same process handled) is only
    // ever correct for a single instance. When a database is configured,
    // pull the durably recorded snapshot — written by whichever instance
    // last ran reconciliation — so every instance's scrape agrees. A
    // failure here is a metrics-path failure: it must never fail the
    // scrape (RT-06.6). Fall back silently to whatever this process
    // already holds in memory (possibly nothing yet).
    if (deps.sql) {
      try {
        const durable = await loadLatestReconciliationSnapshot(deps.sql);
        if (durable) metrics.setReconciliationSnapshot(durable);
      } catch (error) {
        logSafeError(request, 'reliability_reconciliation_snapshot_read_failed', error);
      }
    }
    let output = metrics.renderPrometheus();
    const wakeupHealth = deps.overlayWakeupHealth?.();
    if (wakeupHealth) {
      output += '# HELP bsa_overlay_listener_connected Whether the direct overlay listener is connected.\n';
      output += '# TYPE bsa_overlay_listener_connected gauge\n';
      output += `bsa_overlay_listener_connected ${wakeupHealth.connected ? 1 : 0}\n`;
      output += '# HELP bsa_overlay_listener_reconnects_total Overlay listener reconnect attempts.\n';
      output += '# TYPE bsa_overlay_listener_reconnects_total counter\n';
      output += `bsa_overlay_listener_reconnects_total ${wakeupHealth.reconnects}\n`;
      output += '# HELP bsa_overlay_listener_failures_total Overlay listener connection failures.\n';
      output += '# TYPE bsa_overlay_listener_failures_total counter\n';
      output += `bsa_overlay_listener_failures_total ${wakeupHealth.failures}\n`;
    }
    return reply.type('text/plain; version=0.0.4').send(output);
  });

  // Periodic reconciliation trigger. Same idempotency-key shape as
  // /internal/maintenance/:job so the same scheduler mechanism can call it;
  // this route does not itself schedule anything (no cron entry is wired —
  // see "Remaining open"). Safe to call repeatedly: it only reads and then
  // replaces the in-memory gauge snapshot, it writes nothing durable.
  app.post<{ Body: { idempotencyKey: string } }>('/internal/metrics/reconcile', {
    schema: {
      body: { type: 'object', additionalProperties: false, required: ['idempotencyKey'], properties: { idempotencyKey: { type: 'string', minLength: 16, maxLength: 160 } } },
    },
  }, async (request, reply) => {
    if (!serviceIdentity || !await serviceIdentity.verify(request.headers.authorization)) {
      return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'unauthorized', message: 'Internal service authorization required', traceId: request.id });
    }
    if (!deps.sql) {
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'reconciliation_unavailable', message: 'Reconciliation database is not configured', traceId: request.id, retryable: true });
    }
    try {
      const snapshot = await runReliabilityReconciliation(deps.sql, deps.reconciliationThresholds ?? defaultReconciliationThresholds);
      metrics.setReconciliationSnapshot(snapshot);
      // RT-06 §3.4: durable, cross-instance-correct write. A failure here
      // must not undo or fail the reconciliation run that already
      // completed and is already visible on this instance's own scrape —
      // it only means another instance's scrape may still be stale until a
      // later run succeeds. Logged, not fatal.
      try {
        await persistReconciliationSnapshot(deps.sql, snapshot);
      } catch (persistError) {
        logSafeError(request, 'reliability_reconciliation_snapshot_persist_failed', persistError);
      }
      return reply.code(200).send({ schemaVersion: 'v1', ...snapshot });
    } catch (error) {
      logSafeError(request, 'reliability_reconciliation_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'reconciliation_unavailable', message: 'Reconciliation could not be completed', traceId: request.id, retryable: true });
    }
  });
}
