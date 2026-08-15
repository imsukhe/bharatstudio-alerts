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
	m.Observe(http.MethodPost, "/v1/webhooks/razorpay?token=secret", http.StatusAccepted, 2*time.Millisecond)
	endpoint := m.Endpoint(func(request *http.Request) error {
		if request.Header.Get("Authorization") != "Bearer internal" {
			return errors.New("unauthorized")
		}
		return nil
	})
	unauthorized := httptest.NewRecorder()
	endpoint.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/internal/metrics", nil))
	if unauthorized.Code != http.StatusUnauthorized || strings.Contains(unauthorized.Body.String(), "bsa_payment_requests_total") {
		t.Fatalf("unauthorized metrics response leaked data: status=%d body=%q", unauthorized.Code, unauthorized.Body.String())
	}
	authorizedRequest := httptest.NewRequest(http.MethodGet, "/internal/metrics", nil)
	authorizedRequest.Header.Set("Authorization", "Bearer internal")
	authorized := httptest.NewRecorder()
	endpoint.ServeHTTP(authorized, authorizedRequest)
	body := authorized.Body.String()
	if !strings.Contains(body, `route="/v1/webhooks/razorpay"`) {
		t.Fatalf("normalized route missing: %q", body)
	}
	if strings.Contains(body, "00000000-0000-4000-8000-000000000001") || strings.Contains(body, "token=secret") || strings.Contains(body, "Authorization") {
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

func TestCheckoutRouteRemainsActionableAfterNormalization(t *testing.T) {
	m := New()
	m.Observe(http.MethodPost, "/internal/v1/tips/orders?trace=synthetic", http.StatusCreated, time.Millisecond)
	var output strings.Builder
	m.WritePrometheus(&output)
	if !strings.Contains(output.String(), `route="/internal/v1/tips/orders"`) {
		t.Fatalf("checkout route was collapsed into an unknown bucket: %q", output.String())
	}
}

func TestWebhookBusinessMetricsUseBoundedOutcomeLabels(t *testing.T) {
	m := New()
	m.ObserveWebhookOutcome("accepted")
	m.ObserveWebhookOutcome("quarantined")
	m.ObserveWebhookOutcome("provider-event-id-secret")
	var output strings.Builder
	m.WritePrometheus(&output)
	body := output.String()
	if !strings.Contains(body, `bsa_payment_business_total{kind="webhook",outcome="accepted"} 1`) {
		t.Fatalf("accepted webhook outcome missing: %q", body)
	}
	if !strings.Contains(body, `bsa_payment_business_total{kind="webhook",outcome="quarantined"} 1`) {
		t.Fatalf("quarantined webhook outcome missing: %q", body)
	}
	if strings.Contains(body, "provider-event-id-secret") {
		t.Fatalf("provider identifier leaked into metric labels: %q", body)
	}
}

func TestPaymentBusinessMetricsKeepKindsAndOutcomesBounded(t *testing.T) {
	m := New()
	m.ObserveCheckoutOutcome("accepted")
	m.ObserveReconciliationOutcome("payment_reconciliation", "retryable")
	m.ObserveReconciliationOutcome("refund_reconciliation", "completed")
	m.ObserveReconciliationOutcome("secret-kind", "secret-outcome")
	var output strings.Builder
	m.WritePrometheus(&output)
	body := output.String()
	for _, expected := range []string{
		`kind="checkout",outcome="accepted"`,
		`kind="payment_reconciliation",outcome="retryable"`,
		`kind="refund_reconciliation",outcome="completed"`,
		`kind="reconciliation",outcome="other"`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("missing bounded business metric %q: %s", expected, body)
		}
	}
	if strings.Contains(body, "secret-kind") || strings.Contains(body, "secret-outcome") {
		t.Fatalf("unbounded business metric label leaked: %q", body)
	}
}
