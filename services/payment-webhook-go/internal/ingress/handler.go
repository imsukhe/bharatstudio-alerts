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
	// Wakeups collapses a burst of post-commit wake-ups into a bounded number
	// of actual wake-up calls (see wakeup_coalescer.go). It must be shared
	// across every request the handler serves, so it is a pointer: Handler is
	// used as a value and copied into the mux. cmd/payment-webhook/main.go is
	// the only production construction site and always sets it.
	Wakeups *WakeupCoalescer
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
	// RT-04: the commit above is the one atomic, durable truth. The provider
	// gets its 2xx now, unconditionally -- dispatch is never again a reason
	// to turn an already-safe payment into a retry. The old reasoning here
	// was that a durable write followed by a failed wake-up had to stay
	// retryable, so the provider's own retry would repeat the idempotent
	// scan. That is superseded: a failed or slow wake-up no longer has a
	// durable delivery to lose, because the independently scheduled, leased
	// outbox dispatcher (bharatstudio-crons "outbox-recovery") scans and
	// re-enqueues anything a wake-up missed on its next tick. The wake-up
	// below is a fire-and-forget latency optimisation only.
	traceID := traceForProviderEvent(delivery.ProviderEventID)
	h.wakeUpDispatcher(traceID)
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

// wakeUpDispatcher fires the post-commit dispatcher wake-up without
// blocking, or being able to affect, the acknowledgement already decided
// above (RT-04). Correction of 2026-09-16: it no longer starts a goroutine
// per webhook. It hands the demand to the shared WakeupCoalescer, which
// keeps at most one wake-up goroutine alive and one wake-up in flight, and
// still guarantees that one more wake-up begins after this webhook. A burst
// of N webhooks therefore produces a bounded number of wake-ups, not N,
// while the last webhook of the burst still gets a wake-up after it.
// Handing over the demand takes only a mutex, so the 2xx never waits on it.
//
// A handler built without a coalescer is not the production path -- only
// unit tests can reach it -- and it degrades to the pre-correction
// one-goroutine-per-webhook behaviour rather than silently dropping the
// wake-up, because dropping it would be the worse failure.
func (h Handler) wakeUpDispatcher(traceID string) {
	if h.Pumper == nil {
		return
	}
	if h.Wakeups == nil {
		go h.runWakeup(traceID)
		return
	}
	h.Wakeups.request(traceID, h.runWakeup)
}

// runWakeup performs one wake-up call and records its outcome. It
// deliberately does not derive from request.Context(): that context is
// cancelled once ServeHTTP returns and the response has been written, and a
// wake-up that is meant to outlive the request must not be cancelled along
// with it. WorkerPumpClient bounds every call to its own configured timeout
// (5s by default, see worker_pump.go), so the coalescer's single goroutine
// always makes progress and never leaks past that bound.
func (h Handler) runWakeup(traceID string) {
	ctx := withTraceID(context.Background(), traceID)
	if err := h.Pumper.Pump(ctx); err != nil {
		h.Metrics.ObserveWakeupOutcome("failed")
		h.Logger.Event("webhook_wakeup", "failed", traceID)
		return
	}
	h.Metrics.ObserveWakeupOutcome("succeeded")
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
