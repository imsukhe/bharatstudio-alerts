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
//
// RT-06 (§19.0, §19.4): totals and duration sums (below) yield averages, and
// an average cannot falsify a p99 budget. Every path §19.4 gives a number to
// that this process can observe — API reads (p99 < 200ms) and the tip-order
// path (p99 < 500ms) — gets a real bucketed histogram in addition to (never
// instead of — RT-06.7 keeps the existing counters' shape unchanged) the
// counters below. See `classifyBudgetedPath`, `READ_DURATION_BUCKETS_MS` and
// `TIP_ORDER_DURATION_BUCKETS_MS` for exactly which requests and which
// bucket boundaries, and why — full derivation in
// bharatstudio-requirements/reviews/2026-09-16-rt-06-budget-histograms.md.
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
  // RT-02 §3.4 counters. Outcome labels only — a channel id, overlay id,
  // payment id or donor identifier must never appear here.
  recordOverlayNotification(outcome: 'routed' | 'unroutable'): void;
  recordOverlayAdmissionRejection(): void;
  recordOverlayReplay(outcome: 'shared' | 'leader'): void;
  // RT-10 §3.4 / RT-11 §3.3 counters. Outcome labels only, same bounded
  // shape as every counter above — never a route, channel, overlay or
  // payment identifier.
  recordDerivedReadAdmission(outcome: 'admitted' | 'shed'): void;
  recordDerivedReadTimeout(): void;
  // Reconciliation-time gauges, refreshed wholesale by the periodic check.
  setReconciliationSnapshot(snapshot: ReconciliationSnapshot): void;
  renderPrometheus(): string;
};

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

// --- RT-06: a minimal, dependency-free bucketed histogram -----------------
//
// Deliberately not the cumulative Prometheus wire representation internally
// — `counts[i]` is the number of observations whose value fell in
// `(buckets[i-1], buckets[i]]` (exclusive/inclusive, first-fit), not the
// cumulative count. That makes two structurally important things simple and
// directly testable:
//
//   1. RT-06.2 (arithmetic correctness) — a known set of observations
//      produces an exact, checkable `counts` array with no cumulative-sum
//      arithmetic in the way.
//   2. RT-06.4 (cross-instance additive aggregation) — two per-slot `counts`
//      arrays from two independent processes sum elementwise
//      (`mergeHistograms`) into the arithmetically correct combined
//      histogram. This is the local, provable half of "aggregated across
//      instances": Prometheus's own cross-instance story is `sum by (le)
//      (rate(x_bucket[...]))` over the *cumulative* wire format, which is
//      additive for exactly this reason (counters are additive; the
//      cumulative transform is applied identically to the sum). Proving
//      that the wire format itself round-trips a real Prometheus/Cloud
//      Monitoring aggregation requires a deployed scrape target this
//      process cannot stand up — see the review record's §3 for exactly
//      what is proven here versus what is not.
//
// The cumulative `_bucket{le=...}` line Prometheus expects is computed only
// at render time (`renderHistogram`), from a running prefix sum over
// `counts`.
export type Histogram = {
  readonly buckets: readonly number[]; // ascending boundary values in ms; +Inf is implicit and not stored
  readonly counts: number[]; // counts[i] = observations in (buckets[i-1], buckets[i]]; same length as buckets
  sum: number;
  count: number;
};

export function createHistogram(buckets: readonly number[]): Histogram {
  return { buckets, counts: new Array(buckets.length).fill(0), sum: 0, count: 0 };
}

// Never throws. A metrics failure must never delay, drop or alter a
// request (RT-06.6) — this function only ever mutates its own in-memory
// counters, has no I/O, and defensively floors/coerces a pathological
// duration (NaN, negative, +Infinity) rather than propagating an error.
export function observeHistogram(histogram: Histogram, valueMs: number): void {
  const value = Number.isFinite(valueMs) && valueMs > 0 ? valueMs : 0;
  histogram.count += 1;
  histogram.sum += value;
  for (let index = 0; index < histogram.buckets.length; index += 1) {
    if (value <= histogram.buckets[index]!) {
      histogram.counts[index]! += 1;
      return;
    }
  }
  // Exceeds every finite boundary: counted in `count`/`sum` (and therefore
  // in the rendered `+Inf` bucket) but no finite bucket slot.
}

