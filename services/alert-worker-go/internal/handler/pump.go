package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/observability"
	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/tasks"
)

type PumpConfig struct {
	Authorizer  Authorizer
	Source      tasks.ReadyDeliverySource
	Enqueuer    tasks.CommandEnqueuer
	Now         func() time.Time
	Limit       int
	Concurrency int
	// Leaser and LeaseDuration coordinate concurrent dispatch runs (RT-05).
	// Leaser is optional; nil preserves the pre-RT-05 always-scan behaviour.
	Leaser        tasks.DispatchLeaser
	LeaseDuration time.Duration
	Metrics       *observability.Metrics
}

type PumpHandler struct {
	config PumpConfig
}

func NewPumpHandler(config PumpConfig) PumpHandler {
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.Limit <= 0 {
		config.Limit = 100
	}
	if config.Concurrency <= 0 {
		config.Concurrency = 8
	}
	return PumpHandler{config: config}
}

func (h PumpHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	if h.config.Authorizer == nil || h.config.Source == nil || h.config.Enqueuer == nil {
		h.config.Metrics.ObservePumpOutcome("not_configured")
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "pump_not_configured"})
		return
	}
	if err := h.config.Authorizer.Authorize(request); err != nil {
		h.config.Metrics.ObservePumpOutcome("unauthorized")
		writeJSON(response, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	summary, err := (tasks.Pump{
		Source:        h.config.Source,
		Enqueuer:      h.config.Enqueuer,
		Now:           h.config.Now,
		Concurrency:   h.config.Concurrency,
		Leaser:        h.config.Leaser,
		LeaseDuration: h.config.LeaseDuration,
	}).RunOnce(request.Context(), h.config.Limit)
	if err != nil {
		if errors.Is(err, tasks.ErrInvalidPumpLimit) {
			h.config.Metrics.ObservePumpOutcome("invalid")
		} else {
			h.config.Metrics.ObservePumpOutcome("retryable")
		}
		response.Header().Set("Retry-After", "5")
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "pump_retryable"})
		return
	}
	if summary.Skipped {
		// RT-05: another dispatch run already holds the lease. This is a
		// normal, idempotent no-op -- not a failure -- so the response
		// stays 200 and the scheduler/wake-up caller must not retry it as
		// an error.
		h.config.Metrics.ObservePumpOutcome("skipped")
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(response).Encode(summary)
		return
	}
	if summary.Failed > 0 {
		h.config.Metrics.ObservePumpOutcome("partial")
	} else {
		h.config.Metrics.ObservePumpOutcome("completed")
	}
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(response).Encode(summary)
}
