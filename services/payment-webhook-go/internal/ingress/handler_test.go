package ingress

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/observability"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/webhook"
)

type fakeStore struct {
	calls     int
	duplicate bool
	err       error
}

// fakePumper is the fire-and-forget wake-up dependency (RT-04). Pump now
// always runs in its own goroutine (see Handler.wakeUpDispatcher), so a test
// that needs to observe a call must wait on the done channel rather than
// reading calls/trace immediately after ServeHTTP returns.
type fakePumper struct {
	mu    sync.Mutex
	calls int
	err   error
	trace string
	done  chan struct{}
}

func newFakePumper(err error) *fakePumper {
	return &fakePumper{err: err, done: make(chan struct{}, 1)}
}

func (p *fakePumper) Pump(ctx context.Context) error {
	p.mu.Lock()
	p.calls++
	p.trace = traceIDFromContext(ctx)
	err := p.err
	p.mu.Unlock()
	select {
	case p.done <- struct{}{}:
	default:
	}
	return err
}

func (p *fakePumper) waitForCall(t *testing.T) {
	t.Helper()
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the fire-and-forget wake-up to run")
	}
}

func (p *fakePumper) snapshot() (calls int, trace string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls, p.trace
}

// retryPumper returns its configured errors in sequence, one per call, then
// nil. Used to prove that a wake-up outcome (success or failure) never
// changes what the *next*, independent webhook delivery is acknowledged
// with.
type retryPumper struct {
	mu    sync.Mutex
	calls int
	errs  []error
	done  chan struct{}
}

func newRetryPumper(errs []error) *retryPumper {
	return &retryPumper{errs: errs, done: make(chan struct{}, len(errs)+1)}
}

func (p *retryPumper) Pump(context.Context) error {
	p.mu.Lock()
	index := p.calls
	p.calls++
	var err error
	if index < len(p.errs) {
		err = p.errs[index]
	}
	p.mu.Unlock()
	select {
	case p.done <- struct{}{}:
	default:
	}
	return err
}

func (p *retryPumper) waitForCall(t *testing.T) {
	t.Helper()
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the fire-and-forget wake-up to run")
	}
}

func (p *retryPumper) callCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

// blockingPumper never returns until the test releases it. It exists only
// to prove ordering (RT-04.3): if ServeHTTP can return, and the response can
// already be observed, while Pump is still provably blocked, the wake-up was
// never awaited.
type blockingPumper struct {
	once    sync.Once
	started chan struct{}
	release chan struct{}
}

func newBlockingPumper() *blockingPumper {
	return &blockingPumper{started: make(chan struct{}), release: make(chan struct{})}
}

func (p *blockingPumper) Pump(context.Context) error {
	p.once.Do(func() { close(p.started) })
	<-p.release
	return nil
}

// countingPumper records how many wake-ups ran. It no longer counts down a
// WaitGroup sized to the number of webhooks: since the 2026-09-16 coalescing
// correction a burst of N webhooks deliberately produces fewer than N
// wake-ups, so "wait for N wake-ups" would never complete. Tests wait for the
// coalescer to go idle instead.
type countingPumper struct {
	mu    sync.Mutex
	calls int
	err   error
}

func (p *countingPumper) Pump(context.Context) error {
	p.mu.Lock()
	p.calls++
	p.mu.Unlock()
	return p.err
}

func (p *countingPumper) callCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

type retryStore struct {
	calls int
}

func (s *retryStore) PersistVerified(context.Context, webhook.Delivery, []byte) (bool, error) {
	s.calls++
	return s.calls > 1, nil
}

func (s *fakeStore) PersistVerified(_ context.Context, _ webhook.Delivery, _ []byte) (bool, error) {
	s.calls++
	return s.duplicate, s.err
}

// concurrentStore is fakeStore's counterpart for the burst test, where many
// goroutines call PersistVerified on the same store at once. fakeStore's
// plain int is intentionally left alone (every other test drives it
// sequentially) rather than making every existing assertion pay for
// synchronization it does not need.
type concurrentStore struct {
	calls int64
}

func (s *concurrentStore) PersistVerified(context.Context, webhook.Delivery, []byte) (bool, error) {
	atomic.AddInt64(&s.calls, 1)
	return false, nil
}

