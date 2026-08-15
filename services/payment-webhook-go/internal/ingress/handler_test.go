package ingress

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/webhook"
)

type fakeStore struct {
	calls     int
	duplicate bool
	err       error
}

type fakePumper struct {
	calls int
	err   error
	trace string
}

type retryPumper struct {
	calls int
	errs  []error
}

func (p *retryPumper) Pump(context.Context) error {
	index := p.calls
	p.calls++
	if index < len(p.errs) {
		return p.errs[index]
	}
	return nil
}

type retryStore struct {
	calls int
}

func (s *retryStore) PersistVerified(context.Context, webhook.Delivery, []byte) (bool, error) {
	s.calls++
	return s.calls > 1, nil
}

func (p *fakePumper) Pump(ctx context.Context) error {
	p.calls++
	p.trace = traceIDFromContext(ctx)
	return p.err
}

func (s *fakeStore) PersistVerified(_ context.Context, _ webhook.Delivery, _ []byte) (bool, error) {
	s.calls++
	return s.duplicate, s.err
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
	pumper := &fakePumper{}
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, request(`{"event":"payment.captured"}`, "secret", "event_1"))

	if recorder.Code != http.StatusOK || store.calls != 1 || pumper.calls != 1 || pumper.trace != "razorpay:event_1" {
		t.Fatalf("status=%d store_calls=%d pump_calls=%d trace=%q", recorder.Code, store.calls, pumper.calls, pumper.trace)
	}
}

func TestWebhookToWorkerPumpHTTPBoundaryPreservesTraceAndRetrySemantics(t *testing.T) {
	var receivedTrace string
	worker := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/internal/v1/tasks/pump" {
			t.Errorf("unexpected worker request: %s %s", request.Method, request.URL.Path)
		}
		receivedTrace = request.Header.Get(traceHeader)
		response.WriteHeader(http.StatusOK)
	}))
	defer worker.Close()

	pumper, err := NewWorkerPumpClient(worker.Client(), worker.URL+"/internal/v1/tasks/pump")
	if err != nil {
		t.Fatalf("configure worker pump: %v", err)
	}
	store := &fakeStore{}
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, request(`{}`, "secret", "event_http_boundary"))

	if recorder.Code != http.StatusOK || store.calls != 1 || receivedTrace != "razorpay:event_http_boundary" {
		t.Fatalf("status=%d store_calls=%d trace=%q", recorder.Code, store.calls, receivedTrace)
	}
}

func TestWebhookToWorkerPumpHTTPFailureReturnsProviderRetry(t *testing.T) {
	worker := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer worker.Close()

	pumper, err := NewWorkerPumpClient(worker.Client(), worker.URL+"/internal/v1/tasks/pump")
	if err != nil {
		t.Fatalf("configure worker pump: %v", err)
	}
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: &fakeStore{}, Pumper: pumper}.ServeHTTP(recorder, request(`{}`, "secret", "event_http_failure"))

	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("Retry-After") != "5" {
		t.Fatalf("status=%d retry-after=%q", recorder.Code, recorder.Header().Get("Retry-After"))
	}
}

func TestHandlerFailsClosedWhenWorkerPumpIsMissing(t *testing.T) {
	store := &fakeStore{}
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store}.ServeHTTP(recorder, request(`{}`, "secret", "event_1"))

	if recorder.Code != http.StatusServiceUnavailable || store.calls != 0 {
		t.Fatalf("status=%d store_calls=%d", recorder.Code, store.calls)
	}
}

func TestHandlerReturnsDuplicateAfterDurableDeduplication(t *testing.T) {
	store := &fakeStore{duplicate: true}
	pumper := &fakePumper{}
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, request(`{}`, "secret", "event_1"))

	if recorder.Code != http.StatusOK || recorder.Body.String() != "{\"status\":\"duplicate\"}\n" || pumper.calls != 1 {
		t.Fatalf("status=%d body=%q", recorder.Code, recorder.Body.String())
	}
}

func TestHandlerRequestsProviderRetryWhenDeliveryPumpFails(t *testing.T) {
	store := &fakeStore{}
	pumper := &fakePumper{err: errors.New("worker unavailable")}
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, request(`{}`, "secret", "event_1"))

	if recorder.Code != http.StatusServiceUnavailable || pumper.calls != 1 {
		t.Fatalf("status=%d pump_calls=%d", recorder.Code, pumper.calls)
	}
}

func TestHandlerRetryAfterPumpFailureReusesDurableDeduplication(t *testing.T) {
	store := &retryStore{}
	pumper := &retryPumper{errs: []error{errors.New("worker unavailable"), nil}}

	first := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(first, request(`{}`, "secret", "event_retry_1"))
	if first.Code != http.StatusServiceUnavailable {
		t.Fatalf("first status=%d", first.Code)
	}

	second := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(second, request(`{}`, "secret", "event_retry_1"))
	if second.Code != http.StatusOK || second.Body.String() != "{\"status\":\"duplicate\"}\n" {
		t.Fatalf("second status=%d body=%q", second.Code, second.Body.String())
	}
	if store.calls != 2 || pumper.calls != 2 {
		t.Fatalf("store_calls=%d pump_calls=%d", store.calls, pumper.calls)
	}
}

func TestHandlerDoesNotCallStoreForInvalidSignature(t *testing.T) {
	store := &fakeStore{}
	pumper := &fakePumper{}
	req := request(`{}`, "secret", "event_1")
	req.Header.Set("X-Razorpay-Signature", "bad")
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusUnauthorized || store.calls != 0 {
		t.Fatalf("status=%d store_calls=%d", recorder.Code, store.calls)
	}
}

func TestHandlerRequestsProviderRetryWhenStoreFails(t *testing.T) {
	store := &fakeStore{err: errors.New("db down")}
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store}.ServeHTTP(recorder, request(`{}`, "secret", "event_1"))

	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("Retry-After") != "5" {
		t.Fatalf("status=%d retry-after=%q", recorder.Code, recorder.Header().Get("Retry-After"))
	}
}

func TestHandlerRejectsPermanentlyInvalidVerifiedPayloadWithoutWakingWorker(t *testing.T) {
	store := &fakeStore{err: ErrInvalidWebhookPayload}
	pumper := &fakePumper{}
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, request("{}", "secret", "event_invalid_payload"))

	if recorder.Code != http.StatusBadRequest || strings.TrimSpace(recorder.Body.String()) != `{"error":"invalid_webhook_payload"}` || pumper.calls != 0 {
		t.Fatalf("status=%d body=%q pump_calls=%d", recorder.Code, recorder.Body.String(), pumper.calls)
	}
}

func TestHandlerAcknowledgesDurableQuarantineWithoutWakingWorker(t *testing.T) {
	store := &fakeStore{err: ErrQuarantinedWebhook}
	pumper := &fakePumper{}
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(recorder, request("{}", "secret", "event_quarantined"))

	if recorder.Code != http.StatusOK || strings.TrimSpace(recorder.Body.String()) != `{"status":"quarantined"}` || pumper.calls != 0 {
		t.Fatalf("status=%d body=%q pump_calls=%d", recorder.Code, recorder.Body.String(), pumper.calls)
	}
}

func TestHandlerRejectsOversizedBody(t *testing.T) {
	store := &fakeStore{}
	pumper := &fakePumper{}
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store, Pumper: pumper, MaxBodyBytes: 2}.ServeHTTP(recorder, request(`{"x":1}`, "secret", "event_1"))

	if recorder.Code != http.StatusRequestEntityTooLarge || store.calls != 0 {
		t.Fatalf("status=%d store_calls=%d", recorder.Code, store.calls)
	}
}
