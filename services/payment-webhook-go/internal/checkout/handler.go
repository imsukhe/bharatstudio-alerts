package checkout

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/observability"
)

const maxCheckoutBodyBytes int64 = 32 << 10

var idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{16,128}$`)

// The local checkout intent is valid for at most fifteen minutes. This is a
// BharatStudio boundary invariant; it is deliberately not sent as Razorpay's
// order `expire_by` field because Razorpay Orders do not support that field.
const maxCheckoutLifetime = 15 * time.Minute

// Authorizer is intentionally injected so the handler can use the same
// Google OIDC verification boundary in production and a deterministic fake in
// tests. The public API must call this handler through private service ingress.
type Authorizer interface {
	Authorize(*http.Request) error
}

type OrderCreator interface {
	CreateOrder(context.Context, IntentRequest) (Intent, error)
}

type HTTPHandler struct {
	Authorizer   Authorizer
	Service      OrderCreator
	Environment  string
	MaxBodyBytes int64
	Metrics      *observability.Metrics
}

type checkoutRequest struct {
	IntentID       string            `json:"intentId"`
	ChannelID      string            `json:"channelId"`
	Environment    string            `json:"environment"`
	IdempotencyKey string            `json:"idempotencyKey"`
	Receipt        string            `json:"receipt"`
	AmountPaise    int64             `json:"amountPaise"`
	Currency       string            `json:"currency"`
	DisplayName    string            `json:"donorDisplayName"`
	Message        string            `json:"message"`
	AlertConsent   *bool             `json:"alertConsent"`
	ExpiresAt      time.Time         `json:"expiresAt"`
	Notes          map[string]string `json:"notes,omitempty"`
}

func (h HTTPHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	if h.Authorizer == nil || h.Service == nil || (h.Environment != "test" && h.Environment != "live") {
		h.Metrics.ObserveCheckoutOutcome("not_configured")
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "checkout_not_configured"})
		return
	}
	if err := h.Authorizer.Authorize(request); err != nil {
		h.Metrics.ObserveCheckoutOutcome("unauthorized")
		writeJSON(response, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	limit := h.MaxBodyBytes
	if limit <= 0 {
		limit = maxCheckoutBodyBytes
	}
	raw, err := readJSONBody(request, limit)
	if err != nil {
		h.Metrics.ObserveCheckoutOutcome("invalid")
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	var input checkoutRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		h.Metrics.ObserveCheckoutOutcome("invalid")
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		h.Metrics.ObserveCheckoutOutcome("invalid")
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}

	idempotencyKey := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if idempotencyKey != input.IdempotencyKey || !idempotencyKeyPattern.MatchString(idempotencyKey) {
		h.Metrics.ObserveCheckoutOutcome("invalid")
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_idempotency_key"})
		return
	}
	now := time.Now()
	if input.Environment != h.Environment || input.Currency != "INR" || input.AmountPaise < 1000 || input.IntentID == "" || input.ChannelID == "" || input.Receipt == "" || input.AlertConsent == nil || input.ExpiresAt.IsZero() || !input.ExpiresAt.After(now) || input.ExpiresAt.After(now.Add(maxCheckoutLifetime)) {
		h.Metrics.ObserveCheckoutOutcome("invalid")
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	traceID := normalizeTraceID(request.Header.Get("X-BSA-Trace-Id"))

	result, err := h.Service.CreateOrder(request.Context(), IntentRequest{
		IntentID: input.IntentID, ChannelID: input.ChannelID, Environment: input.Environment,
		IdempotencyKey: input.IdempotencyKey, Receipt: input.Receipt, AmountPaise: input.AmountPaise,
		Currency: input.Currency, DisplayName: input.DisplayName, Message: input.Message,
		AlertConsent: *input.AlertConsent,
		ExpiresAt:    input.ExpiresAt, Notes: input.Notes, TraceID: traceID,
	})
	if err != nil {
		h.Metrics.ObserveCheckoutOutcome("retryable")
		status := http.StatusServiceUnavailable
		code := "payment_unavailable"
		if errors.Is(err, ErrOrderCreationInProgress) {
			status, code = http.StatusConflict, "order_creation_in_progress"
		} else if errors.Is(err, ErrProviderOrderMismatch) {
			status, code = http.StatusBadGateway, "provider_order_mismatch"
		}
		response.Header().Set("Retry-After", "5")
		writeJSON(response, status, map[string]string{"error": code})
		return
	}
	h.Metrics.ObserveCheckoutOutcome("accepted")

	status := "pending"
	if result.ProviderOrderID != "" {
		status = "created"
	}
	writeJSON(response, http.StatusCreated, map[string]any{
		"schemaVersion": "v1", "orderId": result.ID, "provider": "razorpay",
		"providerOrderId": result.ProviderOrderID, "amountPaise": result.AmountPaise,
		"currency": result.Currency, "status": status,
	})
}

func readJSONBody(request *http.Request, limit int64) ([]byte, error) {
	if request.Body == nil {
		return nil, errors.New("missing body")
	}
	data := make([]byte, 0, minInt64(limit, 4096))
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

func minInt64(left, right int64) int {
	if left < right {
		return int(left)
	}
	return int(right)
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
