package ingress

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWorkerPumpClientRequiresHTTPS(t *testing.T) {
	if _, err := NewWorkerPumpClient(http.DefaultClient, "http://worker.invalid/internal/pump"); err == nil {
		t.Fatal("expected non-HTTPS worker pump endpoint to fail")
	}
}

func TestWorkerPumpClientReturnsRetryableErrorForNonSuccess(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	client, err := NewWorkerPumpClient(server.Client(), server.URL+"/internal/pump")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Pump(context.Background()); err == nil {
		t.Fatal("expected non-success pump response to fail")
	}
}

func TestWorkerPumpClientBoundsAStalledCall(t *testing.T) {
	handlerDone := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		// Keep the handler open long enough to prove the client deadline, but
		// always return so httptest.Server can shut down cleanly.
		defer close(handlerDone)
		select {
		case <-request.Context().Done():
		case <-time.After(500 * time.Millisecond):
		}
	}))
	defer server.Close()

	client, err := NewWorkerPumpClientWithTimeout(server.Client(), server.URL+"/internal/pump", 50*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if err := client.Pump(context.Background()); err == nil {
		t.Fatal("expected stalled pump call to fail")
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("stalled pump call exceeded bound: %s", elapsed)
	}
	<-handlerDone
}

func TestWorkerPumpClientRejectsNonPositiveTimeout(t *testing.T) {
	if _, err := NewWorkerPumpClientWithTimeout(http.DefaultClient, "https://worker.invalid/internal/pump", 0); err == nil {
		t.Fatal("expected non-positive pump timeout to fail")
	}
}

func TestWorkerPumpClientSendsJSONPOST(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("request method=%s content-type=%q", request.Method, request.Header.Get("Content-Type"))
		}
		if request.Header.Get(traceHeader) != "razorpay:event_test_4" {
			t.Fatalf("trace header=%q", request.Header.Get(traceHeader))
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	client, err := NewWorkerPumpClient(server.Client(), server.URL+"/internal/pump")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Pump(withTraceID(context.Background(), traceForProviderEvent("event_test_4"))); err != nil {
		t.Fatal(err)
	}
}

func TestPaymentHandlerAndWorkerPumpBoundary(t *testing.T) {
	var workerCalls int
	worker := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		workerCalls++
		if request.Method != http.MethodPost || request.URL.Path != "/internal/pump" {
			t.Fatalf("worker request=%s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("worker content-type=%q", request.Header.Get("Content-Type"))
		}
		if request.Header.Get(traceHeader) != "razorpay:event_boundary_1" {
			t.Fatalf("worker trace=%q", request.Header.Get(traceHeader))
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer worker.Close()

	pumper, err := NewWorkerPumpClient(worker.Client(), worker.URL+"/internal/pump")
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeStore{}
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(
		recorder,
		request(`{"event":"payment.captured"}`, "secret", "event_boundary_1"),
	)

	if recorder.Code != http.StatusOK || workerCalls != 1 || store.calls != 1 {
		t.Fatalf("status=%d worker_calls=%d store_calls=%d", recorder.Code, workerCalls, store.calls)
	}
}

func TestPaymentHandlerReturnsRetryableWhenWorkerBoundaryFails(t *testing.T) {
	worker := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer worker.Close()

	pumper, err := NewWorkerPumpClient(worker.Client(), worker.URL+"/internal/pump")
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeStore{}
	recorder := httptest.NewRecorder()
	Handler{Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(
		recorder,
		request(`{"event":"payment.captured"}`, "secret", "event_boundary_2"),
	)

	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("Retry-After") != "5" || store.calls != 1 {
		t.Fatalf("status=%d retry-after=%q store_calls=%d", recorder.Code, recorder.Header().Get("Retry-After"), store.calls)
	}
}
