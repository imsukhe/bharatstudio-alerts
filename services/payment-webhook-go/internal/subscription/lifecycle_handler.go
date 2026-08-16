package subscription

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/provider"
)

// LifecycleExecutor is the subset of LifecycleService this handler drives.
// The TS control API has already authorized the caller and decided
// upgrade-vs-downgrade scheduling per the launch authority's pricing rules
// (upgrade takes effect now, downgrade at cycle end) before it reaches this
// internal boundary — this handler only routes the already-decided action.
type LifecycleExecutor interface {
	Cancel(context.Context, CancelRequest) (LifecycleRequest, error)
	ChangePlan(context.Context, ChangePlanRequest, bool) (LifecycleRequest, error)
	Reactivate(context.Context, ReactivateRequest) (LifecycleRequest, error)
}

type LifecycleHTTPHandler struct {
	Authorizer   Authorizer
	Service      LifecycleExecutor
	Environment  string
	MaxBodyBytes int64
}

type lifecycleRequestBody struct {
	Action          string `json:"action"`
	UserID          string `json:"userId"`
	ChannelID       string `json:"channelId"`
	Environment     string `json:"environment"`
	IdempotencyKey  string `json:"idempotencyKey"`
	TargetTier      string `json:"targetTier,omitempty"`
	BillingInterval string `json:"billingInterval,omitempty"`
}

func (h LifecycleHTTPHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeSubscriptionJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	if h.Authorizer == nil || h.Service == nil || (h.Environment != "test" && h.Environment != "live") {
		writeSubscriptionJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "subscription_not_configured"})
		return
	}
	if err := h.Authorizer.Authorize(request); err != nil {
		writeSubscriptionJSON(response, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	limit := h.MaxBodyBytes
	if limit <= 0 {
		limit = maxSubscriptionBodyBytes
	}
	raw, err := readSubscriptionBody(request, limit)
	if err != nil {
		writeSubscriptionJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	var input lifecycleRequestBody
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeSubscriptionJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeSubscriptionJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	idempotencyKey := request.Header.Get("Idempotency-Key")
	if idempotencyKey != input.IdempotencyKey || !idempotencyKeyPattern.MatchString(idempotencyKey) {
		writeSubscriptionJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_idempotency_key"})
		return
	}
	if !uuidPattern.MatchString(input.UserID) || !uuidPattern.MatchString(input.ChannelID) || input.Environment != h.Environment {
		writeSubscriptionJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}

	var (
		result  LifecycleRequest
		callErr error
	)
	switch input.Action {
	case "cancel":
		result, callErr = h.Service.Cancel(request.Context(), CancelRequest{
			ChannelID: input.ChannelID, UserID: input.UserID, Environment: input.Environment,
			IdempotencyKey: input.IdempotencyKey,
		})
	case "upgrade", "downgrade":
		if !validSubscriptionTier(input.TargetTier) || !validBillingInterval(input.BillingInterval) {
			writeSubscriptionJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
			return
		}
		result, callErr = h.Service.ChangePlan(request.Context(), ChangePlanRequest{
			ChannelID: input.ChannelID, UserID: input.UserID, Environment: input.Environment,
			IdempotencyKey: input.IdempotencyKey, TargetTier: input.TargetTier, BillingInterval: input.BillingInterval,
		}, input.Action == "downgrade")
	case "reactivate":
		result, callErr = h.Service.Reactivate(request.Context(), ReactivateRequest{
			ChannelID: input.ChannelID, UserID: input.UserID, Environment: input.Environment,
			IdempotencyKey: input.IdempotencyKey,
		})
	default:
		writeSubscriptionJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_action"})
		return
	}

	if callErr != nil {
		status, code := lifecycleErrorStatus(callErr)
		if status == http.StatusBadGateway || status == http.StatusServiceUnavailable {
			response.Header().Set("Retry-After", "5")
		}
		writeSubscriptionJSON(response, status, map[string]string{"error": code})
		return
	}
	writeSubscriptionJSON(response, http.StatusOK, map[string]any{
		"schemaVersion": "v1", "action": input.Action,
		"requestId": result.ID, "status": result.Status, "replay": result.Replay,
	})
}

func lifecycleErrorStatus(err error) (int, string) {
	var providerErr *provider.ProviderError
	switch {
	case errors.Is(err, ErrInvalidRequest):
		return http.StatusBadRequest, "invalid_request"
	case errors.Is(err, ErrNoActiveSubscription):
		return http.StatusNotFound, "no_active_subscription"
	case errors.Is(err, ErrNotConfigured):
		return http.StatusServiceUnavailable, "subscription_not_configured"
	case errors.Is(err, ErrLifecyclePersistence):
		return http.StatusServiceUnavailable, "subscription_lifecycle_unavailable"
	case errors.As(err, &providerErr):
		if providerErr.Retryable {
			return http.StatusBadGateway, "provider_temporarily_unavailable"
		}
		return http.StatusBadGateway, "provider_rejected_request"
	default:
		return http.StatusServiceUnavailable, "subscription_lifecycle_unavailable"
	}
}