// syncBuffer is a concurrency-safe io.Writer, needed because the
// fire-and-forget wake-up goroutine writes log lines concurrently with the
// test goroutine reading them back.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// waitForCondition polls check until it returns true or timeout elapses.
// Used to observe an async side effect (a log line, a metric) without
// asserting anything about how long it took -- only that it eventually
// happened.
func waitForCondition(t *testing.T, timeout time.Duration, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if check() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("condition was not met before the deadline")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func sign(body []byte, secret string) string {
	h := hmac.New(sha256.New, []byte(secret))
	_, _ = h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

func request(body string, secret string, eventID string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/v1/internal/razorpay/webhook", strings.NewReader(body))
	req.Header.Set("X-Razorpay-Signature", sign([]byte(body), secret))
	req.Header.Set("X-Razorpay-Event-Id", eventID)
	return req
}

func TestHandlerPersistsBeforeAcknowledging(t *testing.T) {
	store := &fakeStore{}
	pumper := newFakePumper(nil)
	recorder := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, request(`{"event":"payment.captured"}`, "secret", "event_1"))

	if recorder.Code != http.StatusOK || store.calls != 1 {
		t.Fatalf("status=%d store_calls=%d", recorder.Code, store.calls)
	}
	pumper.waitForCall(t)
	if calls, trace := pumper.snapshot(); calls != 1 || trace != "razorpay:event_1" {
		t.Fatalf("pump_calls=%d trace=%q", calls, trace)
	}
}

// RT-04.1: a slow or failing dispatch cannot change the webhook's status
// code. The commit already succeeded, so the response is 2xx regardless of
// what the fire-and-forget wake-up does.
func TestWebhookToWorkerPumpHTTPBoundaryPreservesTraceAndIsNeverGatedByDispatch(t *testing.T) {
	receivedTrace := make(chan string, 1)
	worker := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/internal/v1/tasks/pump" {
			t.Errorf("unexpected worker request: %s %s", request.Method, request.URL.Path)
		}
		receivedTrace <- request.Header.Get(traceHeader)
		response.WriteHeader(http.StatusOK)
	}))
	defer worker.Close()

	pumper, err := NewWorkerPumpClient(worker.Client(), worker.URL+"/internal/v1/tasks/pump")
	if err != nil {
		t.Fatalf("configure worker pump: %v", err)
	}
	store := &fakeStore{}
	recorder := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, request(`{}`, "secret", "event_http_boundary"))

	if recorder.Code != http.StatusOK || store.calls != 1 {
		t.Fatalf("status=%d store_calls=%d", recorder.Code, store.calls)
	}
	select {
	case trace := <-receivedTrace:
		if trace != "razorpay:event_http_boundary" {
			t.Fatalf("trace=%q", trace)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the fire-and-forget wake-up to reach the worker")
	}
}

// RT-04.1 at the real HTTP boundary: a worker pump call that fails must not
// turn back into a provider retry. Supersedes the pre-RT-04 behaviour, where
// this exact scenario returned 503 -- that reasoning is what RT-04 replaces.
func TestWebhookToWorkerPumpHTTPFailureStillAcknowledgesTheCommit(t *testing.T) {
	requestSeen := make(chan struct{}, 1)
	worker := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
		requestSeen <- struct{}{}
	}))
	defer worker.Close()

	pumper, err := NewWorkerPumpClient(worker.Client(), worker.URL+"/internal/v1/tasks/pump")
	if err != nil {
		t.Fatalf("configure worker pump: %v", err)
	}
	recorder := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: &fakeStore{}, Pumper: pumper}.ServeHTTP(recorder, request(`{}`, "secret", "event_http_failure"))

	if recorder.Code != http.StatusOK || recorder.Body.String() != "{\"status\":\"accepted\"}\n" {
		t.Fatalf("status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	select {
	case <-requestSeen:
	case <-time.After(2 * time.Second):
		t.Fatal("worker pump was never attempted despite a durable commit")
	}
}

func TestHandlerFailsClosedWhenWorkerPumpIsMissing(t *testing.T) {
	store := &fakeStore{}
	recorder := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store}.ServeHTTP(recorder, request(`{}`, "secret", "event_1"))

	if recorder.Code != http.StatusServiceUnavailable || store.calls != 0 {
		t.Fatalf("status=%d store_calls=%d", recorder.Code, store.calls)
	}
}

