import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createApiMetrics,
  createHistogram,
  observeHistogram,
  estimateQuantile,
  mergeHistograms,
  classifyBudgetedPath,
  READ_DURATION_BUCKETS_MS,
  TIP_ORDER_DURATION_BUCKETS_MS,
} from '../src/observability/metrics.js';

// RT-06.1: every §19.4 budget a path carries appears as an exact bucket
// boundary for that path.
test('RT-06.1: the read and tip-order histograms carry their exact §19.4 budget boundary', () => {
  assert.ok(READ_DURATION_BUCKETS_MS.includes(200), 'API reads budget is p99 < 200ms');
  assert.ok(TIP_ORDER_DURATION_BUCKETS_MS.includes(500), 'tip-order path budget is p99 < 500ms');

  const metrics = createApiMetrics();
  metrics.observe('GET', '/v1/public/channels/somecreator', 200, 42);
  metrics.observe('POST', '/v1/public/channels/somecreator/tips/orders', 201, 120);
  const output = metrics.renderPrometheus();
  assert.match(output, /bsa_api_read_duration_ms_bucket\{le="200"\}/);
  assert.match(output, /bsa_api_tip_order_duration_ms_bucket\{le="500"\}/);
});

test('RT-06.1: route classification is exact — only GET non-internal routes and the tip-order POST are budgeted', () => {
  assert.equal(classifyBudgetedPath('GET', '/v1/public/channels/x'), 'read');
  assert.equal(classifyBudgetedPath('POST', '/v1/public/channels/:handle/tips/orders'), 'tip_order');
  assert.equal(classifyBudgetedPath('GET', '/internal/metrics'), null);
  assert.equal(classifyBudgetedPath('POST', '/v1/public/channels/:handle/interactions'), null);
  assert.equal(classifyBudgetedPath('GET', 'unknown'), null);
});

// RT-06.2: a known set of observations yields the arithmetically correct
// bucket counts.
test('RT-06.2: observeHistogram produces exact bucket counts for a known set of observations', () => {
  const histogram = createHistogram([10, 25, 50, 100]);
  const values = [5, 9, 10, 15, 24, 50, 51, 90, 100, 250];
  for (const value of values) observeHistogram(histogram, value);
  // (0,10]: 5,9,10 -> 3   (10,25]: 15,24 -> 2   (25,50]: 50 -> 1
  // (50,100]: 51,90,100 -> 3   >100 (+Inf only, no finite slot): 250
  assert.deepEqual(histogram.counts, [3, 2, 1, 3]);
  assert.equal(histogram.count, values.length);
  assert.equal(histogram.sum, values.reduce((a, b) => a + b, 0));
});

test('RT-06.6: observeHistogram never throws on a pathological value and still counts the observation', () => {
  const histogram = createHistogram([10, 20]);
  for (const value of [NaN, -5, -0.0001, Infinity, -Infinity]) {
    assert.doesNotThrow(() => observeHistogram(histogram, value));
  }
  assert.equal(histogram.count, 5);
  assert.equal(histogram.counts[0], 5, 'every pathological value must clamp into the first bucket, not vanish');
});

test('RT-06.6: metrics.observe never throws even for a pathological duration, and the response-carrying counters are unaffected', () => {
  const metrics = createApiMetrics();
  assert.doesNotThrow(() => metrics.observe('GET', '/v1/public/channels/x', 200, NaN));
  assert.doesNotThrow(() => metrics.observe('GET', '/v1/public/channels/x', 200, -1));
  assert.doesNotThrow(() => metrics.observe('GET', '/v1/public/channels/x', 200, Infinity));
  const output = metrics.renderPrometheus();
  assert.match(output, /bsa_api_requests_total\{method="GET",route="\/v1\/public\/channels\/x",status_code="200"\} 3/);
});

// RT-06.3: the p95/p99 read-out is correct for a known distribution, and its
// documented error bound holds.
test('RT-06.3: estimateQuantile matches a known distribution within the bound of the bucket containing the true value', () => {
  // 100 observations: 95 at 10ms, 5 at 200ms. Nearest-rank: the 95th sorted
  // value is 10ms (bucket (0,10]); the 99th sorted value is 200ms (bucket
  // (100,200]).
  const histogram = createHistogram([10, 50, 100, 200, 500]);
  for (let i = 0; i < 95; i += 1) observeHistogram(histogram, 10);
  for (let i = 0; i < 5; i += 1) observeHistogram(histogram, 200);

  const p95 = estimateQuantile(histogram, 0.95);
  assert.ok(p95 !== null && p95 >= 0 && p95 <= 10, `p95 estimate ${p95} escaped bound [0,10]`);

  const p99 = estimateQuantile(histogram, 0.99);
  assert.ok(p99 !== null && p99 >= 100 && p99 <= 200, `p99 estimate ${p99} escaped bound [100,200]`);
});