// RT-06.4: the additive property cross-instance aggregation depends on.
// Exported (not just used internally) so the property is directly testable
// against two independently observed histograms sharing the same buckets.
export function mergeHistograms(a: Histogram, b: Histogram): Histogram {
  if (a.buckets.length !== b.buckets.length || a.buckets.some((boundary, index) => boundary !== b.buckets[index])) {
    throw new Error('cannot merge histograms with different bucket boundaries');
  }
  return {
    buckets: a.buckets,
    counts: a.counts.map((value, index) => value + (b.counts[index] ?? 0)),
    sum: a.sum + b.sum,
    count: a.count + b.count,
  };
}

function renderHistogram(name: string, help: string, histogram: Histogram): string[] {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
  let cumulative = 0;
  for (let index = 0; index < histogram.buckets.length; index += 1) {
    cumulative += histogram.counts[index]!;
    lines.push(`${name}_bucket{le="${formatBoundary(histogram.buckets[index]!)}"} ${cumulative}`);
  }
  lines.push(`${name}_bucket{le="+Inf"} ${histogram.count}`);
  lines.push(`${name}_sum ${histogram.sum.toFixed(3)}`);
  lines.push(`${name}_count ${histogram.count}`);
  return lines;
}

function formatBoundary(boundaryMs: number): string {
  return Number.isInteger(boundaryMs) ? String(boundaryMs) : boundaryMs.toFixed(3);
}

// RT-06.3: a real p95/p99 read-out, computed from the buckets — never an
// average. This is the standard linear-interpolation-within-the-containing-
// bucket estimate (the same method Prometheus's own `histogram_quantile`
// uses): it assumes observations are uniformly distributed across the width
// of whichever bucket the target rank falls in. That is an estimate, not an
// exact value — its error is bounded by the width of that one bucket, which
// is exactly why every §19.4 budget number is placed as an exact bucket
// boundary (RT-06 scope rule): the boundary bucket's own upper edge is the
// number CI checks against, so the estimate is never vaguer than "did this
// bucket's cumulative count clear the target rank," which is an exact,
// non-interpolated fact. Returns null when the histogram has no
// observations (nothing to estimate). If the target rank falls in the
// +Inf bucket (i.e. more than (1-quantile) of observations exceed every
// finite boundary), there is no finite upper bound to interpolate against;
// the last finite boundary is returned as a lower-bound-only indicator, and
// callers must not present it as the estimate's usual bucket-width bound.
export function estimateQuantile(histogram: Histogram, quantile: number): number | null {
  if (histogram.count === 0) return null;
  const target = quantile * histogram.count;
  let cumulative = 0;
  let lowerBoundary = 0;
  for (let index = 0; index < histogram.buckets.length; index += 1) {
    const bucketCount = histogram.counts[index]!;
    const upperBoundary = histogram.buckets[index]!;
    if (cumulative + bucketCount >= target && bucketCount > 0) {
      const fraction = (target - cumulative) / bucketCount;
      return lowerBoundary + fraction * (upperBoundary - lowerBoundary);
    }
    cumulative += bucketCount;
    lowerBoundary = upperBoundary;
  }
  // Every finite bucket accounted for and the target rank still was not
  // reached: the target falls among the +Inf observations. Not bounded
  // above — see the doc comment.
  return histogram.buckets.length > 0 ? histogram.buckets[histogram.buckets.length - 1]! : null;
}

// RT-06 §3.1: buckets are derived from §19.4's budget table, never invented.
// "API p99 | < 200ms for reads, < 500ms for the tip-order path."
//
// READ_DURATION_BUCKETS_MS: 200 is the exact budget boundary (falsifiable
// directly: `bsa_api_read_duration_ms_bucket{le="200"}` divided by
// `..._count` is the fraction of reads at or under budget). The remaining
// boundaries are measurement resolution around it, not separate budgets:
// 10/25/50/75/100/150 give visibility into how far *under* budget normal
// traffic runs (a flat p50 at 180ms would be invisible with only a single
// 200 boundary); 300/500/1000 size how far *over* budget a regression runs,
// which matters for triage even though only the 200 boundary is a pass/fail
// line.
export const READ_DURATION_BUCKETS_MS = [10, 25, 50, 75, 100, 150, 200, 300, 500, 1000] as const;

