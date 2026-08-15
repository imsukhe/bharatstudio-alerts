package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/tasks"
)

type pumpAuthorizer struct{ err error }

func (a pumpAuthorizer) Authorize(*http.Request) error { return a.err }

type pumpSource struct{}

func (pumpSource) ListReady(context.Context, int) ([]tasks.ReadyDelivery, error) {
	return []tasks.ReadyDelivery{{DeliveryID: "00000000-0000-4000-8000-000000000003", EventID: "00000000-0000-4000-8000-000000000001", OutboxID: "00000000-0000-4000-8000-000000000002", AttemptNumber: 1, StateVersion: 1, TraceID: "trace-1"}}, nil
}

type pumpEnqueuer struct {
	calls int
	err   error
}

func (e *pumpEnqueuer) Enqueue(context.Context, tasks.Command) error { e.calls++; return e.err }

func TestPumpHandlerRequiresAuthorization(t *testing.T) {
	handler := NewPumpHandler(PumpConfig{Authorizer: pumpAuthorizer{err: errors.New("no")}, Source: pumpSource{}, Enqueuer: &pumpEnqueuer{}})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/internal/pump", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", recorder.Code)
	}
}

func TestPumpHandlerRejectsNonPost(t *testing.T) {
	enqueuer := &pumpEnqueuer{}
	handler := NewPumpHandler(PumpConfig{Authorizer: pumpAuthorizer{}, Source: pumpSource{}, Enqueuer: enqueuer})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/internal/pump", nil))
	if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != http.MethodPost || enqueuer.calls != 0 {
		t.Fatalf("status=%d allow=%q enqueue_calls=%d", recorder.Code, recorder.Header().Get("Allow"), enqueuer.calls)
	}
}

func TestPumpHandlerReturnsRetryableOnPartialEnqueue(t *testing.T) {
	enqueuer := &pumpEnqueuer{err: errors.New("cloud tasks unavailable")}
	handler := NewPumpHandler(PumpConfig{Authorizer: pumpAuthorizer{}, Source: pumpSource{}, Enqueuer: enqueuer, Now: func() time.Time { return time.Unix(100, 0) }})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/internal/pump", nil)
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable || enqueuer.calls != 1 {
		t.Fatalf("status=%d enqueue_calls=%d", recorder.Code, enqueuer.calls)
	}
}

func TestPumpHandlerReturnsSummaryOnSuccess(t *testing.T) {
	enqueuer := &pumpEnqueuer{}
	handler := NewPumpHandler(PumpConfig{Authorizer: pumpAuthorizer{}, Source: pumpSource{}, Enqueuer: enqueuer, Now: func() time.Time { return time.Unix(100, 0) }})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/internal/pump", nil))
	if recorder.Code != http.StatusOK || enqueuer.calls != 1 {
		t.Fatalf("status=%d enqueue_calls=%d body=%q", recorder.Code, enqueuer.calls, recorder.Body.String())
	}
}