func TestHandlerReturnsDuplicateAfterDurableDeduplication(t *testing.T) {
	store := &fakeStore{duplicate: true}
	pumper := newFakePumper(nil)
	recorder := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, request(`{}`, "secret", "event_1"))

	if recorder.Code != http.StatusOK || recorder.Body.String() != "{\"status\":\"duplicate\"}\n" {
		t.Fatalf("status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	pumper.waitForCall(t)
	if calls, _ := pumper.snapshot(); calls != 1 {
		t.Fatalf("pump_calls=%d", calls)
	}
}

// RT-04.1 / RT-04.4: a failing wake-up is acknowledged 2xx (the commit
// already happened), and the failure is logged and counted -- never
// surfaced to the provider, and never a reason to mark the delivery
// undispatchable. A later, healthy pump attempt (the next scheduled
// dispatcher tick, RT-08) can still dispatch the same durable delivery.
func TestHandlerAcknowledgesEvenWhenDeliveryWakeupFails(t *testing.T) {
	store := &fakeStore{}
	pumper := newFakePumper(errors.New("worker unavailable"))
	logOutput := &syncBuffer{}
	metrics := observability.New()
	handler := Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper, Metrics: metrics, Logger: observability.NewStructuredLogger(logOutput)}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request(`{}`, "secret", "event_1"))

	if recorder.Code != http.StatusOK || recorder.Body.String() != "{\"status\":\"accepted\"}\n" {
		t.Fatalf("status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	pumper.waitForCall(t)
	if calls, _ := pumper.snapshot(); calls != 1 {
		t.Fatalf("pump_calls=%d", calls)
	}

	// Pump() returning (observed above) only proves the fire-and-forget
	// goroutine reached that call; the metrics/log calls that follow it in
	// the same goroutine still race the assertions below, so poll for them
	// rather than asserting immediately.
	waitForCondition(t, 2*time.Second, func() bool {
		return strings.Contains(logOutput.String(), `"component":"webhook_wakeup"`) &&
			strings.Contains(logOutput.String(), `"outcome":"failed"`)
	})

	var metricsOutput strings.Builder
	metrics.WritePrometheus(&metricsOutput)
	if !strings.Contains(metricsOutput.String(), `bsa_payment_business_total{kind="wakeup",outcome="failed"} 1`) {
		t.Fatalf("wake-up failure was not counted: %s", metricsOutput.String())
	}
	if !strings.Contains(metricsOutput.String(), `bsa_payment_business_total{kind="webhook",outcome="accepted"} 1`) {
		t.Fatalf("accepted webhook outcome missing despite the commit succeeding: %s", metricsOutput.String())
	}
	if store.calls != 1 {
		t.Fatalf("store_calls=%d", store.calls)
	}
}

// RT-04.5: a later, independent delivery of the same idempotency key is
// still acknowledged as duplicate, and a wake-up outcome on one delivery
// never changes the acknowledgement of another.
func TestHandlerAcknowledgesRepeatedDeliveryRegardlessOfEitherWakeupOutcome(t *testing.T) {
	store := &retryStore{}
	pumper := newRetryPumper([]error{errors.New("worker unavailable"), nil})

	first := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(first, request(`{}`, "secret", "event_retry_1"))
	if first.Code != http.StatusOK || first.Body.String() != "{\"status\":\"accepted\"}\n" {
		t.Fatalf("first status=%d body=%q", first.Code, first.Body.String())
	}
	pumper.waitForCall(t)

	second := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(second, request(`{}`, "secret", "event_retry_1"))
	if second.Code != http.StatusOK || second.Body.String() != "{\"status\":\"duplicate\"}\n" {
		t.Fatalf("second status=%d body=%q", second.Code, second.Body.String())
	}
	pumper.waitForCall(t)

	if store.calls != 2 || pumper.callCount() != 2 {
		t.Fatalf("store_calls=%d pump_calls=%d", store.calls, pumper.callCount())
	}
}

// RT-04.3: the wake-up is never awaited on the acknowledgement path. This
// asserts ordering (the handler returns, with its response already written,
// while Pump is still provably blocked), not wall-clock duration.
func TestWakeupIsNeverAwaitedOnTheAcknowledgementPath(t *testing.T) {
	pumper := newBlockingPumper()
	store := &fakeStore{}
	recorder := httptest.NewRecorder()
	handlerDone := make(chan struct{})
	go func() {
		Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, request(`{}`, "secret", "event_never_awaited"))
		close(handlerDone)
	}()

	select {
	case <-handlerDone:
	case <-time.After(2 * time.Second):
		close(pumper.release)
		t.Fatal("handler blocked on the wake-up instead of returning immediately")
	}
	if recorder.Code != http.StatusOK || recorder.Body.String() != "{\"status\":\"accepted\"}\n" {
		close(pumper.release)
		t.Fatalf("status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	// The handler has already returned with its response written. Proving
	// the wake-up was attempted (not skipped) but is still blocked shows it
	// ran concurrently, never in front of, the acknowledgement.
	select {
	case <-pumper.started:
	case <-time.After(2 * time.Second):
		t.Fatal("wake-up was never attempted")
	}
	close(pumper.release)
}

// RT-04.10: a burst of webhooks must not leak a goroutine per request. Every
// wake-up is bounded (WorkerPumpClient's own timeout in production; the fake
// pumper returns immediately here) and this proves the goroutine count returns
// to baseline once the burst has drained.
//
// Updated for the 2026-09-16 coalescing correction. It previously asserted
// that a burst of n webhooks produced exactly n wake-ups; that was the defect,
// and the assertion now reads the other way. Every webhook is still persisted
// -- coalescing collapses the hint, never the commit.
func TestBurstOfWebhooksDoesNotLeakWakeupGoroutines(t *testing.T) {
	const n = 200
	pumper := &countingPumper{}
	store := &concurrentStore{}
	handler := Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper}

	before := runtime.NumGoroutine()
	var requests sync.WaitGroup
	for index := 0; index < n; index++ {
		requests.Add(1)
		go func(index int) {
			defer requests.Done()
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request(`{}`, "secret", fmt.Sprintf("event_burst_%d", index)))
		}(index)
	}
	requests.Wait()

	waitForCondition(t, 5*time.Second, handler.Wakeups.idle)

	deadline := time.Now().Add(2 * time.Second)
	for {
		runtime.GC()
		if runtime.NumGoroutine() <= before+4 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if after := runtime.NumGoroutine(); after > before+4 {
		t.Fatalf("goroutines grew from %d to %d after a burst of %d webhooks -- suspected leak", before, after, n)
	}
	if calls := pumper.callCount(); calls < 1 || calls >= n {
		t.Fatalf("wakeup calls=%d, want at least 1 and fewer than %d (coalesced)", calls, n)
	}
	if calls := atomic.LoadInt64(&store.calls); calls != n {
		t.Fatalf("store_calls=%d, want %d", calls, n)
	}
}

func TestHandlerDoesNotCallStoreForInvalidSignature(t *testing.T) {
	store := &fakeStore{}
	pumper := newFakePumper(nil)
	req := request(`{}`, "secret", "event_1")
	req.Header.Set("X-Razorpay-Signature", "bad")
	recorder := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusUnauthorized || store.calls != 0 {
		t.Fatalf("status=%d store_calls=%d", recorder.Code, store.calls)
	}
}

// RT-04.2: a commit failure still returns 503 and is still retried by the
// provider. This must not regress.
func TestHandlerRequestsProviderRetryWhenStoreFails(t *testing.T) {
	store := &fakeStore{err: errors.New("db down")}
	recorder := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store}.ServeHTTP(recorder, request(`{}`, "secret", "event_1"))

	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("Retry-After") != "5" {
		t.Fatalf("status=%d retry-after=%q", recorder.Code, recorder.Header().Get("Retry-After"))
	}
}