// TIP_ORDER_DURATION_BUCKETS_MS: 500 is the exact budget boundary from the
// same table row. 50/100/200/300/400 resolve the common case below budget
// (this path calls out to the Go checkout service and, transitively,
// Razorpay's order-create API, so resolution below 500 matters for
// diagnosing where time goes); 750/1000/2000 size overshoot the same way as
// the read histogram above.
export const TIP_ORDER_DURATION_BUCKETS_MS = [50, 100, 200, 300, 400, 500, 750, 1000, 2000] as const;

const TIP_ORDER_ROUTE = '/v1/public/channels/:handle/tips/orders';

// Which §19.4-budgeted class (if any) a request belongs to. Only two
// classes exist because only two rows in §19.4's table name a duration
// number this process can observe server-side (§19.0 RT-06 scope). Every
// other route keeps only the existing bsa_api_requests_total /
// bsa_api_request_duration_ms_sum counters — unclassified is not
// "unmeasured," it is "not a path §19.4 put a number on."
export function classifyBudgetedPath(method: string, route: string): 'read' | 'tip_order' | null {
  if (method === 'POST' && route === TIP_ORDER_ROUTE) return 'tip_order';
  if (method === 'GET' && route !== 'unknown' && !route.startsWith('/internal/')) return 'read';
  return null;
}

