package subscription

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
)

const maxSubscriptionBodyBytes int64 = 16 << 10

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{16,128}$`)

type Authorizer interface {
	Authorize(*http.Request) error
}

type Creator interface {
	Create(context.Context, Request) (Intent, error)
}

type HTTPHandler struct {
	Authorizer   Authorizer
	Service      Creator
	Environment  string
	MaxBodyBytes int64
}

type createRequest struct {
	UserID          string `json:"userId"`
	ChannelID       string `json:"channelId"`
	Environment     string `json:"environment"`
	IdempotencyKey  string `json:"idempotencyKey"`
	Tier            string `json:"tier"`
	BillingInterval string `json:"billingInterval"`
}

func (h HTTPHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
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
	var input createRequest
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
	idempotencyKey := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if idempotencyKey != input.IdempotencyKey || !idempotencyKeyPattern.MatchString(idempotencyKey) {
		writeSubscriptionJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_idempotency_key"})
		return
	}
	if !uuidPattern.MatchString(input.UserID) || !uuidPattern.MatchString(input.ChannelID) || input.Environment != h.Environment || !validSubscriptionTier(input.Tier) || !validBillingInterval(input.BillingInterval) {
		writeSubscriptionJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	result, err := h.Service.Create(request.Context(), Request{
		UserID: input.UserID, ChannelID: input.ChannelID, Environment: input.Environment,
		IdempotencyKey: input.IdempotencyKey, Tier: input.Tier, BillingInterval: input.BillingInterval,
	})
	if err != nil {
		status, code := http.StatusServiceUnavailable, "subscription_unavailable"
		switch {
		case errors.Is(err, ErrInvalidRequest):
			status, code = http.StatusBadRequest, "invalid_request"
		case errors.Is(err, ErrInProgress):
			status, code = http.StatusConflict, "subscription_creation_in_progress"
		case errors.Is(err, ErrProviderPlanMismatch):
			status, code = http.StatusBadGateway, "provider_subscription_mismatch"
		case errors.Is(err, ErrRecoveryRequired):
			status, code = http.StatusConflict, "subscription_recovery_required"
		}
		response.Header().Set("Retry-After", "5")
		writeSubscriptionJSON(response, status, map[string]string{"error": code})
		return
	}
	status := "pending"
	if result.Status == "linked" {
		status = "linked"
	}
	// chargedMonths/serviceMonths/annualChargePaise must match the same
	// per-interval relationship the database enforces (packages/db/
	// migrations/0048's CHECK constraint: monthly -> 1/1, annual -> 10/12)
	// — a monthly subscription is charged its monthly price for one
	// month of service, never a hardcoded 10-months-for-12 annual
	// discount. This handler previously always reported the annual
	// shape regardless of the requested interval, which both
	// misrepresented what a monthly subscriber was actually being
	// charged and failed the equally-strict apps/api and apps/web
	// validators once those were corrected to check per interval —
	// breaking the "Subscribe" button apps/web's own UI always calls
	// with billingInterval "monthly".
	chargedMonths, serviceMonths := 1, 1
	if result.BillingInterval == "annual" {
		chargedMonths, serviceMonths = 10, 12
	}
	writeSubscriptionJSON(response, http.StatusCreated, map[string]any{
		"schemaVersion": "v1", "provider": "razorpay", "status": status,
		"subscriptionId": result.ProviderSubscriptionID, "tier": result.Tier,
		"billingInterval": result.BillingInterval, "monthlyPricePaise": result.PricePaise,
		"annualChargePaise": result.PricePaise * int64(chargedMonths), "annualMonthsCharged": chargedMonths,
		"annualServiceMonths": serviceMonths,
		"checkoutUrl":         nullableSubscriptionURL(result.CheckoutURL),
	})
}

func nullableSubscriptionURL(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func validSubscriptionTier(value string) bool {
	return value == "pro" || value == "creator" || value == "studio"
}

func validBillingInterval(value string) bool {
	return value == "monthly" || value == "annual"
}

func readSubscriptionBody(request *http.Request, limit int64) ([]byte, error) {
	if request.Body == nil {
		return nil, errors.New("missing body")
	}
	data := make([]byte, 0, 4096)
	buffer := make([]byte, 4096)
	for int64(len(data)) <= limit {
		count, err := request.Body.Read(buffer)
		if count > 0 {
			data = append(data, buffer[:count]...)
			if int64(len(data)) > limit {
				return nil, errors.New("body too large")
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return data, nil
			}
			return nil, err
		}
	}
	return nil, errors.New("body too large")
}

func writeSubscriptionJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