// RT-04.5: invalid-payload and quarantine outcomes are unchanged -- they
// fail before the commit-and-wake-up boundary and never trigger a wake-up.
func TestHandlerRejectsPermanentlyInvalidVerifiedPayloadWithoutWakingWorker(t *testing.T) {
	store := &fakeStore{err: ErrInvalidWebhookPayload}
	pumper := newFakePumper(nil)
	recorder := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, request("{}", "secret", "event_invalid_payload"))

	if recorder.Code != http.StatusBadRequest || strings.TrimSpace(recorder.Body.String()) != `{"error":"invalid_webhook_payload"}` {
		t.Fatalf("status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	if calls, _ := pumper.snapshot(); calls != 0 {
		t.Fatalf("pump_calls=%d", calls)
	}
}

func TestHandlerAcknowledgesDurableQuarantineWithoutWakingWorker(t *testing.T) {
	store := &fakeStore{err: ErrQuarantinedWebhook}
	pumper := newFakePumper(nil)
	recorder := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, request("{}", "secret", "event_quarantined"))

	if recorder.Code != http.StatusOK || strings.TrimSpace(recorder.Body.String()) != `{"status":"quarantined"}` {
		t.Fatalf("status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	if calls, _ := pumper.snapshot(); calls != 0 {
		t.Fatalf("pump_calls=%d", calls)
	}
}

func TestHandlerRejectsOversizedBody(t *testing.T) {
	store := &fakeStore{}
	pumper := newFakePumper(nil)
	recorder := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper, MaxBodyBytes: 2}.ServeHTTP(recorder, request(`{"x":1}`, "secret", "event_1"))

	if recorder.Code != http.StatusRequestEntityTooLarge || store.calls != 0 {
		t.Fatalf("status=%d store_calls=%d", recorder.Code, store.calls)
	}
}
