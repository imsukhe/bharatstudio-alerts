package ingress

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/observability"
	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/webhook"
)

const defaultMaxBodyBytes int64 = 1 << 20

var ErrStoreUnavailable = errors.New("payment persistence unavailable")
var ErrInvalidWebhookPayload = errors.New("invalid verified webhook payload")
var ErrQuarantinedWebhook = errors.New("verified webhook quarantined")

// Store is the atomic persistence boundary. Its implementation must insert
// the verified delivery and all resulting financial evidence in one database
// transaction before returning nil. duplicate is true only when the unique
// provider delivery key was already durably recorded.
type Store interface {
	PersistVerified(ctx context.Context, delivery webhook.Delivery, rawBody []byte) (duplicate bool, err error)
}

// DeliveryPumper wakes the private alert-worker pump after the verified
// webhook has been durably recorded. It must be idempotent: a duplicate
// webhook may safely trigger the same scan again.
type DeliveryPumper interface {
	Pump(context.Context) error
}

type Handler struct {
	Secret       string
	Store        Store
	Pumper       DeliveryPumper
	MaxBodyBytes int64
	Metrics      *observability.Metrics
	Logger       *observability.StructuredLogger
}

func (h Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	// A durable payment write without a configured worker pump is not an
	// acknowledged receipt path: it could leave a ready alert unwoken while
	// returning provider success. Fail closed before consuming the body or
	// writing financial evidence; a correctly configured provider retry can
	// then re-enter the same idempotent path.
	if h.Store == nil || h.Pumper == nil || h.Secret == "" {
		h.Metrics.ObserveWebhookOutcome("not_configured")
		h.Logger.Event("webhook", "not_configured", "")
		writeRetryable(response)
		return
	}

	maxBodyBytes := h.MaxBodyBytes
	if maxBodyBytes <= 0 {
		maxBodyBytes = defaultMaxBodyBytes
	}
	rawBody, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil {
		h.Metrics.ObserveWebhookOutcome("retryable")
		writeRetryable(response)
		return
	}
	if int64(len(rawBody)) > maxBodyBytes {
		h.Metrics.ObserveWebhookOutcome("invalid")
		writeJSON(response, http.StatusRequestEntityTooLarge, map[string]string{"error": "body_too_large"})
		return
	}

	delivery, err := webhook.Verify(rawBody, request.Header, h.Secret)
	if err != nil {
		h.Metrics.ObserveWebhookOutcome("invalid")
		h.Logger.Event("webhook", "invalid", "")
		status := http.StatusBadRequest
		if errors.Is(err, webhook.ErrMissingSignature) || errors.Is(err, webhook.ErrInvalidSignature) {
			status = http.StatusUnauthorized
		}
		writeJSON(response, status, map[string]string{"error": "invalid_webhook"})
		return
	}

	duplicate, err := h.Store.PersistVerified(request.Context(), delivery, rawBody)
	if err != nil {
		if errors.Is(err, ErrInvalidWebhookPayload) {
			h.Metrics.ObserveWebhookOutcome("invalid")
			h.Logger.Event("webhook", "invalid", traceForProviderEvent(delivery.ProviderEventID))
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_webhook_payload"})
			return
		}
		if errors.Is(err, ErrQuarantinedWebhook) {
			h.Metrics.ObserveWebhookOutcome("quarantined")
			h.Logger.Event("webhook", "quarantined", traceForProviderEvent(delivery.ProviderEventID))
			writeJSON(response, http.StatusOK, map[string]string{"status": "quarantined"})
			return
		}
		h.Metrics.ObserveWebhookOutcome("retryable")
		h.Logger.Event("webhook", "retryable", "")
		writeRetryable(response)
		return
	}
	// A durable write followed by a failed wake-up must remain retryable.
	// Provider retry then repeats the idempotent scan; it must never receive
	// a success response while a ready delivery is unwoken.
	pumpContext := withTraceID(request.Context(), traceForProviderEvent(delivery.ProviderEventID))
	traceID := traceForProviderEvent(delivery.ProviderEventID)
	if err := h.Pumper.Pump(pumpContext); err != nil {
		h.Metrics.ObserveWebhookOutcome("retryable")
		h.Logger.Event("webhook", "retryable", traceID)
		writeRetryable(response)
		return
	}
	if duplicate {
		h.Metrics.ObserveWebhookOutcome("duplicate")
		h.Logger.Event("webhook", "duplicate", traceID)
		writeJSON(response, http.StatusOK, map[string]string{"status": "duplicate"})
		return
	}
	h.Metrics.ObserveWebhookOutcome("accepted")
	h.Logger.Event("webhook", "accepted", traceID)
	writeJSON(response, http.StatusOK, map[string]string{"status": "accepted"})
}

func writeRetryable(response http.ResponseWriter) {
	response.Header().Set("Retry-After", "5")
	writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "temporarily_unavailable"})
}

func writeJSON(response http.ResponseWriter, status int, body map[string]string) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
