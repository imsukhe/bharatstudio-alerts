#!/usr/bin/env node
// PRF-01 / RT-06 CI budget-gate mechanism.
//
// Scope, exactly as decided in bharatstudio-requirements/active/launch and
// FULL-PRODUCT-DEFINITION.md §19.0 RT-06, §19.4, §31.18.1 PRF-01:
//
//   PART A — structural. Renders the REAL Prometheus exposition text this
//   process's own apps/api/src/observability/metrics.ts produces (imported
//   from the built apps/api/dist, never re-implemented here), and parses
//   that TEXT — not the internal Histogram object — to assert the two
//   §19.4 boundary buckets are present on the wire:
//     bsa_api_read_duration_ms_bucket{le="200"}       (API reads, §19.4)
//     bsa_api_tip_order_duration_ms_bucket{le="500"}  (tip-order path, §19.4)
//   This is a genuine regression check: if a future change drops either
//   boundary from READ_DURATION_BUCKETS_MS / TIP_ORDER_DURATION_BUCKETS_MS,
//   this fails the build.
//
//   PART B — self-test. "A gate never seen to fail is not a gate." Feeds
//   the same boundary-bucket pass/fail evaluator a synthetic histogram
//   deliberately breaching the boundary and asserts the evaluator reports
//   FAIL. This runs unconditionally, every CI run, and proves the failure
//   path is live — it is not gated on any environment variable.
//
//   PART C — absolute thresholds, wired but INERT. Reads the two §19.4
//   duration numbers (200ms reads, 500ms tip-order) as the threshold
//   values, from CI environment variables that this workflow never sets
//   (CI_PRF01_API_READ_P99_BUDGET_MS, CI_PRF01_TIP_ORDER_P99_BUDGET_MS).
//   This is the same "configured but unset" pattern RT-02
//   (OVERLAY_MAX_*_SUBSCRIBERS), RT-10 and RT-11 already use. It never
//   affects this script's exit code, because there is no live-traffic feed
//   in this CI job for it to check — that feed needs ENV-08 (staging
//   environment) and RT-07 (real browser/OBS/device evidence), and both
//   are Blocked. Setting the env vars later, once a real feed exists, is a
//   configuration change, not a code change.
//
// Honesty discipline (§35.1 rule 6, run_local_measurement.py's own model):
// nothing this script prints or exits with is evidence that any §19.4
// budget is met in production. It proves the metrics WIRE FORMAT is
// correct and that the pass/fail MECHANISM can fail. RT-07 remains
// Blocked. externalEvidence: not-claimed.

import { createApiMetrics, classifyBudgetedPath } from '../../apps/api/dist/src/observability/metrics.js';

const READ_LE = '200';
const TIP_ORDER_LE = '500';
// Not exported by metrics.ts (kept private there); this is the literal
// route-pattern string classifyBudgetedPath compares against, taken
// verbatim from apps/api/src/observability/metrics.ts's TIP_ORDER_ROUTE
// constant. Verified below via classifyBudgetedPath itself, not assumed.
const TIP_ORDER_ROUTE = '/v1/public/channels/:handle/tips/orders';
const READ_ROUTE = '/v1/public/channels/:handle';

let failures = 0;
function fail(message) {
  failures += 1;
  console.error(`FAIL: ${message}`);
}
function ok(message) {
  console.log(`OK: ${message}`);
}

// --- sanity: the route strings above actually classify as this script assumes ---
if (classifyBudgetedPath('POST', TIP_ORDER_ROUTE) !== 'tip_order') {
  fail(`classifyBudgetedPath no longer classifies POST ${TIP_ORDER_ROUTE} as tip_order — this script's synthetic traffic would silently stop exercising the tip-order histogram`);
}
if (classifyBudgetedPath('GET', READ_ROUTE) !== 'read') {
  fail(`classifyBudgetedPath no longer classifies GET ${READ_ROUTE} as read — this script's synthetic traffic would silently stop exercising the read histogram`);
}

