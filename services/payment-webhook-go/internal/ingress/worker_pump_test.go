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
	workerCalled := make(chan struct{}, 1)
	worker := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/internal/pump" {
			t.Errorf("worker request=%s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Content-Type") != "application/json" {
			t.Errorf("worker content-type=%q", request.Header.Get("Content-Type"))
		}
		if request.Header.Get(traceHeader) != "razorpay:event_boundary_1" {
			t.Errorf("worker trace=%q", request.Header.Get(traceHeader))
		}
		response.WriteHeader(http.StatusOK)
		workerCalled <- struct{}{}
	}))
	defer worker.Close()

	pumper, err := NewWorkerPumpClient(worker.Client(), worker.URL+"/internal/pump")
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeStore{}
	recorder := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(
		recorder,
		request(`{"event":"payment.captured"}`, "secret", "event_boundary_1"),
	)

	if recorder.Code != http.StatusOK || store.calls != 1 {
		t.Fatalf("status=%d store_calls=%d", recorder.Code, store.calls)
	}
	select {
	case <-workerCalled:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the fire-and-forget wake-up to reach the worker")
	}
}

// RT-04.1: a worker boundary failure is a dispatch problem, not a commit
// problem. The commit already succeeded, so the response stays 2xx --
// superseding the pre-RT-04 behaviour where this same scenario returned 503
// and asked the provider to retry an already-durable payment.
func TestPaymentHandlerAcknowledgesEvenWhenWorkerBoundaryFails(t *testing.T) {
	workerCalled := make(chan struct{}, 1)
	worker := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
		workerCalled <- struct{}{}
	}))
	defer worker.Close()

	pumper, err := NewWorkerPumpClient(worker.Client(), worker.URL+"/internal/pump")
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeStore{}
	recorder := httptest.NewRecorder()
	Handler{Wakeups: NewWakeupCoalescer(), Secret: "secret", Store: store, Pumper: pumper}.ServeHTTP(
		recorder,
		request(`{"event":"payment.captured"}`, "secret", "event_boundary_2"),
	)

	if recorder.Code != http.StatusOK || recorder.Body.String() != "{\"status\":\"accepted\"}\n" || store.calls != 1 {
		t.Fatalf("status=%d body=%q store_calls=%d", recorder.Code, recorder.Body.String(), store.calls)
	}
	select {
	case <-workerCalled:
	case <-time.After(2 * time.Second):
		t.Fatal("worker pump was never attempted despite a durable commit")
	}
}
