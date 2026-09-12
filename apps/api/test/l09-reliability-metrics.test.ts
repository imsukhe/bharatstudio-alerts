import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiMetrics } from '../src/observability/metrics.js';

test('reconnect replay counter increments only the outcome given, not the other', () => {
  const metrics = createApiMetrics();
  metrics.recordReconnectReplay('success');
  metrics.recordReconnectReplay('success');
  metrics.recordReconnectReplay('failure');
  const output = metrics.renderPrometheus();
  assert.match(output, /bsa_overlay_reconnect_replay_total\{outcome="success"\} 2/);
  assert.match(output, /bsa_overlay_reconnect_replay_total\{outcome="failure"\} 1/);
});

test('reconnect replay counter stays zero for an outcome that never fired', () => {
  const metrics = createApiMetrics();
  metrics.recordReconnectReplay('success');
  const output = metrics.renderPrometheus();
  assert.match(output, /bsa_overlay_reconnect_replay_total\{outcome="success"\} 1/);
  assert.match(output, /bsa_overlay_reconnect_replay_total\{outcome="failure"\} 0/);
});

test('TTS failure counter increments only the reason given', () => {
  const metrics = createApiMetrics();
  metrics.recordTtsFailure('provider_error');
  metrics.recordTtsFailure('provider_error');
  metrics.recordTtsFailure('timeout');
  const output = metrics.renderPrometheus();
  assert.match(output, /bsa_tts_failures_total\{reason="provider_error"\} 2/);
  assert.match(output, /bsa_tts_failures_total\{reason="timeout"\} 1/);
  assert.match(output, /bsa_tts_failures_total\{reason="quota_exhausted"\} 0/);
  assert.match(output, /bsa_tts_failures_total\{reason="other"\} 0/);
});

test('before any reconciliation run, gauges report zero and no last-run timestamp', () => {
  const metrics = createApiMetrics();
  const output = metrics.renderPrometheus();
  assert.match(output, /bsa_reconciliation_captured_payments_without_live_event 0/);
  assert.match(output, /bsa_reconciliation_duplicate_live_events 0/);
  assert.match(output, /bsa_reconciliation_lost_deliveries 0/);
  assert.match(output, /bsa_reconciliation_last_run_timestamp_seconds 0/);
});

test('setReconciliationSnapshot replaces the gauge values wholesale, and only for what was set', () => {
  const metrics = createApiMetrics();
  metrics.setReconciliationSnapshot({
    capturedPaymentsWithoutLiveEvent: 2,
    duplicateLiveEvents: 1,
    lostDeliveries: 5,
    webhookLagMsMax: 4200,
    webhookLagMsAvg: 900,
    refundFailures: 3,
    observedAt: '2026-09-07T00:00:00.000Z',
  });
  const output = metrics.renderPrometheus();
  assert.match(output, /bsa_reconciliation_captured_payments_without_live_event 2/);
  assert.match(output, /bsa_reconciliation_duplicate_live_events 1/);
  assert.match(output, /bsa_reconciliation_lost_deliveries 5/);
  assert.match(output, /bsa_reconciliation_webhook_lag_ms_max 4200/);
  assert.match(output, /bsa_reconciliation_webhook_lag_ms_avg 900/);
  assert.match(output, /bsa_reconciliation_refund_failures 3/);
  const expectedEpochSeconds = Math.floor(new Date('2026-09-07T00:00:00.000Z').getTime() / 1000);
  assert.match(output, new RegExp(`bsa_reconciliation_last_run_timestamp_seconds ${expectedEpochSeconds}`));
});

test('renderPrometheus never emits a value that looks like a UUID/payment identifier, only route labels and counts', () => {
  const metrics = createApiMetrics();
  metrics.observe('GET', '/internal/v1/tips/orders', 200, 12.5);
  metrics.setReconciliationSnapshot({
    capturedPaymentsWithoutLiveEvent: 1,
    duplicateLiveEvents: 0,
    lostDeliveries: 0,
    webhookLagMsMax: 100,
    webhookLagMsAvg: 50,
    refundFailures: 0,
    observedAt: new Date().toISOString(),
  });
  const output = metrics.renderPrometheus();
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  assert.equal(uuidPattern.test(output), false, 'metrics output must never contain a UUID-shaped identifier');
});
