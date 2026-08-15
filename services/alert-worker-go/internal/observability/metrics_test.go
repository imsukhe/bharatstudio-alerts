package observability

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMetricsAreAuthenticatedAndRedacted(t *testing.T) {
	m := New()
	m.Observe(http.MethodPost, "/internal/v1/tasks/overlay?delivery=secret", http.StatusAccepted, 2*time.Millisecond)
	endpoint := m.Endpoint(func(request *http.Request) error {
		if request.Header.Get("Authorization") != "Bearer internal" {
			return errors.New("unauthorized")
		}
		return nil
	})
	unauthorized := httptest.NewRecorder()
	endpoint.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/internal/metrics", nil))
	if unauthorized.Code != http.StatusUnauthorized || strings.Contains(unauthorized.Body.String(), "bsa_worker_requests_total") {
		t.Fatalf("unauthorized metrics response leaked data: status=%d body=%q", unauthorized.Code, unauthorized.Body.String())
	}
	authorizedRequest := httptest.NewRequest(http.MethodGet, "/internal/metrics", nil)
	authorizedRequest.Header.Set("Authorization", "Bearer internal")
	authorized := httptest.NewRecorder()
	endpoint.ServeHTTP(authorized, authorizedRequest)
	body := authorized.Body.String()
	if !strings.Contains(body, `route="/internal/v1/tasks/overlay"`) {
		t.Fatalf("normalized route missing: %q", body)
	}
	if strings.Contains(body, "00000000-0000-4000-8000-000000000001") || strings.Contains(body, "Authorization") {
		t.Fatalf("metrics exposed a request identifier or header: %q", body)
	}
}

func TestInstrumentDefaultsSuccessfulStatus(t *testing.T) {
	m := New()
	handler := Instrument(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) }), m)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d", response.Code)
	}
}

func TestUnknownPathsUseOneBoundedBucket(t *testing.T) {
	m := New()
	m.Observe(http.MethodGet, "/attacker/random-path-one", http.StatusNotFound, time.Millisecond)
	m.Observe(http.MethodGet, "/attacker/random-path-two", http.StatusNotFound, time.Millisecond)
	var output strings.Builder
	m.WritePrometheus(&output)
	if strings.Count(output.String(), `route="/_other"`) != 2 {
		t.Fatalf("unknown routes were not collapsed: %q", output.String())
	}
}

func TestBusinessMetricsUseBoundedOutcomeLabels(t *testing.T) {
	m := New()
	m.ObserveTaskOutcome("accepted")
	m.ObserveTaskOutcome("delivery-id-secret")
	m.ObservePumpOutcome("partial")
	m.ObservePumpOutcome("queue-id-secret")
	var output strings.Builder
	m.WritePrometheus(&output)
	body := output.String()
	if !strings.Contains(body, `bsa_worker_business_total{kind="task",outcome="accepted"} 1`) {
		t.Fatalf("accepted task outcome missing: %q", body)
	}
	if !strings.Contains(body, `bsa_worker_business_total{kind="pump",outcome="partial"} 1`) {
		t.Fatalf("partial pump outcome missing: %q", body)
	}
	if strings.Contains(body, "delivery-id-secret") || strings.Contains(body, "queue-id-secret") {
		t.Fatalf("unbounded business label leaked: %q", body)
	}
}
