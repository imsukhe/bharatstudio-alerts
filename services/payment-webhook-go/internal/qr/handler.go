package qr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/payment-webhook-go/internal/observability"
)

const maxQrBodyBytes int64 = 4 << 10

// maxQrLifetime mirrors checkout's maxCheckoutLifetime: a QR must not outlive
// the BharatStudio boundary invariant for how long an unpaid intent may stay
// open, even though Razorpay's close_by would itself accept longer.
const maxQrLifetime = 15 * time.Minute

type Authorizer interface {
	Authorize(*http.Request) error
}

type QrCreator interface {
	CreateQr(context.Context, Request) (Record, error)
}

type HTTPHandler struct {
	Authorizer   Authorizer
	Service      QrCreator
	Environment  string
	MaxBodyBytes int64
	Metrics      *observability.Metrics
}

type qrRequest struct {
	IntentID    string    `json:"intentId"`
	ChannelID   string    `json:"channelId"`
	Environment string    `json:"environment"`
	CloseBy     time.Time `json:"closeBy"`
}

func (h HTTPHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	if h.Authorizer == nil || h.Service == nil || (h.Environment != "test" && h.Environment != "live") {
		h.Metrics.ObserveQrOutcome("not_configured")
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "qr_not_configured"})
		return
	}
	if err := h.Authorizer.Authorize(request); err != nil {
		h.Metrics.ObserveQrOutcome("unauthorized")
		writeJSON(response, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	limit := h.MaxBodyBytes
	if limit <= 0 {
		limit = maxQrBodyBytes
	}
	raw, err := readJSONBody(request, limit)
	if err != nil {
		h.Metrics.ObserveQrOutcome("invalid")
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	var input qrRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		h.Metrics.ObserveQrOutcome("invalid")
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		h.Metrics.ObserveQrOutcome("invalid")
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}

	now := time.Now()
	if input.Environment != h.Environment || input.IntentID == "" || input.ChannelID == "" || input.CloseBy.IsZero() || !input.CloseBy.After(now) || input.CloseBy.After(now.Add(maxQrLifetime)) {
		h.Metrics.ObserveQrOutcome("invalid")
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}

	record, err := h.Service.CreateQr(request.Context(), Request{
		IntentID: input.IntentID, ChannelID: input.ChannelID, Environment: input.Environment,
		CloseBy: input.CloseBy, TraceID: request.Header.Get("X-BSA-Trace-Id"),
	})
	if err != nil {
		status := http.StatusServiceUnavailable
		code := "payment_unavailable"
		switch {
		case errors.Is(err, ErrQrCreationInProgress):
			status, code = http.StatusConflict, "qr_creation_in_progress"
		case errors.Is(err, ErrProviderQrMismatch):
			status, code = http.StatusBadGateway, "provider_qr_mismatch"
		case errors.Is(err, ErrIntentNotEligible):
			status, code = http.StatusConflict, "intent_not_eligible"
		}
		h.Metrics.ObserveQrOutcome("retryable")
		response.Header().Set("Retry-After", "5")
		writeJSON(response, status, map[string]string{"error": code})
		return
	}
	h.Metrics.ObserveQrOutcome("accepted")

	status := "pending"
	if record.ProviderQrID != "" {
		status = "created"
	}
	writeJSON(response, http.StatusCreated, map[string]any{
		"schemaVersion": "v1", "provider": "razorpay",
		"providerQrRef": record.ProviderQrID, "qrImageUrl": record.QrImageURL,
		"expiresAt": record.CloseBy.UTC().Format(time.RFC3339), "status": status,
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
