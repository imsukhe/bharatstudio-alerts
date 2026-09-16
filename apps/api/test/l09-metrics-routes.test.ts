import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Sql } from 'postgres';
import { registerMetricsRoutes } from '../src/routes/metrics.js';
import { createApiMetrics } from '../src/observability/metrics.js';

// `buildApp` now wires metrics in production. This suite uses a bare Fastify
// instance to isolate the service-identity and reconciliation boundaries.

const identity = { verify: async (authorization?: string) => authorization === 'Bearer worker-token' };

function mockSql(responses: unknown[][]): Sql {
  let call = 0;
  const fn = ((...args: unknown[]) => {
    const first = args[0] as { raw?: unknown } | unknown[];
    const isTaggedTemplateCall = first !== null && typeof first === 'object' && 'raw' in (first as object);
    if (isTaggedTemplateCall) {
      const result = responses[call] ?? [];
      call += 1;
      return Promise.resolve(result);
    }
    return first;
  }) as unknown as Sql;
  return fn;
}

test('GET /internal/metrics rejects a request with no service identity', async () => {
  const app = Fastify();
  await registerMetricsRoutes(app, { metrics: createApiMetrics() });
  const response = await app.inject({ method: 'GET', url: '/internal/metrics' });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('GET /internal/metrics rejects an invalid bearer token the same way', async () => {
  const app = Fastify();
  await registerMetricsRoutes(app, { metrics: createApiMetrics(), serviceIdentity: identity });
  const response = await app.inject({ method: 'GET', url: '/internal/metrics', headers: { authorization: 'Bearer wrong' } });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('GET /internal/metrics returns the scrape for a verified internal caller', async () => {
  const app = Fastify();
  const metrics = createApiMetrics();
  metrics.recordTtsFailure('timeout');
  await registerMetricsRoutes(app, { metrics, serviceIdentity: identity });
  const response = await app.inject({ method: 'GET', url: '/internal/metrics', headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /bsa_tts_failures_total\{reason="timeout"\} 1/);
  await app.close();
});

test('the scrape endpoint never exposes payment data, tokens or personal data', async () => {
  const app = Fastify();
  const metrics = createApiMetrics();
  metrics.observe('POST', '/internal/v1/tips/orders', 200, 40);
  metrics.setReconciliationSnapshot({
    capturedPaymentsWithoutLiveEvent: 1,
    duplicateLiveEvents: 0,
    lostDeliveries: 0,
    webhookLagMsMax: 10,
    webhookLagMsAvg: 5,
    refundFailures: 0,
    observedAt: new Date().toISOString(),
  });
  await registerMetricsRoutes(app, { metrics, serviceIdentity: identity });
  const response = await app.inject({ method: 'GET', url: '/internal/metrics', headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  const forbidden = [/authorization/i, /bearer worker-token/i, /provider_payment_id/i, /razorpay:/i, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(response.body), false, `scrape output must not match ${pattern}`);
  }
  await app.close();
});

test('POST /internal/metrics/reconcile requires service identity', async () => {
  const app = Fastify();
  await registerMetricsRoutes(app, { metrics: createApiMetrics(), serviceIdentity: identity });
  const response = await app.inject({ method: 'POST', url: '/internal/metrics/reconcile', payload: { idempotencyKey: 'synthetic-reconcile-key-0001' } });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('POST /internal/metrics/reconcile fails closed (503) when no database is configured', async () => {
  const app = Fastify();
  await registerMetricsRoutes(app, { metrics: createApiMetrics(), serviceIdentity: identity });
  const response = await app.inject({
    method: 'POST',
    url: '/internal/metrics/reconcile',
    headers: { authorization: 'Bearer worker-token' },
    payload: { idempotencyKey: 'synthetic-reconcile-key-0001' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'reconciliation_unavailable');
  await app.close();
});

test('POST /internal/metrics/reconcile runs the checks and the gauges show up on the next scrape', async () => {
  const app = Fastify();
  const metrics = createApiMetrics();
  const sql = mockSql([
    [{ count: '4' }],
    [{ count: '2' }],
    [{ count: '9' }],
    [{ max_ms: '1500', avg_ms: '300' }],
    [{ count: '1' }],
  ]);
  await registerMetricsRoutes(app, { metrics, serviceIdentity: identity, sql });
  const reconcileResponse = await app.inject({
    method: 'POST',
    url: '/internal/metrics/reconcile',
    headers: { authorization: 'Bearer worker-token' },
    payload: { idempotencyKey: 'synthetic-reconcile-key-0002' },
  });
  assert.equal(reconcileResponse.statusCode, 200);
  assert.equal(reconcileResponse.json().capturedPaymentsWithoutLiveEvent, 4);
  assert.equal(reconcileResponse.json().duplicateLiveEvents, 2);

  const scrapeResponse = await app.inject({ method: 'GET', url: '/internal/metrics', headers: { authorization: 'Bearer worker-token' } });
  assert.match(scrapeResponse.body, /bsa_reconciliation_captured_payments_without_live_event 4/);
  assert.match(scrapeResponse.body, /bsa_reconciliation_duplicate_live_events 2/);
  assert.match(scrapeResponse.body, /bsa_reconciliation_lost_deliveries 9/);
  assert.match(scrapeResponse.body, /bsa_reconciliation_refund_failures 1/);
  await app.close();
});

test('POST /internal/metrics/reconcile fails closed (503), not silently zero, when a query throws', async () => {
  const app = Fastify();
  const metrics = createApiMetrics();
  const throwingSql = (() => { throw new Error('connection reset'); }) as unknown as Sql;
  await registerMetricsRoutes(app, { metrics, serviceIdentity: identity, sql: throwingSql });
  const response = await app.inject({
    method: 'POST',
    url: '/internal/metrics/reconcile',
    headers: { authorization: 'Bearer worker-token' },
    payload: { idempotencyKey: 'synthetic-reconcile-key-0003' },
  });
  assert.equal(response.statusCode, 503);
  await app.close();
});

// The scheduler sends `{ idempotencyKey, window }` to every job in
// bharatstudio-crons/schedules/v1.json, so this route must accept that
// shape. It now declares `window` explicitly rather than relying on Fastify
// silently dropping it.
test('POST /internal/metrics/reconcile accepts the scheduler body shape, window included', async () => {
  const app = Fastify();
  await registerMetricsRoutes(app, { metrics: createApiMetrics(), serviceIdentity: identity });
  const response = await app.inject({
    method: 'POST',
    url: '/internal/metrics/reconcile',
    headers: { authorization: 'Bearer worker-token' },
    payload: { idempotencyKey: 'schedule:reliability-reconciliation:2026-09-16T00:00', window: '2026-09-16T00:00' },
  });
  // 503 (no database configured in this harness), never 400: the body was
  // accepted and the request reached the handler.
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'reconciliation_unavailable');
  await app.close();
});

// Documents a Fastify behaviour that is easy to get wrong and that this
// codebase's `additionalProperties: false` schemas depend on: Fastify
// configures AJV with `removeAdditional: true`, so an unknown field is
// STRIPPED, not rejected. This route therefore never 400s on an extra field
// — it reaches the handler with that field removed. Asserted so nobody
// (including a future reviewer reasoning about the scheduler contract)
// concludes from the schema alone that an unexpected field is refused.
test('an unknown body field is stripped by Fastify, not rejected', async () => {
  const app = Fastify();
  await registerMetricsRoutes(app, { metrics: createApiMetrics(), serviceIdentity: identity });
  const response = await app.inject({
    method: 'POST',
    url: '/internal/metrics/reconcile',
    headers: { authorization: 'Bearer worker-token' },
    payload: { idempotencyKey: 'synthetic-reconcile-key-0001', unexpectedField: 'no' },
  });
  // 503 = reached the handler (no database in this harness). Not 400.
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'reconciliation_unavailable');
  await app.close();
});
