#!/usr/bin/env node
// "A gate never seen to fail is not a gate." Proves relative-regression-
// compare.mjs's zero-tolerance comparator can and does fail, with fabricated
// data — no Docker, no Postgres, no load harness needed. Runs unconditionally
// as its own fast CI step alongside the real (Docker-backed) regression run.

import { compare, validateBaseline } from './relative-regression-compare.mjs';

let failures = 0;
function check(condition, message) {
  if (!condition) { failures += 1; console.error(`FAIL: ${message}`); }
  else console.log(`OK: ${message}`);
}

// 1. A baseline missing its required "reason" is rejected outright —
//    baseline-reason discipline (owner decision 2026-09-16).
{
  const errors = validateBaseline({ worstOfThree: { latencyMsP50: 10, latencyMsP95: 20, latencyMsP99: 30 } });
  check(errors.length > 0, 'a baseline with no "reason" field is rejected by validateBaseline');
}

// 2. A clean pass: worst-of-three strictly under baseline on every metric.
{
  const reports = [
    { latencyMsP50: 5, latencyMsP95: 10, latencyMsP99: 15 },
    { latencyMsP50: 6, latencyMsP95: 11, latencyMsP99: 16 },
    { latencyMsP50: 4, latencyMsP95: 9, latencyMsP99: 14 },
  ];
  const baseline = { reason: 'self-test fixture', establishedAt: '2026-09-16', worstOfThree: { latencyMsP50: 100, latencyMsP95: 200, latencyMsP99: 300 } };
  const result = compare(reports, baseline);
  check(result.ok === true && result.regressions.length === 0, 'comfortably-under-baseline synthetic reports evaluate PASS');
}

// 3. Synthetic breach: one run's p99 exceeds the baseline. Zero tolerance
//    means even a 1ms overage must fail — this is the case that proves the
//    gate can fail.
{
  const reports = [
    { latencyMsP50: 5, latencyMsP95: 10, latencyMsP99: 15 },
    { latencyMsP50: 6, latencyMsP95: 11, latencyMsP99: 301 }, // deliberate breach
    { latencyMsP50: 4, latencyMsP95: 9, latencyMsP99: 14 },
  ];
  const baseline = { reason: 'self-test fixture', establishedAt: '2026-09-16', worstOfThree: { latencyMsP50: 100, latencyMsP95: 200, latencyMsP99: 300 } };
  const result = compare(reports, baseline);
  check(result.ok === false, 'a deliberate 1ms worst-of-three p99 breach evaluates FAIL — the gate can fail');
  check(result.regressions.some((r) => r.metric === 'latencyMsP99' && r.deltaMs === 1), 'the reported regression names the correct metric and exact delta (1ms)');
  check(result.regressions.length === 1, 'only the breached metric is reported as a regression, not the two that stayed under baseline');
}

// 4. Zero tolerance really is zero: exactly-equal-to-baseline is NOT a
//    regression (the rule is "strictly greater than", not "at or above").
{
  const reports = [
    { latencyMsP50: 100, latencyMsP95: 200, latencyMsP99: 300 },
    { latencyMsP50: 100, latencyMsP95: 200, latencyMsP99: 300 },
    { latencyMsP50: 100, latencyMsP95: 200, latencyMsP99: 300 },
  ];
  const baseline = { reason: 'self-test fixture', establishedAt: '2026-09-16', worstOfThree: { latencyMsP50: 100, latencyMsP95: 200, latencyMsP99: 300 } };
  const result = compare(reports, baseline);
  check(result.ok === true, 'worst-of-three exactly equal to baseline evaluates PASS (strictly-greater-than rule, not at-or-above)');
}

console.log('---');
if (failures > 0) {
  console.error(`\n${failures} self-test check(s) failed — the relative-regression comparator's own pass/fail logic is broken.`);
  process.exit(1);
}
console.log('\nrelative-regression comparator self-test: all checks passed (comparator proven able to fail).');
