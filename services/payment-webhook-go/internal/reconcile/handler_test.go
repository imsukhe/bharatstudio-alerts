package reconcile

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

type fakeReconcileAuthorizer struct{ allowed bool }

func (a fakeReconcileAuthorizer) Authorize(*http.Request) error {
	if !a.allowed {
		return errors.New("unauthorized")
	}
	return nil
}

type fakeReconcileStore struct{}

func (fakeReconcileStore) ListCandidates(context.Context, int) ([]Candidate, error) {
	return nil, nil
}
func (fakeReconcileStore) ExpireLocalIntent(context.Context, string, string) (bool, error) {
	return false, nil
}
func (fakeReconcileStore) QueuePaymentRecovery(context.Context, string, string, time.Time) (bool, error) {
	return false, nil
}

type fakeReconcileProvider struct{}

func (fakeReconcileProvider) FetchOrderForAccount(context.Context, string, string) (provider.Order, error) {
	return provider.Order{}, nil
}

func TestHTTPHandlerRejectsUnauthorizedRequest(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/reconciliation/payments", strings.NewReader("{}"))
	response := httptest.NewRecorder()
	HTTPHandler{Authorizer: fakeReconcileAuthorizer{}, Runner: Runner{Store: fakeReconcileStore{}, Provider: fakeReconcileProvider{}}}.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestHTTPHandlerRunsBoundedPass(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/reconciliation/payments", strings.NewReader("{}"))
	response := httptest.NewRecorder()
	HTTPHandler{Authorizer: fakeReconcileAuthorizer{allowed: true}, Runner: Runner{Store: fakeReconcileStore{}, Provider: fakeReconcileProvider{}}}.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "candidates") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
