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

// RT-06 (section 19.0, section 19.4): no row in section 19.4's budget table
// names this service's own paths with an explicit duration number --
// /internal/v1/tasks/pump is the leased outbox dispatcher's own HTTP
// trigger (RT-04/RT-05), invoked both by the payment webhook's fire-and-
// forget post-commit wake-up and by the scheduled "outbox-recovery" cron,
// and it never gates a response any external actor is waiting on. Measured
// here under the "API reads" read-class bucket set (200ms boundary) because
// it is the closer analogue of the two budgeted classes: a bounded,
// internal, no-external-provider-call operation, unlike the tip-order
// path's live outbound call to Razorpay. This is a reasoned classification,
// not an invented number -- recorded, not asserted quietly, in
// bharatstudio-requirements/reviews/2026-09-16-rt-06-budget-histograms.md.
var readClassBucketsMs = []float64{10, 25, 50, 75, 100, 150, 200, 300, 500, 1000}

type Metrics struct {
	mu           sync.Mutex
	requests     map[string]uint64
	durations    map[string]time.Duration
	business     map[string]uint64
	pumpDuration *Histogram
}

func New() *Metrics {
	return &Metrics{
		requests:     make(map[string]uint64),
		durations:    make(map[string]time.Duration),
		business:     make(map[string]uint64),
		pumpDuration: NewHistogram(readClassBucketsMs),
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
	if normalized == "/internal/v1/tasks/pump" {
		m.pumpDuration.Observe(float64(duration) / float64(time.Millisecond))
	}
}

// ObserveTaskOutcome records only a bounded outcome category. It deliberately
// excludes delivery, event, channel, provider and user identifiers.
func (m *Metrics) ObserveTaskOutcome(outcome string) {
	m.observeBusiness("task", outcome, []string{"accepted", "ignored", "invalid", "retryable", "unauthorized", "not_configured"})
}

// ObservePumpOutcome records only a bounded pump result category. It is safe
// to expose through the authenticated metrics endpoint without leaking queue
// or payment data.
func (m *Metrics) ObservePumpOutcome(outcome string) {
	m.observeBusiness("pump", outcome, []string{"completed", "partial", "skipped", "retryable", "invalid", "unauthorized", "not_configured"})
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
	_, _ = io.WriteString(w, "# HELP bsa_worker_requests_total HTTP requests completed by normalized route.\n# TYPE bsa_worker_requests_total counter\n# HELP bsa_worker_request_duration_ms_sum HTTP request duration sum in milliseconds.\n# TYPE bsa_worker_request_duration_ms_sum counter\n")
	for key, count := range m.requests {
		parts := strings.SplitN(key, "|", 3)
		if len(parts) != 3 {
			continue
		}
		labels := fmt.Sprintf(`method="%s",route="%s",status_code="%s"`, escape(parts[0]), escape(parts[1]), escape(parts[2]))
		_, _ = fmt.Fprintf(w, "bsa_worker_requests_total{%s} %d\n", labels, count)
		_, _ = fmt.Fprintf(w, "bsa_worker_request_duration_ms_sum{%s} %.3f\n", labels, float64(m.durations[key])/float64(time.Millisecond))
	}
	for key, count := range m.business {
		parts := strings.SplitN(key, "|", 2)
		if len(parts) != 2 {
			continue
		}
		labels := fmt.Sprintf(`kind="%s",outcome="%s"`, escape(parts[0]), escape(parts[1]))
		_, _ = fmt.Fprintf(w, "bsa_worker_business_total{%s} %d\n", labels, count)
	}

	// RT-06: bucketed histogram for the dispatcher's own HTTP trigger, plus
	// a bucket-interpolated p95/p99 read-out. No label of any kind -- a
	// delivery, event, channel or payment identifier must never reach a
	// metric label (RT-06.5).
	m.pumpDuration.WritePrometheus(w, "bsa_worker_pump_duration_ms",
		"Outbox dispatcher pump request duration in milliseconds (POST /internal/v1/tasks/pump, RT-04/RT-05's leased dispatcher trigger). No section-19.4 row names this path with its own duration number; measured under the read-class 200ms budget as the closer analogue -- see bharatstudio-requirements/reviews/2026-09-16-rt-06-budget-histograms.md. Never gates the webhook's response: this path is always fire-and-forget or scheduled, never awaited by an external caller.")
	writeQuantileGauge(w, "bsa_worker_pump_duration_ms", m.pumpDuration)
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
	case "/healthz", "/internal/v1/tasks/overlay", "/internal/v1/tasks/pump", "/internal/metrics":
		return path
	}
	return "/_other"
}

func escape(value string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(value)
}
