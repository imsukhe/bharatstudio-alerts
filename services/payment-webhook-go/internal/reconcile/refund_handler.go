package reconcile

import (
	"encoding/json"
	"net/http"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/observability"
)

type RefundHTTPHandler struct {
	Authorizer Authorizer
	Runner     RefundRunner
	Limit      int
	Metrics    *observability.Metrics
}

func (h RefundHTTPHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	if h.Authorizer == nil || h.Runner.Store == nil || h.Runner.Provider == nil {
		h.Metrics.ObserveReconciliationOutcome("refund_reconciliation", "not_configured")
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "refund_reconciliation_not_configured"})
		return
	}
	if err := h.Authorizer.Authorize(request); err != nil {
		h.Metrics.ObserveReconciliationOutcome("refund_reconciliation", "unauthorized")
		writeJSON(response, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	limit := h.Limit
	if limit <= 0 {
		limit = 50
	}
	summary, err := h.Runner.RunOnce(request.Context(), limit)
	if err != nil {
		h.Metrics.ObserveReconciliationOutcome("refund_reconciliation", "retryable")
		response.Header().Set("Retry-After", "60")
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "refund_reconciliation_retryable"})
		return
	}
	h.Metrics.ObserveReconciliationOutcome("refund_reconciliation", "completed")
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(response).Encode(summary)
}
