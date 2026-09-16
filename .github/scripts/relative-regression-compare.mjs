#!/usr/bin/env node
// Comparator half of the PRF-01 relative-regression gate — see
// relative-regression-check.sh for the full scope/honesty header (owner
// decision 2026-09-16, recorded in
// bharatstudio-requirements/reviews/2026-09-16-ops-ci-01-alerts-continuous-integration.md).
//
// Pure logic, importable and independently testable: worst-of-three
// against a checked-in baseline, zero tolerance, baseline-reason
// discipline enforced. relative-regression-selftest.mjs imports `compare`
// directly to prove this can fail on a synthetic breach, with no Docker
// or Postgres needed for that proof.

import { readFileSync } from 'node:fs';

export const METRICS = ['latencyMsP50', 'latencyMsP95', 'latencyMsP99'];

export function worstOfThree(reports) {
  const worst = {};
  for (const metric of METRICS) {
    worst[metric] = Math.max(...reports.map((r) => Number(r[metric])));
  }
  return worst;
}

export function validateBaseline(baseline) {
  const errors = [];
  if (typeof baseline !== 'object' || baseline === null) errors.push('baseline is not an object');
  else {
    if (!baseline.reason || typeof baseline.reason !== 'string' || baseline.reason.trim().length === 0) {
      errors.push('baseline is missing a non-empty "reason" field — a baseline change must never be an incidental diff (owner decision 2026-09-16)');
    }
    if (!baseline.worstOfThree || typeof baseline.worstOfThree !== 'object') {
      errors.push('baseline is missing "worstOfThree"');
    } else {
      for (const metric of METRICS) {
        if (typeof baseline.worstOfThree[metric] !== 'number') errors.push(`baseline.worstOfThree.${metric} is missing or not a number`);
      }
    }
  }
  return errors;
}

// Zero tolerance: any worst-of-three metric strictly greater than the
// baseline's value is a regression. Returns { ok, regressions, worst }.
export function compare(reports, baseline) {
  const baselineErrors = validateBaseline(baseline);
  if (baselineErrors.length > 0) return { ok: false, baselineErrors, worst: null, regressions: [] };
  const worst = worstOfThree(reports);
  const regressions = [];
  for (const metric of METRICS) {
    const observed = worst[metric];
    const allowed = baseline.worstOfThree[metric];
    if (observed > allowed) {
      regressions.push({ metric, observed, allowed, deltaMs: Number((observed - allowed).toFixed(3)) });
    }
  }
  return { ok: regressions.length === 0, baselineErrors: [], worst, regressions };
}

function printResult(result, baseline) {
  console.log('--- PRF-01 relative-regression gate: local SQL-harness worst-of-three vs. checked-in baseline ---');
  if (result.baselineErrors.length > 0) {
    for (const err of result.baselineErrors) console.error(`FAIL baseline: ${err}`);
    return;
  }
  console.log(`baseline reason: ${baseline.reason}`);
  console.log(`baseline established: ${baseline.establishedAt ?? '(not recorded)'}`);
  for (const metric of METRICS) {
    const observed = result.worst[metric];
    const allowed = baseline.worstOfThree[metric];
    const status = observed > allowed ? 'REGRESSION' : 'ok';
    console.log(`  ${metric}: worst-of-three=${observed}ms  baseline=${allowed}ms  [${status}]`);
  }
  if (!result.ok) {
    console.error('');
    console.error('REGRESSION DETECTED. No tolerance band exists by owner decision (2026-09-16) — this can also be ordinary CI-runner variance, not a real regression.');
    console.error('Before treating this as a real regression: RE-RUN this job first. If it reproduces, treat it as a regression — do not widen the baseline to make a flake go away. A baseline change requires a written reason in .github/ci/perf-baseline.local-load.json itself.');
  }
  console.log('honesty: this is a local-loopback SQL-harness trend signal (20 synthetic tips, concurrency 5, one disposable Postgres container). It is not evidence any §19.4 budget is met in production. RT-07: Blocked. externalEvidence: not-claimed.');
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return new URL(`file://${entry}`).pathname === new URL(import.meta.url).pathname;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const [runPath1, runPath2, runPath3, baselinePath] = process.argv.slice(2);
  if (!runPath1 || !runPath2 || !runPath3 || !baselinePath) {
    console.error('usage: relative-regression-compare.mjs <run1.json> <run2.json> <run3.json> <baseline.json>');
    process.exit(2);
  }
  const reports = [runPath1, runPath2, runPath3].map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const result = compare(reports, baseline);
  printResult(result, baseline);
  process.exit(result.ok ? 0 : 1);
}