export function createApiMetrics(): ApiMetrics {
  const counters = new Map<CounterKey, { count: number; durationMs: number }>();
  const reconnectReplay = { success: 0, failure: 0 };
  const ttsFailures = { provider_error: 0, timeout: 0, quota_exhausted: 0, other: 0 };
  const overlayNotifications = { routed: 0, unroutable: 0 };
  const overlayReplay = { shared: 0, leader: 0 };
  let overlayAdmissionRejections = 0;
  const derivedReadAdmission = { admitted: 0, shed: 0 };
  let derivedReadTimeouts = 0;
  let reconciliation: ReconciliationSnapshot | undefined;
  const readDuration = createHistogram(READ_DURATION_BUCKETS_MS);
  const tipOrderDuration = createHistogram(TIP_ORDER_DURATION_BUCKETS_MS);

  return {
    observe(method, route, statusCode, durationMs) {
      const key: CounterKey = `${method}|${route}|${statusCode}`;
      const current = counters.get(key) ?? { count: 0, durationMs: 0 };
      current.count += 1;
      current.durationMs += Math.max(0, durationMs);
      counters.set(key, current);

      // RT-06: supplement, never replace, the counters above. Wrapped
      // defensively — this must never be the reason a request-handling
      // hook throws (RT-06.6).
      try {
        const budgetClass = classifyBudgetedPath(method, route);
        if (budgetClass === 'read') observeHistogram(readDuration, durationMs);
        else if (budgetClass === 'tip_order') observeHistogram(tipOrderDuration, durationMs);
      } catch {
        // Never let a measurement defect affect the response already sent.
      }
    },
    recordReconnectReplay(outcome) {
      reconnectReplay[outcome] += 1;
    },
    recordTtsFailure(reason) {
      ttsFailures[reason] += 1;
    },
    recordOverlayNotification(outcome) {
      overlayNotifications[outcome] += 1;
    },
    recordOverlayAdmissionRejection() {
      overlayAdmissionRejections += 1;
    },
    recordOverlayReplay(outcome) {
      overlayReplay[outcome] += 1;
    },
    recordDerivedReadAdmission(outcome) {
      derivedReadAdmission[outcome] += 1;
    },
    recordDerivedReadTimeout() {
      derivedReadTimeouts += 1;
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

      lines.push('# HELP bsa_overlay_notifications_total Overlay wake-up notifications received by the direct listener, by routing outcome (RT-02).');
      lines.push('# TYPE bsa_overlay_notifications_total counter');
      lines.push(`bsa_overlay_notifications_total{outcome="routed"} ${overlayNotifications.routed}`);
      lines.push(`bsa_overlay_notifications_total{outcome="unroutable"} ${overlayNotifications.unroutable}`);

      lines.push('# HELP bsa_overlay_admission_rejections_total Overlay SSE connections rejected by a configured per-instance or per-channel subscriber ceiling (RT-02).');
      lines.push('# TYPE bsa_overlay_admission_rejections_total counter');
      lines.push(`bsa_overlay_admission_rejections_total ${overlayAdmissionRejections}`);

      lines.push('# HELP bsa_overlay_replay_total Overlay durable replay reads, by whether the read was shared (deduplicated) across sessions of the same channel or performed as the leader (RT-02).');
      lines.push('# TYPE bsa_overlay_replay_total counter');
      lines.push(`bsa_overlay_replay_total{outcome="shared"} ${overlayReplay.shared}`);
      lines.push(`bsa_overlay_replay_total{outcome="leader"} ${overlayReplay.leader}`);

      lines.push('# HELP bsa_derived_read_admission_total Widget/dashboard/analytics read admissions by outcome — shed means a configured concurrency ceiling was at capacity (RT-10).');
      lines.push('# TYPE bsa_derived_read_admission_total counter');
      lines.push(`bsa_derived_read_admission_total{outcome="admitted"} ${derivedReadAdmission.admitted}`);
      lines.push(`bsa_derived_read_admission_total{outcome="shed"} ${derivedReadAdmission.shed}`);

      lines.push('# HELP bsa_derived_read_timeout_total Widget/dashboard/analytics reads cancelled by a configured statement_timeout (RT-11). Never applied to a payment write, webhook commit or migration.');
      lines.push('# TYPE bsa_derived_read_timeout_total counter');
      lines.push(`bsa_derived_read_timeout_total ${derivedReadTimeouts}`);

      // RT-06: bucketed histograms for the two §19.4-budgeted paths this
      // process observes, plus a bucket-interpolated p95/p99 read-out. The
      // gauge HELP text states the estimate's bound explicitly — it is
      // never presented as an exact value (RT-06 §3.2).
      lines.push(
        ...renderHistogram(
          'bsa_api_read_duration_ms',
          'API read request duration in milliseconds (GET, non-internal routes). Budget: p99 < 200ms (FULL-PRODUCT-DEFINITION.md §19.4).',
          readDuration,
        ),
      );
      lines.push('# HELP bsa_api_read_duration_ms_p95_estimate Bucket-interpolated p95 estimate; bounded by the containing bucket\'s width, not exact. 0 when no observations exist.');
      lines.push('# TYPE bsa_api_read_duration_ms_p95_estimate gauge');
      lines.push(`bsa_api_read_duration_ms_p95_estimate ${(estimateQuantile(readDuration, 0.95) ?? 0).toFixed(3)}`);
      lines.push('# HELP bsa_api_read_duration_ms_p99_estimate Bucket-interpolated p99 estimate; bounded by the containing bucket\'s width, not exact. This is the number the < 200ms budget is checked against. 0 when no observations exist.');
      lines.push('# TYPE bsa_api_read_duration_ms_p99_estimate gauge');
      lines.push(`bsa_api_read_duration_ms_p99_estimate ${(estimateQuantile(readDuration, 0.99) ?? 0).toFixed(3)}`);

      lines.push(
        ...renderHistogram(
          'bsa_api_tip_order_duration_ms',
          'Tip-order creation request duration in milliseconds (POST /v1/public/channels/:handle/tips/orders). Budget: p99 < 500ms (FULL-PRODUCT-DEFINITION.md §19.4).',
          tipOrderDuration,
        ),
      );
      lines.push('# HELP bsa_api_tip_order_duration_ms_p95_estimate Bucket-interpolated p95 estimate; bounded by the containing bucket\'s width, not exact. 0 when no observations exist.');
      lines.push('# TYPE bsa_api_tip_order_duration_ms_p95_estimate gauge');
      lines.push(`bsa_api_tip_order_duration_ms_p95_estimate ${(estimateQuantile(tipOrderDuration, 0.95) ?? 0).toFixed(3)}`);
      lines.push('# HELP bsa_api_tip_order_duration_ms_p99_estimate Bucket-interpolated p99 estimate; bounded by the containing bucket\'s width, not exact. This is the number the < 500ms budget is checked against. 0 when no observations exist.');
      lines.push('# TYPE bsa_api_tip_order_duration_ms_p99_estimate gauge');
      lines.push(`bsa_api_tip_order_duration_ms_p99_estimate ${(estimateQuantile(tipOrderDuration, 0.99) ?? 0).toFixed(3)}`);

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
