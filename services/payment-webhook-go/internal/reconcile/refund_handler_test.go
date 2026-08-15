package reconcile

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRefundHTTPHandlerRejectsUnauthorizedRequest(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/reconciliation/refunds", strings.NewReader("{}"))
	response := httptest.NewRecorder()
	RefundHTTPHandler{
		Authorizer: fakeReconcileAuthorizer{},
		Runner:     RefundRunner{Store: &fakeRefundStore{}, Provider: fakeRefundProvider{}},
	}.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRefundHTTPHandlerReturnsBoundedSummary(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/reconciliation/refunds", strings.NewReader("{}"))
	response := httptest.NewRecorder()
	RefundHTTPHandler{
		Authorizer: fakeReconcileAuthorizer{allowed: true},
		Runner:     RefundRunner{Store: &fakeRefundStore{}, Provider: fakeRefundProvider{}},
	}.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "candidates") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
