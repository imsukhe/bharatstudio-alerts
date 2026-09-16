import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import type { Sql } from 'postgres';
import { registerMetricsRoutes } from '../src/routes/metrics.js';
import { createApiMetrics } from '../src/observability/metrics.js';

// `buildApp` now wires metrics in production. This suite mounts the metrics
// routes on a standalone `createTestFastify()` instance to isolate the
// service-identity and reconciliation boundaries — standalone, but validating
// under the same ajv options as the real server, never a bare `Fastify()`.

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
  const app = createTestFastify();
  await registerMetricsRoutes(app, { metrics: createApiMetrics() });
  const response = await app.inject({ method: 'GET', url: '/internal/metrics' });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('GET /internal/metrics rejects an invalid bearer token the same way', async () => {
  const app = createTestFastify();
  await registerMetricsRoutes(app, { metrics: createApiMetrics(), serviceIdentity: identity });
  const response = await app.inject({ method: 'GET', url: '/internal/metrics', headers: { authorization: 'Bearer wrong' } });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('GET /internal/metrics returns the scrape for a verified internal caller', async () => {
  const app = createTestFastify();
  const metrics = createApiMetrics();
  metrics.recordTtsFailure('timeout');
  await registerMetricsRoutes(app, { metrics, serviceIdentity: identity });
  const response = await app.inject({ method: 'GET', url: '/internal/metrics', headers: { authorization: 'Bearer worker-token' } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /bsa_tts_failures_total\{reason="timeout"\} 1/);
  await app.close();
});

test('the scrape endpoint never exposes payment data, tokens or personal data', async () => {
  const app = createTestFastify();
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
  const app = createTestFastify();
  await registerMetricsRoutes(app, { metrics: createApiMetrics(), serviceIdentity: identity });
  const response = await app.inject({ method: 'POST', url: '/internal/metrics/reconcile', payload: { idempotencyKey: 'synthetic-reconcile-key-0001' } });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('POST /internal/metrics/reconcile fails closed (503) when no database is configured', async () => {
  const app = createTestFastify();
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
  const app = createTestFastify();
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
  const app = createTestFastify();
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
  const app = createTestFastify();
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

// CORRECTED 2026-09-16 (review: 2026-09-16-api-test-harness-validation-divergence).
// This test previously ran on a bare `Fastify()` and asserted the OPPOSITE of
// what this API does. It was titled "an unknown body field is stripped by
// Fastify, not rejected" and asserted `statusCode === 503`, i.e. that the
// request reached the handler with the extra field silently removed. That is
// true only of Fastify's AJV DEFAULT (`removeAdditional: true`), which this
// application does not use: `src/fastify-ajv-options.ts` sets
// `removeAdditional: false`, so an undeclared field under
// `additionalProperties: false` is REJECTED with 400 FST_ERR_VALIDATION and
// the handler never runs. The old assertion documented the harness, not the
// server, and would have misled exactly the reviewer it was written for.
test('an unknown body field is rejected with 400, not silently stripped', async () => {
  const app = createTestFastify();
  await registerMetricsRoutes(app, { metrics: createApiMetrics(), serviceIdentity: identity });
  const response = await app.inject({
    method: 'POST',
    url: '/internal/metrics/reconcile',
    headers: { authorization: 'Bearer worker-token' },
    payload: { idempotencyKey: 'synthetic-reconcile-key-0001', unexpectedField: 'no' },
  });
  // 400 = refused at the schema layer. Never 503, which would mean the body
  // was accepted and the handler ran.
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'FST_ERR_VALIDATION');
  await app.close();
});
