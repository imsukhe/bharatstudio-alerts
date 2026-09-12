type CounterKey = `${string}|${string}|${number}`;

// L09 (MASTER-PLAN Part 11.2) names seven reliability metrics this system's
// financial correctness depends on. They split into two detection shapes:
//
//   request-time     — observed as a side effect of one request/attempt.
//                       (reconnectReplay, ttsFailure below.) The counter
//                       surface and its overlay/TTS call sites are composed
//                       by buildApp; isolated callers may still omit metrics
//                       without changing the business outcome.
//   reconciliation-time — absence-of-a-thing, or a lag that only exists
//                       once you compare two durable records. Cannot be
//                       observed from a single request. Computed by
//                       `runReliabilityReconciliation` (reconciliation.ts)
//                       against read-only SQL and published as gauges via
//                       `setReconciliationSnapshot`.
export type ReconciliationSnapshot = {
  capturedPaymentsWithoutLiveEvent: number;
  duplicateLiveEvents: number;
  lostDeliveries: number;
  webhookLagMsMax: number;
  webhookLagMsAvg: number;
  refundFailures: number;
  observedAt: string;
};

export type ApiMetrics = {
  observe(method: string, route: string, statusCode: number, durationMs: number): void;
  // Request-time reliability counters. Bounded, low-cardinality outcome
  // labels only — never a payment/order/event/donor identifier.
  recordReconnectReplay(outcome: 'success' | 'failure'): void;
  recordTtsFailure(reason: 'provider_error' | 'timeout' | 'quota_exhausted' | 'other'): void;
  // Reconciliation-time gauges, refreshed wholesale by the periodic check.
  setReconciliationSnapshot(snapshot: ReconciliationSnapshot): void;
  renderPrometheus(): string;
};

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

export function createApiMetrics(): ApiMetrics {
  const counters = new Map<CounterKey, { count: number; durationMs: number }>();
  const reconnectReplay = { success: 0, failure: 0 };
  const ttsFailures = { provider_error: 0, timeout: 0, quota_exhausted: 0, other: 0 };
  let reconciliation: ReconciliationSnapshot | undefined;

  return {
    observe(method, route, statusCode, durationMs) {
      const key: CounterKey = `${method}|${route}|${statusCode}`;
      const current = counters.get(key) ?? { count: 0, durationMs: 0 };
      current.count += 1;
      current.durationMs += Math.max(0, durationMs);
      counters.set(key, current);
    },
    recordReconnectReplay(outcome) {
      reconnectReplay[outcome] += 1;
    },
    recordTtsFailure(reason) {
      ttsFailures[reason] += 1;
    },
    setReconciliationSnapshot(snapshot) {
      reconciliation = snapshot;
    },
    renderPrometheus() {
      const lines = [
        '# HELP bsa_api_requests_total API requests completed by normalized route.',
        '# TYPE bsa_api_requests_total counter',
        '# HELP bsa_api_request_duration_ms_sum API request duration sum in milliseconds.',
        '# TYPE bsa_api_request_duration_ms_sum counter',
      ];
      for (const [key, value] of [...counters.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const [method, route, statusCode] = key.split('|');
        const labels = `method="${escapeLabel(method ?? '')}",route="${escapeLabel(route ?? 'unknown')}",status_code="${escapeLabel(statusCode ?? '0')}"`;
        lines.push(`bsa_api_requests_total{${labels}} ${value.count}`);
        lines.push(`bsa_api_request_duration_ms_sum{${labels}} ${value.durationMs.toFixed(3)}`);
      }

      lines.push('# HELP bsa_overlay_reconnect_replay_total Overlay SSE reconnect+cursor-replay attempts by outcome.');
      lines.push('# TYPE bsa_overlay_reconnect_replay_total counter');
      lines.push(`bsa_overlay_reconnect_replay_total{outcome="success"} ${reconnectReplay.success}`);
      lines.push(`bsa_overlay_reconnect_replay_total{outcome="failure"} ${reconnectReplay.failure}`);

      lines.push('# HELP bsa_tts_failures_total TTS synthesis failures by reason.');
      lines.push('# TYPE bsa_tts_failures_total counter');
      for (const reason of Object.keys(ttsFailures) as (keyof typeof ttsFailures)[]) {
        lines.push(`bsa_tts_failures_total{reason="${reason}"} ${ttsFailures[reason]}`);
      }

      lines.push('# HELP bsa_reconciliation_captured_payments_without_live_event Captured payments with no corresponding LiveEvent (money in, nothing on stream). Reconciliation-time.');
      lines.push('# TYPE bsa_reconciliation_captured_payments_without_live_event gauge');
      lines.push(`bsa_reconciliation_captured_payments_without_live_event ${reconciliation?.capturedPaymentsWithoutLiveEvent ?? 0}`);

      lines.push('# HELP bsa_reconciliation_duplicate_live_events Payments with more than one LiveEvent. Unacceptable per any occurrence. Reconciliation-time.');
      lines.push('# TYPE bsa_reconciliation_duplicate_live_events gauge');
      lines.push(`bsa_reconciliation_duplicate_live_events ${reconciliation?.duplicateLiveEvents ?? 0}`);

      lines.push('# HELP bsa_reconciliation_lost_deliveries Outbox deliveries stuck past the staleness threshold, never displayed/acknowledged/quarantined. Reconciliation-time.');
      lines.push('# TYPE bsa_reconciliation_lost_deliveries gauge');
      lines.push(`bsa_reconciliation_lost_deliveries ${reconciliation?.lostDeliveries ?? 0}`);

      lines.push('# HELP bsa_reconciliation_webhook_lag_ms_max Max observed lag between webhook receipt and local payment persistence. Reconciliation-time.');
      lines.push('# TYPE bsa_reconciliation_webhook_lag_ms_max gauge');
      lines.push(`bsa_reconciliation_webhook_lag_ms_max ${reconciliation?.webhookLagMsMax ?? 0}`);

      lines.push('# HELP bsa_reconciliation_webhook_lag_ms_avg Average observed webhook-to-persistence lag. Reconciliation-time.');
      lines.push('# TYPE bsa_reconciliation_webhook_lag_ms_avg gauge');
      lines.push(`bsa_reconciliation_webhook_lag_ms_avg ${reconciliation?.webhookLagMsAvg ?? 0}`);

      lines.push('# HELP bsa_reconciliation_refund_failures Refunds in a failed state. Reconciliation-time.');
      lines.push('# TYPE bsa_reconciliation_refund_failures gauge');
      lines.push(`bsa_reconciliation_refund_failures ${reconciliation?.refundFailures ?? 0}`);

      lines.push('# HELP bsa_reconciliation_last_run_timestamp_seconds Unix timestamp of the last reconciliation run; absence/staleness is itself a signal.');
      lines.push('# TYPE bsa_reconciliation_last_run_timestamp_seconds gauge');
      lines.push(`bsa_reconciliation_last_run_timestamp_seconds ${reconciliation ? Math.floor(new Date(reconciliation.observedAt).getTime() / 1000) : 0}`);

      return `${lines.join('\n')}\n`;
    },
  };
}