test('RT-06.3: estimateQuantile on an empty histogram reports no observations, not a fabricated number', () => {
  const histogram = createHistogram([10, 20]);
  assert.equal(estimateQuantile(histogram, 0.99), null);
});

test('RT-06.3: the rendered p95/p99 gauges are present with an explicit bound disclosure in their HELP text', () => {
  const metrics = createApiMetrics();
  metrics.observe('GET', '/v1/public/channels/x', 200, 42);
  const output = metrics.renderPrometheus();
  assert.match(output, /bsa_api_read_duration_ms_p95_estimate \d/);
  assert.match(output, /bsa_api_read_duration_ms_p99_estimate \d/);
  assert.match(output, /Bucket-interpolated p99 estimate; bounded by the containing bucket's width, not exact/);
});

// RT-06.4: per-instance histograms sum correctly — the additive property
// cross-instance aggregation depends on.
test('RT-06.4: mergeHistograms sums two independently observed histograms arithmetically correctly', () => {
  const a = createHistogram([10, 20, 30]);
  observeHistogram(a, 5);
  observeHistogram(a, 15);
  observeHistogram(a, 15);
  const b = createHistogram([10, 20, 30]);
  observeHistogram(b, 5);
  observeHistogram(b, 25);
  observeHistogram(b, 100);

  const merged = mergeHistograms(a, b);
  assert.deepEqual(merged.counts, [2, 2, 1]);
  assert.equal(merged.count, a.count + b.count);
  assert.equal(merged.sum, a.sum + b.sum);
});

test('RT-06.4: mergeHistograms refuses to merge histograms with different bucket boundaries', () => {
  const a = createHistogram([10, 20]);
  const b = createHistogram([10, 30]);
  assert.throws(() => mergeHistograms(a, b));
});

// RT-06.5: labels stay bounded and low-cardinality — no payment, order,
// event, channel or donor identifier can reach a label. The two budgeted
// histograms carry zero labels; the existing per-route counters already
// carry only the normalized Fastify route pattern (never an interpolated
// id — Fastify's routeOptions.url is the pattern itself, e.g.
// "/v1/public/channels/:handle/tips/orders", not the real path).
test('RT-06.5: the budgeted histograms carry no labels of any kind', () => {
  const metrics = createApiMetrics();
  metrics.observe('GET', '/v1/public/channels/x', 200, 42);
  metrics.observe('POST', '/v1/public/channels/:handle/tips/orders', 201, 120);
  const output = metrics.renderPrometheus();
  for (const line of output.split('\n')) {
    if (line.startsWith('bsa_api_read_duration_ms') || line.startsWith('bsa_api_tip_order_duration_ms')) {
      if (line.includes('{')) assert.match(line, /\{le="[^"]+"\}/, `unexpected label on ${line}`);
    }
  }
});

// RT-06.7: the exposition output parses and keeps its existing shape for
// existing metrics — every counter/gauge this suite already asserted on
// before RT-06 must still render identically.
test('RT-06.7: existing counters and gauges keep their pre-RT-06 shape', () => {
  const metrics = createApiMetrics();
  metrics.recordTtsFailure('timeout');
  metrics.recordOverlayNotification('routed');
  metrics.observe('GET', '/v1/public/channels/x', 200, 10);
  const output = metrics.renderPrometheus();
  assert.match(output, /# TYPE bsa_api_requests_total counter/);
  assert.match(output, /# TYPE bsa_api_request_duration_ms_sum counter/);
  assert.match(output, /bsa_tts_failures_total\{reason="timeout"\} 1/);
  assert.match(output, /bsa_overlay_notifications_total\{outcome="routed"\} 1/);
  assert.match(output, /bsa_reconciliation_last_run_timestamp_seconds 0/);
  // Every line still parses as either a comment or a bare "name{labels} value" /
  // "name value" Prometheus text-exposition line.
  for (const line of output.split('\n')) {
    if (!line) continue;
    assert.match(line, /^#|^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?\d/, `unparsable exposition line: ${line}`);
  }
});
