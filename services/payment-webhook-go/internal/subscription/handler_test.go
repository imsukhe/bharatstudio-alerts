package subscription

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeSubscriptionAuthorizer struct{ err error }

func (a fakeSubscriptionAuthorizer) Authorize(*http.Request) error { return a.err }

type fakeSubscriptionCreator struct {
	request Request
	result  Intent
	err     error
}

func (s *fakeSubscriptionCreator) Create(_ context.Context, request Request) (Intent, error) {
	s.request = request
	return s.result, s.err
}

const validSubscriptionBody = `{"userId":"00000000-0000-4000-8000-000000000001","channelId":"00000000-0000-4000-8000-000000000002","environment":"test","idempotencyKey":"subscription-idempotency-001","tier":"creator","billingInterval":"monthly"}`

func newSubscriptionRequest(body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/subscriptions", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer test")
	request.Header.Set("Idempotency-Key", "subscription-idempotency-001")
	return request
}

func TestSubscriptionHandlerValidatesPrivateBoundaryAndReturnsSafeProjection(t *testing.T) {
	service := &fakeSubscriptionCreator{result: Intent{ProviderSubscriptionID: "sub_1", Tier: "creator", BillingInterval: "monthly", PricePaise: 39900, Status: "linked", CheckoutURL: "https://rzp.io/i/test"}}
	handler := HTTPHandler{Authorizer: fakeSubscriptionAuthorizer{}, Service: service, Environment: "test"}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, newSubscriptionRequest(validSubscriptionBody))
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["provider"] != "razorpay" || body["status"] != "linked" || body["monthlyPricePaise"] != float64(39900) || body["annualChargePaise"] != float64(399000) || service.request.ChannelID == "" {
		t.Fatalf("response=%#v request=%#v", body, service.request)
	}
}

func TestSubscriptionHandlerRejectsHeaderBodyMismatchAndUnknownFields(t *testing.T) {
	service := &fakeSubscriptionCreator{}
	handler := HTTPHandler{Authorizer: fakeSubscriptionAuthorizer{}, Service: service, Environment: "test"}
	request := newSubscriptionRequest(strings.Replace(validSubscriptionBody, "subscription-idempotency-001", "different-idempotency", 1))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || service.request.ChannelID != "" {
		t.Fatalf("mismatch status=%d body=%s", response.Code, response.Body.String())
	}
	request = newSubscriptionRequest(strings.TrimSuffix(validSubscriptionBody, "}") + `,"providerPlanId":"attacker-controlled"}`)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status=%d body=%s", response.Code, response.Body.String())
	}
	request = newSubscriptionRequest(strings.Replace(validSubscriptionBody, "subscription-idempotency-001", "unsafe key with spaces", 1))
	request.Header.Set("Idempotency-Key", "unsafe key with spaces")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || service.request.ChannelID != "" {
		t.Fatalf("unsafe key status=%d service=%#v", response.Code, service.request)
	}
}

func TestSubscriptionHandlerMapsRecoveryWithoutLeakingProviderError(t *testing.T) {
	service := &fakeSubscriptionCreator{err: errors.New("provider credentials must not leave this boundary")}
	handler := HTTPHandler{Authorizer: fakeSubscriptionAuthorizer{}, Service: service, Environment: "test"}
	request := newSubscriptionRequest(validSubscriptionBody)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), "credentials") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
