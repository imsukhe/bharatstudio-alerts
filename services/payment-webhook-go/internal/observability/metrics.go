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

// Metrics is an in-process, bounded-by-route Prometheus text emitter. It is
// intentionally dependency-free at the service boundary; scraping and
// retention belong to the deployment platform.
type Metrics struct {
	mu        sync.Mutex
	requests  map[string]uint64
	durations map[string]time.Duration
	business  map[string]uint64
}

func New() *Metrics {
	return &Metrics{requests: make(map[string]uint64), durations: make(map[string]time.Duration), business: make(map[string]uint64)}
}

func (m *Metrics) Observe(method, route string, status int, duration time.Duration) {
	if m == nil {
		return
	}
	key := method + "|" + normalizePath(route) + "|" + strconv.Itoa(status)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests[key]++
	if duration > 0 {
		m.durations[key] += duration
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
