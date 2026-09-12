import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFaultInjectionAllowed,
  simulateDuplicateWebhookDelivery,
  simulateNeverAckingDelivery,
  simulateSlowProvider,
  FaultInjectionDisabledError,
  FAULT_INJECTION_ENV_VAR,
} from '../src/observability/fault-guard.js';

// No live database is used here — these tests prove the gate itself is
// inert by default, which must hold true with zero infrastructure running.
// The DB-backed fault primitives (duplicate webhook -> one LiveEvent,
// mid-transaction rollback) are proven separately against a real disposable
// Postgres container by scripts/load/l09-fault-duplicate-webhook-self-test.ts
// (see that file's own header for why it cannot live in this DB-less suite).

test('throws when neither NODE_ENV nor the switch is set', () => {
  assert.throws(() => assertFaultInjectionAllowed({}), FaultInjectionDisabledError);
});

test('throws when the switch is set but NODE_ENV=production — production wins unconditionally', () => {
  assert.throws(
    () => assertFaultInjectionAllowed({ NODE_ENV: 'production', [FAULT_INJECTION_ENV_VAR]: '1' }),
    FaultInjectionDisabledError,
  );
});

test('throws when NODE_ENV is non-production but the switch is unset', () => {
  assert.throws(() => assertFaultInjectionAllowed({ NODE_ENV: 'test' }), FaultInjectionDisabledError);
});

test('throws when the switch is set to any value other than the literal "1"', () => {
  assert.throws(() => assertFaultInjectionAllowed({ NODE_ENV: 'test', [FAULT_INJECTION_ENV_VAR]: 'true' }), FaultInjectionDisabledError);
});

test('allows only when NODE_ENV is non-production AND the switch is exactly "1"', () => {
  assert.doesNotThrow(() => assertFaultInjectionAllowed({ NODE_ENV: 'test', [FAULT_INJECTION_ENV_VAR]: '1' }));
});

test('every exported fault primitive refuses to run without the explicit switch', async () => {
  await assert.rejects(() => simulateDuplicateWebhookDelivery(async () => 'unreachable', {}), FaultInjectionDisabledError);
  assert.throws(() => simulateNeverAckingDelivery({}), FaultInjectionDisabledError);
  await assert.rejects(() => simulateSlowProvider(0, {}), FaultInjectionDisabledError);
});

test('every exported fault primitive refuses to run when NODE_ENV=production, even with the switch set', async () => {
  const prodEnv = { NODE_ENV: 'production', [FAULT_INJECTION_ENV_VAR]: '1' };
  await assert.rejects(() => simulateDuplicateWebhookDelivery(async () => 'unreachable', prodEnv), FaultInjectionDisabledError);
  assert.throws(() => simulateNeverAckingDelivery(prodEnv), FaultInjectionDisabledError);
  await assert.rejects(() => simulateSlowProvider(0, prodEnv), FaultInjectionDisabledError);
});

test('simulateDuplicateWebhookDelivery calls the submit function exactly twice when allowed', async () => {
  let calls = 0;
  const result = await simulateDuplicateWebhookDelivery(async () => { calls += 1; return calls; }, { NODE_ENV: 'test', [FAULT_INJECTION_ENV_VAR]: '1' });
  assert.equal(calls, 2);
  assert.deepEqual(result, { first: 1, second: 2 });
});
