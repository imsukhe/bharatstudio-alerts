package reconcile

import (
	"encoding/json"
	"net/http"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/observability"
)

// Authorizer is injected so the private scheduler boundary can be tested
// without credentials. The deployed route must use Google OIDC verification.
type Authorizer interface {
	Authorize(*http.Request) error
}

// HTTPHandler runs one bounded reconciliation pass. It deliberately treats a
// partial run as retryable: candidates remain durable and the scheduler can
// retry without the handler claiming provider work it did not finish.
type HTTPHandler struct {
	Authorizer Authorizer
	Runner     Runner
	Limit      int
	Metrics    *observability.Metrics
}

func (h HTTPHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	if h.Authorizer == nil || h.Runner.Store == nil || h.Runner.Provider == nil {
		h.Metrics.ObserveReconciliationOutcome("payment_reconciliation", "not_configured")
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "reconciliation_not_configured"})
		return
	}
	if err := h.Authorizer.Authorize(request); err != nil {
		h.Metrics.ObserveReconciliationOutcome("payment_reconciliation", "unauthorized")
		writeJSON(response, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	limit := h.Limit
	if limit <= 0 {
		limit = 50
	}
	summary, err := h.Runner.RunOnce(request.Context(), limit)
	if err != nil {
		h.Metrics.ObserveReconciliationOutcome("payment_reconciliation", "retryable")
		response.Header().Set("Retry-After", "30")
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "reconciliation_retryable"})
		return
	}
	h.Metrics.ObserveReconciliationOutcome("payment_reconciliation", "completed")
	writeJSON(response, http.StatusOK, summary)
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
