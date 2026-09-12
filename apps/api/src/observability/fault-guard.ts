// L09 fault-injection primitives — deliberately induce the failures the
// docs/runbooks/*.md describe, so a load run can prove the two reliability
// invariants (MASTER-PLAN §11.2: "Lost captured payment = unacceptable",
// "Duplicate financial event = unacceptable") hold under stress.
//
// SAFETY: nothing in this file is imported by apps/api/src/app.ts,
// index.ts, or any route — it is never reachable from a running API
// process at all. It exists to be imported by the scripts/load/ harness
// only. As defense in depth beyond that structural isolation, every
// exported fault primitive calls `assertFaultInjectionAllowed` first, which
// throws unless BOTH:
//   (a) NODE_ENV is not 'production' — checked first and unconditionally;
//       no env var can override this branch, so a mistaken flag flip in a
//       production-configured process still refuses.
//   (b) process.env.BSA_FAULT_INJECTION_ENABLE === '1' — an explicit,
//       single-purpose switch nothing else in this codebase sets.
// Both conditions are asserted by apps/api/test/l09-fault-injection-guard.test.ts.
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';

export const FAULT_INJECTION_ENV_VAR = 'BSA_FAULT_INJECTION_ENABLE';

export class FaultInjectionDisabledError extends Error {
  constructor(reason: string) {
    super(`fault injection is inert: ${reason}`);
    this.name = 'FaultInjectionDisabledError';
  }
}

export function assertFaultInjectionAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const nodeEnv = env.NODE_ENV ?? '';
  if (nodeEnv === 'production') {
    throw new FaultInjectionDisabledError(`NODE_ENV=production; fault injection can never run in production regardless of any other flag`);
  }
  if (env[FAULT_INJECTION_ENV_VAR] !== '1') {
    throw new FaultInjectionDisabledError(`${FAULT_INJECTION_ENV_VAR}=1 was not set explicitly (NODE_ENV=${nodeEnv || 'unset'})`);
  }
}

// Fault 1: "a webhook that arrives twice". Generic over the caller's own
// single-submission function so this file never needs to import
// scripts/load's webhook-critical-path module (this file lives under
// apps/api/src, which must stay buildable standalone via `tsc -p .` —
// importing outside apps/api's rootDir would break that). The caller
// (scripts/load/load-harness.ts) passes `() => submitVerifiedPaymentWebhook(sql, opts)`
// with the SAME providerEventId on both calls — that is what makes this a
// faithful "same x-razorpay-event-id retried" simulation, not just two
// unrelated calls. The real dedup this exercises is the unique constraint
// on payment_webhook_deliveries(provider, environment, connected_account_ref,
// provider_event_id) inside app_private.record_verified_payment_webhook.
export async function simulateDuplicateWebhookDelivery<T>(
  submitOnce: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ first: T; second: T }> {
  assertFaultInjectionAllowed(env);
  const first = await submitOnce();
  const second = await submitOnce();
  return { first, second };
}

// Fault 2: "a delivery that never acks". A no-op by design — the caller
// simply omits the acknowledge step this harness would otherwise perform.
// This function exists so the omission is a named, gated, auditable action
// (and so a caller cannot claim "delivery never acked" happened by
// accident) rather than a silently missing line in a load script.
export function simulateNeverAckingDelivery(env: NodeJS.ProcessEnv = process.env): void {
  assertFaultInjectionAllowed(env);
  // Intentionally does nothing: the delivery stays in 'ready'/'displayed'
  // and will surface via bsa_reconciliation_lost_deliveries once the
  // configured staleness window elapses (see reconciliation.ts).
}

// Fault 3: "a database error mid-transaction". Opens a real transaction,
// performs a partial write, then forces a rollback — proving a mid-write
// failure leaves no partial financial row behind rather than a duplicate or
// half-committed one. Returns whether the forced row is (correctly) absent
// after rollback.
export async function simulateDatabaseErrorMidTransaction(sql: Sql, channelId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ rolledBackCleanly: boolean; probeId: string }> {
  assertFaultInjectionAllowed(env);
  const probeId = randomUUID();
  try {
    await sql.begin(async (tx) => {
      await tx`
        insert into alert_events (id, channel_id, payment_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
        values (${probeId}::uuid, ${channelId}::uuid, null, 'manual', ${'fault-probe-' + probeId}, ${'fault-probe-trace-' + probeId}, 1, ${sql.json({ synthetic: true, faultInjected: true })}, current_timestamp)
      `;
      throw new Error('l09-fault: forced mid-transaction database error');
    });
  } catch {
    // expected — the throw above is the injected fault
  }
  const rows = await sql<{ id: string }[]>`select id from alert_events where id = ${probeId}::uuid`;
  return { rolledBackCleanly: rows.length === 0, probeId };
}

// Fault 4: "a slow provider". Delays before letting the caller proceed,
// simulating a Razorpay round trip well past normal latency, to observe
// how the harness's own timeout/backoff behaves under load. Bounded to 60s
// so a misused delay cannot hang a run indefinitely.
export async function simulateSlowProvider(delayMs: number, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertFaultInjectionAllowed(env);
  const bounded = Math.max(0, Math.min(delayMs, 60_000));
  await new Promise((resolve) => setTimeout(resolve, bounded));
}
