package observability

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RT-06 (section 19.0, section 19.4): "API p99 | < 200ms for reads, < 500ms
// for the tip-order path." /internal/v1/tips/orders is this service's own
// leg of the tip-order path (the public API's POST .../tips/orders calls
// straight through to this handler to create the Razorpay order) -- so 500
// is the exact budget boundary there, not an equivalence judgment. The
// remaining values are measurement resolution around it -- see
// apps/api/src/observability/metrics.ts's TIP_ORDER_DURATION_BUCKETS_MS
// comment for the identical reasoning on the TS leg of this same path.
//
// /v1/webhooks/razorpay (the payment webhook acknowledgement path, RT-04)
// carries no explicit section-19.4 duration number of its own -- only the
// ordering rule "2xx after the durable commit, never after a dispatch
// call." It is measured under this same tip-order-class 500ms bucket set
// because both are payment-commit HTTP paths, and RT-06's own scope
// (section 3.5) explicitly names the webhook acknowledgement path as
// somewhere this task may "add measurement... beyond" RT-04/RT-05's
// existing behaviour. This is a reasoned classification, not an invented
// number -- both boundaries are still the one 500ms figure section 19.4
// states -- and it is recorded, not asserted quietly, in
// bharatstudio-requirements/reviews/2026-09-16-rt-06-budget-histograms.md.
var tipOrderClassBucketsMs = []float64{50, 100, 200, 300, 400, 500, 750, 1000, 2000}

// Metrics is an in-process, bounded-by-route Prometheus text emitter. It is
// intentionally dependency-free at the service boundary; scraping and
// retention belong to the deployment platform.
type Metrics struct {
	mu                 sync.Mutex
	requests           map[string]uint64
	durations          map[string]time.Duration
	business           map[string]uint64
	tipOrderDuration   *Histogram
	webhookAckDuration *Histogram
}

func New() *Metrics {
	return &Metrics{
		requests:           make(map[string]uint64),
		durations:          make(map[string]time.Duration),
		business:           make(map[string]uint64),
		tipOrderDuration:   NewHistogram(tipOrderClassBucketsMs),
		webhookAckDuration: NewHistogram(tipOrderClassBucketsMs),
	}
}

func (m *Metrics) Observe(method, route string, status int, duration time.Duration) {
	if m == nil {
		return
	}
	normalized := normalizePath(route)
	key := method + "|" + normalized + "|" + strconv.Itoa(status)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests[key]++
	if duration > 0 {
		m.durations[key] += duration
	}
	// RT-06: supplement, never replace, the counters above (RT-06.7).
	durationMs := float64(duration) / float64(time.Millisecond)
	switch normalized {
	case "/internal/v1/tips/orders":
		m.tipOrderDuration.Observe(durationMs)
	case "/v1/webhooks/razorpay":
		m.webhookAckDuration.Observe(durationMs)
	}
}

// ObserveWebhookOutcome records only a fixed outcome category. Provider event
// IDs, order IDs, account references and payload values must never become
// metric labels.
func (m *Metrics) ObserveWebhookOutcome(outcome string) {
	m.observeBusiness("webhook", outcome, []string{"accepted", "duplicate", "invalid", "quarantined", "retryable", "not_configured"})
}

func (m *Metrics) ObserveCheckoutOutcome(outcome string) {
	m.observeBusiness("checkout", outcome, []string{"accepted", "invalid", "retryable", "unauthorized", "not_configured"})
}

// ObserveWakeupOutcome records the post-commit dispatcher wake-up outcome
// (RT-04). The wake-up is fire-and-forget and never changes the webhook's
// response, so its failure is only ever logged and counted here -- never a
// reason to retry an already-durable payment. No provider event ID, order
// ID, account reference or amount is ever a label value.
func (m *Metrics) ObserveWakeupOutcome(outcome string) {
	m.observeBusiness("wakeup", outcome, []string{"succeeded", "failed"})
}

// ObserveQrOutcome records dynamic-QR creation outcomes (L19d). Same fixed
// category discipline as ObserveCheckoutOutcome: no provider or intent
// identifier is ever a label value.
func (m *Metrics) ObserveQrOutcome(outcome string) {
	m.observeBusiness("qr", outcome, []string{"accepted", "invalid", "retryable", "unauthorized", "not_configured"})
}

