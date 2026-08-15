package observability

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReadinessHandler(t *testing.T) {
	tests := []struct {
		name   string
		ping   func(context.Context) error
		method string
		status int
		body   string
	}{
		{name: "ready", ping: func(context.Context) error { return nil }, method: http.MethodGet, status: http.StatusOK, body: `{"status":"ready"}`},
		{name: "database failure", ping: func(context.Context) error { return errors.New("database down") }, method: http.MethodGet, status: http.StatusServiceUnavailable, body: `{"status":"not_ready","reason":"database_unavailable"}`},
		{name: "method not allowed", ping: func(context.Context) error { return nil }, method: http.MethodPost, status: http.StatusMethodNotAllowed, body: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(test.method, "/readyz", nil)
			ReadinessHandler(func(ctx context.Context) error { return test.ping(ctx) }).ServeHTTP(recorder, request)
			if recorder.Code != test.status {
				t.Fatalf("status=%d want=%d", recorder.Code, test.status)
			}
			if recorder.Body.String() != test.body {
				t.Fatalf("body=%q want=%q", recorder.Body.String(), test.body)
			}
		})
	}
}