// --- parse the real Prometheus text exposition (not the internal object) ---
function parseExposition(text) {
  const buckets = new Map(); // metricName -> Map(le -> cumulativeCount)
  const gauges = new Map(); // gaugeName -> value
  for (const line of text.split('\n')) {
    const bucketMatch = line.match(/^(\w+)_bucket\{le="([^"]+)"\}\s+(\d+)$/);
    if (bucketMatch) {
      const [, name, le, count] = bucketMatch;
      if (!buckets.has(name)) buckets.set(name, new Map());
      buckets.get(name).set(le, Number(count));
      continue;
    }
    const gaugeMatch = line.match(/^(\S+)\s+([0-9.]+)$/);
    if (gaugeMatch && line.includes('_estimate ')) {
      gauges.set(gaugeMatch[1], Number(gaugeMatch[2]));
    }
  }
  return { buckets, gauges };
}

function assertBoundaryBucketExists(parsed, metricName, le, label) {
  const metricBuckets = parsed.buckets.get(metricName);
  if (!metricBuckets) {
    fail(`${label}: no ${metricName}_bucket lines found in the exposition at all`);
    return false;
  }
  if (!metricBuckets.has(le)) {
    fail(`${label}: ${metricName}_bucket{le="${le}"} is missing from the exposition — §19.4's boundary is not on the wire`);
    return false;
  }
  ok(`${label}: ${metricName}_bucket{le="${le}"} present on the wire (cumulative=${metricBuckets.get(le)})`);
  return true;
}

// Boundary-bucket pass/fail evaluator — the thing PART B proves can fail.
// "Pass" here means: of everything observed, the boundary bucket's own
// cumulative count is the ENTIRE population (nothing exceeded the exact
// §19.4 number). This is deliberately the strictest reading — any
// observation landing past the boundary is a breach — because §19.4
// states the boundary as a hard "< 200ms" / "< 500ms" p99, and this
// evaluator is exercised here only against synthetic, non-production data.
function evaluateBoundary(parsed, metricName, le) {
  const metricBuckets = parsed.buckets.get(metricName);
  if (!metricBuckets || !metricBuckets.has(le)) return { evaluated: false };
  const atOrUnderBoundary = metricBuckets.get(le);
  const total = Math.max(...metricBuckets.values());
  return { evaluated: true, pass: atOrUnderBoundary >= total, atOrUnderBoundary, total };
}

// --- PART A: structural — realistic, mixed-but-all-in-budget synthetic traffic ---
{
  const metrics = createApiMetrics();
  for (const durationMs of [12, 45, 80, 110, 150, 180, 199]) {
    metrics.observe('GET', READ_ROUTE, 200, durationMs);
  }
  for (const durationMs of [60, 150, 300, 420, 499]) {
    metrics.observe('POST', TIP_ORDER_ROUTE, 200, durationMs);
  }
  const text = metrics.renderPrometheus();
  const parsed = parseExposition(text);
  assertBoundaryBucketExists(parsed, 'bsa_api_read_duration_ms', READ_LE, 'PART A (read)');
  assertBoundaryBucketExists(parsed, 'bsa_api_tip_order_duration_ms', TIP_ORDER_LE, 'PART A (tip-order)');

  const readEval = evaluateBoundary(parsed, 'bsa_api_read_duration_ms', READ_LE);
  const tipEval = evaluateBoundary(parsed, 'bsa_api_tip_order_duration_ms', TIP_ORDER_LE);
  if (!readEval.evaluated || !readEval.pass) fail(`PART A (read): in-budget synthetic traffic unexpectedly evaluated as a breach (${JSON.stringify(readEval)})`);
  else ok(`PART A (read): in-budget synthetic traffic evaluates PASS as expected (${readEval.atOrUnderBoundary}/${readEval.total} at or under ${READ_LE}ms)`);
  if (!tipEval.evaluated || !tipEval.pass) fail(`PART A (tip-order): in-budget synthetic traffic unexpectedly evaluated as a breach (${JSON.stringify(tipEval)})`);
  else ok(`PART A (tip-order): in-budget synthetic traffic evaluates PASS as expected (${tipEval.atOrUnderBoundary}/${tipEval.total} at or under ${TIP_ORDER_LE}ms)`);
}

