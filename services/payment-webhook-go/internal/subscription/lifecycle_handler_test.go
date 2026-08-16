package subscription

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

type fakeLifecycleExecutor struct {
	cancelRequest     CancelRequest
	changePlanRequest ChangePlanRequest
	scheduleAtEnd     bool
	reactivateRequest ReactivateRequest
	result            LifecycleRequest
	err               error
}

func (e *fakeLifecycleExecutor) Cancel(_ context.Context, request CancelRequest) (LifecycleRequest, error) {
	e.cancelRequest = request
	return e.result, e.err
}

func (e *fakeLifecycleExecutor) ChangePlan(_ context.Context, request ChangePlanRequest, scheduleAtCycleEnd bool) (LifecycleRequest, error) {
	e.changePlanRequest, e.scheduleAtEnd = request, scheduleAtCycleEnd
	return e.result, e.err
}

func (e *fakeLifecycleExecutor) Reactivate(_ context.Context, request ReactivateRequest) (LifecycleRequest, error) {
	e.reactivateRequest = request
	return e.result, e.err
}

const validLifecycleBodyTemplate = `{"action":"%s","userId":"00000000-0000-4000-8000-000000000001","channelId":"00000000-0000-4000-8000-000000000002","environment":"test","idempotencyKey":"lifecycle-idempotency-001"%s}`

func newLifecycleRequest(body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/subscriptions/lifecycle", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer test")
	request.Header.Set("Idempotency-Key", "lifecycle-idempotency-001")
	return request
}

func TestLifecycleHandlerCancelRoutesToExecutor(t *testing.T) {
	executor := &fakeLifecycleExecutor{result: LifecycleRequest{ID: "req-1", Status: "provider_confirmed"}}
	handler := LifecycleHTTPHandler{Authorizer: fakeSubscriptionAuthorizer{}, Service: executor, Environment: "test"}
	response := httptest.NewRecorder()
	body := fmtLifecycleBody("cancel", "")
	handler.ServeHTTP(response, newLifecycleRequest(body))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if executor.cancelRequest.ChannelID == "" || executor.cancelRequest.IdempotencyKey != "lifecycle-idempotency-001" {
		t.Fatalf("cancel request not forwarded: %#v", executor.cancelRequest)
	}
	var parsed map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["status"] != "provider_confirmed" || parsed["requestId"] != "req-1" {
		t.Fatalf("response=%#v", parsed)
	}
}

func TestLifecycleHandlerUpgradeAndDowngradeScheduling(t *testing.T) {
	executor := &fakeLifecycleExecutor{result: LifecycleRequest{ID: "req-2", Status: "provider_confirmed"}}
	handler := LifecycleHTTPHandler{Authorizer: fakeSubscriptionAuthorizer{}, Service: executor, Environment: "test"}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, newLifecycleRequest(fmtLifecycleBody("upgrade", `,"targetTier":"studio","billingInterval":"monthly"`)))
	if response.Code != http.StatusOK || executor.scheduleAtEnd || executor.changePlanRequest.TargetTier != "studio" {
		t.Fatalf("upgrade status=%d scheduleAtEnd=%v request=%#v", response.Code, executor.scheduleAtEnd, executor.changePlanRequest)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, newLifecycleRequest(fmtLifecycleBody("downgrade", `,"targetTier":"pro","billingInterval":"monthly"`)))
	if response.Code != http.StatusOK || !executor.scheduleAtEnd || executor.changePlanRequest.TargetTier != "pro" {
		t.Fatalf("downgrade status=%d scheduleAtEnd=%v request=%#v", response.Code, executor.scheduleAtEnd, executor.changePlanRequest)
	}
}

func TestLifecycleHandlerChangePlanRequiresValidTierAndInterval(t *testing.T) {
	executor := &fakeLifecycleExecutor{}
	handler := LifecycleHTTPHandler{Authorizer: fakeSubscriptionAuthorizer{}, Service: executor, Environment: "test"}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, newLifecycleRequest(fmtLifecycleBody("upgrade", `,"targetTier":"enterprise","billingInterval":"monthly"`)))
	if response.Code != http.StatusBadRequest || executor.changePlanRequest.ChannelID != "" {
		t.Fatalf("invalid tier status=%d request=%#v", response.Code, executor.changePlanRequest)
	}
}

func TestLifecycleHandlerReactivateRoutesToExecutor(t *testing.T) {
	executor := &fakeLifecycleExecutor{result: LifecycleRequest{ID: "req-3", Status: "provider_confirmed"}}
	handler := LifecycleHTTPHandler{Authorizer: fakeSubscriptionAuthorizer{}, Service: executor, Environment: "test"}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, newLifecycleRequest(fmtLifecycleBody("reactivate", "")))
	if response.Code != http.StatusOK || executor.reactivateRequest.ChannelID == "" {
		t.Fatalf("reactivate status=%d request=%#v", response.Code, executor.reactivateRequest)
	}
}

func TestLifecycleHandlerRejectsUnknownAction(t *testing.T) {
	executor := &fakeLifecycleExecutor{}
	handler := LifecycleHTTPHandler{Authorizer: fakeSubscriptionAuthorizer{}, Service: executor, Environment: "test"}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, newLifecycleRequest(fmtLifecycleBody("delete_forever", "")))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown action status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestLifecycleHandlerMapsErrorsWithoutLeakingProviderDetails(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
	}{
		{"invalid request", ErrInvalidRequest, http.StatusBadRequest},
		{"no active subscription", ErrNoActiveSubscription, http.StatusNotFound},
		{"not configured", ErrNotConfigured, http.StatusServiceUnavailable},
		{"provider retryable", &provider.ProviderError{Operation: "POST /v1/subscriptions/sub_1/cancel", StatusCode: 502, Retryable: true, Cause: errValueForTest}, http.StatusBadGateway},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			executor := &fakeLifecycleExecutor{err: testCase.err}
			handler := LifecycleHTTPHandler{Authorizer: fakeSubscriptionAuthorizer{}, Service: executor, Environment: "test"}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, newLifecycleRequest(fmtLifecycleBody("cancel", "")))
			if response.Code != testCase.wantStatus {
				t.Fatalf("status=%d want=%d body=%s", response.Code, testCase.wantStatus, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "razorpay_secret") {
				t.Fatalf("leaked provider detail: %s", response.Body.String())
			}
		})
	}
}

func TestLifecycleHandlerRejectsWhenUnauthorized(t *testing.T) {
	executor := &fakeLifecycleExecutor{}
	handler := LifecycleHTTPHandler{Authorizer: fakeSubscriptionAuthorizer{err: errValueForTest}, Service: executor, Environment: "test"}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, newLifecycleRequest(fmtLifecycleBody("cancel", "")))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func fmtLifecycleBody(action, extra string) string {
	return fmt.Sprintf(validLifecycleBodyTemplate, action, extra)
}

var errValueForTest = &lifecycleTestError{"authorization or provider failure"}

type lifecycleTestError struct{ message string }

func (e *lifecycleTestError) Error() string { return e.message }
