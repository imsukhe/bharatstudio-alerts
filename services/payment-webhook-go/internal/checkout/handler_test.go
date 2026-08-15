package checkout

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeCheckoutAuthorizer struct{ err error }

func (a fakeCheckoutAuthorizer) Authorize(*http.Request) error { return a.err }

type fakeOrderCreator struct {
	request IntentRequest
	result  Intent
	err     error
}

func (s *fakeOrderCreator) CreateOrder(_ context.Context, request IntentRequest) (Intent, error) {
	s.request = request
	return s.result, s.err
}

func validCheckoutBody() string {
	return validCheckoutBodyAt(time.Now().Add(10 * time.Minute))
}

func validCheckoutBodyAt(expiry time.Time) string {
	return fmt.Sprintf(`{"intentId":"00000000-0000-4000-8000-000000000091","channelId":"00000000-0000-4000-8000-000000000011","environment":"test","idempotencyKey":"synthetic-idempotency-001","receipt":"bsa_abc","amountPaise":1000,"currency":"INR","donorDisplayName":"Viewer","message":"Hello","alertConsent":true,"expiresAt":"%s"}`, expiry.UTC().Format(time.RFC3339))
}

func TestHTTPHandlerRequiresPrivateAuthorizationAndHeaderBodyIdempotencyMatch(t *testing.T) {
	service := &fakeOrderCreator{}
	handler := HTTPHandler{Authorizer: fakeCheckoutAuthorizer{}, Service: service, Environment: "test"}
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/tips/orders", strings.NewReader(validCheckoutBody()))
	request.Header.Set("Idempotency-Key", "different-idempotency")
	request.Header.Set("X-BSA-Trace-Id", "api-request")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/internal/v1/tips/orders", strings.NewReader(validCheckoutBody()))
	request.Header.Set("Idempotency-Key", "synthetic-idempotency-001")
	request.Header.Set("X-BSA-Trace-Id", "api-request")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if service.request.ChannelID == "" || service.request.Environment != "test" {
		t.Fatalf("service request=%#v", service.request)
	}
	if service.request.TraceID != "api-request" {
		t.Fatalf("trace id=%q", service.request.TraceID)
	}

	request = httptest.NewRequest(http.MethodPost, "/internal/v1/tips/orders", strings.NewReader(strings.Replace(validCheckoutBody(), "synthetic-idempotency-001", "unsafe key with spaces", 1)))
	request.Header.Set("Idempotency-Key", "unsafe key with spaces")
	request.Header.Set("X-BSA-Trace-Id", "api-request")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || service.request.IdempotencyKey != "synthetic-idempotency-001" {
		t.Fatalf("unsafe key status=%d service=%#v", response.Code, service.request)
	}
}

func TestHTTPHandlerMapsRetryableAndProviderMismatchErrorsWithoutLeak(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{name: "in progress", err: ErrOrderCreationInProgress, status: http.StatusConflict, code: "order_creation_in_progress"},
		{name: "provider mismatch", err: ErrProviderOrderMismatch, status: http.StatusBadGateway, code: "provider_order_mismatch"},
		{name: "generic", err: errors.New("secret provider response"), status: http.StatusServiceUnavailable, code: "payment_unavailable"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			service := &fakeOrderCreator{err: testCase.err}
			handler := HTTPHandler{Authorizer: fakeCheckoutAuthorizer{}, Service: service, Environment: "test"}
			request := httptest.NewRequest(http.MethodPost, "/internal/v1/tips/orders", strings.NewReader(validCheckoutBody()))
			request.Header.Set("Idempotency-Key", "synthetic-idempotency-001")
			request.Header.Set("X-BSA-Trace-Id", "api-request")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != testCase.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			var body map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["error"] != testCase.code || strings.Contains(response.Body.String(), "secret") {
				t.Fatalf("body=%s", response.Body.String())
			}
		})
	}
}

func TestHTTPHandlerRejectsExpiredRequestAtServiceBoundary(t *testing.T) {
	service := &fakeOrderCreator{result: Intent{ID: "intent-1", AmountPaise: 1000, Currency: "INR", ProviderOrderID: "order-1"}}
	handler := HTTPHandler{Authorizer: fakeCheckoutAuthorizer{}, Service: service, Environment: "test"}
	body := validCheckoutBodyAt(time.Date(2020, time.August, 14, 10, 0, 0, 0, time.UTC))
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/tips/orders", strings.NewReader(body))
	request.Header.Set("Idempotency-Key", "synthetic-idempotency-001")
	request.Header.Set("X-BSA-Trace-Id", "api-request")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if !service.request.ExpiresAt.Equal(time.Time{}) {
		t.Fatal("expired request reached service")
	}
}

func TestHTTPHandlerRejectsCheckoutLifetimeBeyondPlatformMaximum(t *testing.T) {
	service := &fakeOrderCreator{result: Intent{ID: "intent-1", AmountPaise: 1000, Currency: "INR", ProviderOrderID: "order-1"}}
	handler := HTTPHandler{Authorizer: fakeCheckoutAuthorizer{}, Service: service, Environment: "test"}
	body := validCheckoutBodyAt(time.Now().Add(maxCheckoutLifetime + time.Minute))
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/tips/orders", strings.NewReader(body))
	request.Header.Set("Idempotency-Key", "synthetic-idempotency-001")
	request.Header.Set("X-BSA-Trace-Id", "api-request")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if !service.request.ExpiresAt.Equal(time.Time{}) {
		t.Fatal("overlong expiry reached service")
	}
}