func (m *Metrics) ObserveReconciliationOutcome(kind, outcome string) {
	if kind != "payment_reconciliation" && kind != "refund_reconciliation" {
		kind = "reconciliation"
	}
	m.observeBusiness(kind, outcome, []string{"completed", "retryable", "unauthorized", "not_configured"})
}

func (m *Metrics) observeBusiness(kind, outcome string, allowed []string) {
	if m == nil {
		return
	}
	valid := false
	for _, candidate := range allowed {
		if outcome == candidate {
			valid = true
			break
		}
	}
	if !valid {
		outcome = "other"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.business[kind+"|"+outcome]++
}

func (m *Metrics) WritePrometheus(w io.Writer) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, _ = io.WriteString(w, "# HELP bsa_payment_requests_total HTTP requests completed by normalized route.\n# TYPE bsa_payment_requests_total counter\n# HELP bsa_payment_request_duration_ms_sum HTTP request duration sum in milliseconds.\n# TYPE bsa_payment_request_duration_ms_sum counter\n")
	for key, count := range m.requests {
		parts := strings.SplitN(key, "|", 3)
		if len(parts) != 3 {
			continue
		}
		labels := fmt.Sprintf(`method="%s",route="%s",status_code="%s"`, escape(parts[0]), escape(parts[1]), escape(parts[2]))
		_, _ = fmt.Fprintf(w, "bsa_payment_requests_total{%s} %d\n", labels, count)
		_, _ = fmt.Fprintf(w, "bsa_payment_request_duration_ms_sum{%s} %.3f\n", labels, float64(m.durations[key])/float64(time.Millisecond))
	}
	for key, count := range m.business {
		parts := strings.SplitN(key, "|", 2)
		if len(parts) != 2 {
			continue
		}
		labels := fmt.Sprintf(`kind="%s",outcome="%s"`, escape(parts[0]), escape(parts[1]))
		_, _ = fmt.Fprintf(w, "bsa_payment_business_total{%s} %d\n", labels, count)
	}

	// RT-06: bucketed histograms for the budgeted paths this service
	// observes, plus a bucket-interpolated p95/p99 read-out. No label of
	// any kind -- an order id, payment id, event id or channel id must
	// never reach a metric label (RT-06.5); the metric name alone already
	// identifies the path.
	m.tipOrderDuration.WritePrometheus(w, "bsa_payment_tip_order_duration_ms",
		"Tip-order creation request duration in milliseconds (POST /internal/v1/tips/orders, this service's leg of the tip-order path). Budget: p99 < 500ms (FULL-PRODUCT-DEFINITION.md section 19.4).")
	writeQuantileGauge(w, "bsa_payment_tip_order_duration_ms", m.tipOrderDuration)

	m.webhookAckDuration.WritePrometheus(w, "bsa_payment_webhook_ack_duration_ms",
		"Payment webhook acknowledgement request duration in milliseconds (POST /v1/webhooks/razorpay, commit-then-2xx per RT-04). No section-19.4 row names this path with its own duration number; measured under the same 500ms tip-order-class budget because both are payment-commit HTTP paths -- see bharatstudio-requirements/reviews/2026-09-16-rt-06-budget-histograms.md. Passive measurement only: never gates the response (RT-04 is unchanged by this).")
	writeQuantileGauge(w, "bsa_payment_webhook_ack_duration_ms", m.webhookAckDuration)
}

func (m *Metrics) Endpoint(authorize func(*http.Request) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if authorize == nil || authorize(r) != nil {
			w.Header().Set("Content-Type", "text/plain; version=0.0.4")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, "unauthorized\n")
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		m.WritePrometheus(w)
	})
}

func Instrument(next http.Handler, metrics *Metrics) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		captured := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(captured, r)
		metrics.Observe(r.Method, r.URL.Path, captured.status, time.Since(started))
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(body)
}

func normalizePath(path string) string {
	path = strings.SplitN(path, "?", 2)[0]
	switch path {
	case "/healthz", "/v1/webhooks/razorpay", "/internal/v1/tips/orders", "/internal/v1/reconciliation/payments", "/internal/v1/reconciliation/refunds", "/internal/metrics":
		return path
	}
	return "/_other"
}

func escape(value string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(value)
}
