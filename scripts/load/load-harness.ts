// L09 load harness — drives payment webhook -> alert_event -> outbox ->
// delivery -> overlay ack at configurable concurrency against a
// locally-running Postgres, then proves the two MASTER-PLAN §11.2
// invariants using the reconciliation queries that already exist
// (apps/api/src/observability/reconciliation.ts) rather than parallel ones.
//
// WHAT THIS PROVES: that the real SQL transaction boundary
// (app_private.record_verified_payment_webhook — the same function the Go
// payment-webhook service calls) and the real overlay listen/ack code
// (apps/api/src/db/overlay-store.ts) hold the "no lost captured payment,
// no duplicate financial event" invariants under concurrent load and under
// the fault-guard.ts fault primitives, against a disposable local
// PostgreSQL 16 container.
//
// WHAT THIS DOES NOT PROVE: this is not a staging or production load test.
// It never starts the Go payment-webhook or alert-worker binaries, never
// sends an HTTP request, never exercises Razorpay signature verification,
// Cloud Tasks dispatch, or a real SSE connection — see this repo's
// docs/runbooks/ additions and the L09 task file's own "none of it is
// proven in a deployed environment" section for the deployment-evidence gap
// this harness explicitly does not close. Latency numbers here reflect one
// laptop's disposable Postgres container, not a sized database plan.
//
// Synthetic data only.
import { createFixtureSqlClient, seedWorld, teardownWorld, type SeededWorld } from '../fixtures/alerts-fixture.js';
import {
  ensurePaymentAccount,
  seedCheckoutIntent,
  submitVerifiedPaymentWebhook,
  acknowledgeDeliveryForEvent,
  teardownCheckoutArtifacts,
} from './webhook-critical-path.js';
import { runReliabilityReconciliation } from '../../apps/api/src/observability/reconciliation.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';

export interface LoadRunOptions {
  worldKey: string;
  tipCount: number;
  concurrency: number;
}

export interface TipResult {
  ok: boolean;
  durationMs: number;
  duplicate: boolean;
  quarantined: boolean;
  acknowledged: boolean;
  error?: string;
}

export interface LoadRunReport {
  worldKey: string;
  tipCount: number;
  concurrency: number;
  succeeded: number;
  failed: number;
  quarantined: number;
  unacknowledged: number;
  latencyMsP50: number;
  latencyMsP95: number;
  latencyMsMax: number;
  invariants: {
    capturedPaymentsWithoutLiveEvent: number;
    duplicateLiveEvents: number;
  };
}

async function runOneTip(sql: Sql, world: Pick<SeededWorld, 'channelId' | 'overlayId' | 'overlayToken'>, connectedAccountRef: string, paymentAccountId: string): Promise<TipResult> {
  const started = Date.now();
  try {
    const intent = await seedCheckoutIntent(sql, world, paymentAccountId, connectedAccountRef);
    const providerEventId = randomUUID();
    const providerPaymentId = `pay_load_${randomBytes(8).toString('hex')}`;
    const result = await submitVerifiedPaymentWebhook(sql, { providerEventId, providerPaymentId, intent });
    if (result.quarantined) {
      return { ok: false, durationMs: Date.now() - started, duplicate: result.duplicate, quarantined: true, acknowledged: false, error: 'quarantined' };
    }
    const ackOutcome = await acknowledgeDeliveryForEvent(sql, world.overlayId, world.overlayToken, providerEventId);
    return { ok: true, durationMs: Date.now() - started, duplicate: result.duplicate, quarantined: false, acknowledged: ackOutcome === 'acknowledged' };
  } catch (error) {
    return { ok: false, durationMs: Date.now() - started, duplicate: false, quarantined: false, acknowledged: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runWithConcurrency<T>(items: number, concurrency: number, worker: (index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(items);
  let next = 0;
  async function lane(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items) return;
      results[index] = await worker(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items) }, () => lane()));
  return results;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

// Runs the load, then proves the two invariants and tears down cleanly.
// Caller owns the Sql client's lifecycle (see run-load-harness.ts / the
// self-tests, which call sql.end() themselves).
export async function runLoadTest(sql: Sql, opts: LoadRunOptions): Promise<LoadRunReport> {
  const world = await seedWorld(sql, { worldKey: opts.worldKey, handle: `load_${opts.worldKey}`, tier: 'creator' });
  const connectedAccountRef = `acct-load-${opts.worldKey}`;
  const paymentAccountId = await ensurePaymentAccount(sql, world.channelId, connectedAccountRef);

  const results = await runWithConcurrency(opts.tipCount, opts.concurrency, () => runOneTip(sql, world, connectedAccountRef, paymentAccountId));

  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  // Tight thresholds (0 minutes), not the production defaults in
  // reconciliation.ts — a load run wants an immediate answer, not a wait
  // for the 15/30-minute production grace windows to elapse.
  const snapshot = await runReliabilityReconciliation(sql, { capturedPaymentGraceMinutes: 0, deliveryStalenessMinutes: 0, refundFailureGraceMinutes: 0 });

  await teardownCheckoutArtifacts(sql, world.channelId, connectedAccountRef, world.overlayId);
  await teardownWorld(sql, world);

  return {
    worldKey: opts.worldKey,
    tipCount: opts.tipCount,
    concurrency: opts.concurrency,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.quarantined).length,
    quarantined: results.filter((r) => r.quarantined).length,
    unacknowledged: results.filter((r) => r.ok && !r.acknowledged).length,
    latencyMsP50: percentile(durations, 50),
    latencyMsP95: percentile(durations, 95),
    latencyMsP99: percentile(durations, 99),
    latencyMsMax: durations[durations.length - 1] ?? 0,
    invariants: {
      capturedPaymentsWithoutLiveEvent: snapshot.capturedPaymentsWithoutLiveEvent,
      duplicateLiveEvents: snapshot.duplicateLiveEvents,
    },
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL_DIRECT (or DATABASE_URL) must be set to a disposable database — see run-load-harness.sh');
  const tipCount = Number(process.env.LOAD_TIP_COUNT ?? '50');
  const concurrency = Number(process.env.LOAD_CONCURRENCY ?? '10');
  const sql = createFixtureSqlClient(databaseUrl);
  try {
    const report = await runLoadTest(sql, { worldKey: `load-${Date.now()}`, tipCount, concurrency });
    console.log(JSON.stringify(report, null, 2));
    if (report.invariants.capturedPaymentsWithoutLiveEvent > 0 || report.invariants.duplicateLiveEvents > 0) {
      console.error('L09 LOAD RUN FAILED an invariant — see docs/runbooks/load-run-invariant-failure.md');
      process.exitCode = 1;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run as a CLI entrypoint (tsx scripts/load/load-harness.ts), not when
// imported by the self-tests. Compares realpaths, not raw argv[1] against
// import.meta.url — a symlinked working directory (e.g. macOS /tmp ->
// /private/tmp) makes those two disagree even for the same file.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main();
}