// --- PART B: self-test — a synthetic breach MUST evaluate FAIL ---
{
  const metrics = createApiMetrics();
  // Every read observation lands past the 200ms boundary; every tip-order
  // observation lands past the 500ms boundary. If the evaluator above ever
  // reports PASS for this, the gate itself is broken and cannot fail on a
  // real regression either.
  for (const durationMs of [250, 400, 900, 1500]) {
    metrics.observe('GET', READ_ROUTE, 200, durationMs);
  }
  for (const durationMs of [600, 800, 1200, 3000]) {
    metrics.observe('POST', TIP_ORDER_ROUTE, 200, durationMs);
  }
  const text = metrics.renderPrometheus();
  const parsed = parseExposition(text);
  const readEval = evaluateBoundary(parsed, 'bsa_api_read_duration_ms', READ_LE);
  const tipEval = evaluateBoundary(parsed, 'bsa_api_tip_order_duration_ms', TIP_ORDER_LE);
  if (!readEval.evaluated || readEval.pass) fail(`PART B self-test: a deliberate read-path breach (all observations > ${READ_LE}ms) evaluated as PASS — the gate cannot fail, so it is not a gate (${JSON.stringify(readEval)})`);
  else ok(`PART B self-test: deliberate read-path breach correctly evaluates FAIL (${readEval.atOrUnderBoundary}/${readEval.total} at or under ${READ_LE}ms)`);
  if (!tipEval.evaluated || tipEval.pass) fail(`PART B self-test: a deliberate tip-order breach (all observations > ${TIP_ORDER_LE}ms) evaluated as PASS — the gate cannot fail, so it is not a gate (${JSON.stringify(tipEval)})`);
  else ok(`PART B self-test: deliberate tip-order breach correctly evaluates FAIL (${tipEval.atOrUnderBoundary}/${tipEval.total} at or under ${TIP_ORDER_LE}ms)`);
}

// --- PART C: absolute thresholds, wired but inert ---
{
  const readBudget = process.env.CI_PRF01_API_READ_P99_BUDGET_MS;
  const tipBudget = process.env.CI_PRF01_TIP_ORDER_P99_BUDGET_MS;
  console.log('--- PART C: PRF-01 absolute thresholds (wired but inert) ---');
  console.log(`§19.4 API read p99 budget = ${READ_LE}ms; CI_PRF01_API_READ_P99_BUDGET_MS = ${readBudget ?? '(unset)'}`);
  console.log(`§19.4 tip-order p99 budget = ${TIP_ORDER_LE}ms; CI_PRF01_TIP_ORDER_P99_BUDGET_MS = ${tipBudget ?? '(unset)'}`);
  if (readBudget === undefined && tipBudget === undefined) {
    console.log('Both unset (the default, and the only value this workflow ever sets). This is expected, not a failure: there is no real-traffic feed in this CI job to check a threshold against. ENV-08 (staging environment) and RT-07 (browser/OBS/device evidence) are Blocked, and both are required before either value means anything. This job never fails on PART C.');
  } else {
    console.log('One or both is set. This workflow itself never sets them; if a future environment sets them, this codepath still has no live-traffic feed in a CI job — the value is echoed for visibility only and MUST NOT be read as a passed or failed production budget check. It never affects this script\'s exit code.');
  }
}

console.log('---');
console.log('honesty: this script proves the Prometheus exposition wire format and the boundary-bucket pass/fail MECHANISM. It is not evidence that any §19.4 budget is met in production. RT-07: Blocked. externalEvidence: not-claimed.');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nPRF-01/RT-06 budget-gate mechanism: all checks passed.');
