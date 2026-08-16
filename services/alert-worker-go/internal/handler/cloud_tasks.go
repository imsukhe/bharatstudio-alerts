package handler

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/observability"
	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/store"
	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/tasks"
)

const defaultBodyLimit int64 = 64 << 10

type Authorizer interface {
	Authorize(*http.Request) error
}

type DeliveryStore interface {
	Claim(ctx context.Context, deliveryID, eventID, outboxID string, attemptNumber int, stateVersion int64, leaseToken string, leaseUntil time.Time) (store.ClaimedDelivery, bool, error)
	Retry(ctx context.Context, deliveryID, leaseToken string, nextActionAt time.Time, errorCode string) (bool, error)
	Complete(ctx context.Context, deliveryID, leaseToken, status string) (store.CompletedDelivery, bool, error)
	Release(ctx context.Context, deliveryID, leaseToken string) (store.CompletedDelivery, bool, error)
}

type Publisher interface {
	Publish(context.Context, store.ClaimedDelivery) error
}

type Notifier interface {
	Notify(ctx context.Context, channelID, eventID string) error
}

type Enricher interface {
	Enrich(ctx context.Context, eventID string) error
}

type Config struct {
	Authorizer    Authorizer
	Store         DeliveryStore
	Publisher     Publisher
	Notifier      Notifier
	Enricher      Enricher
	Now           func() time.Time
	BodyLimit     int64
	LeaseDuration time.Duration
	RetryDelay    time.Duration
	Token         func() (string, error)
	Metrics       *observability.Metrics
	Logger        *observability.StructuredLogger
}

type Handler struct {
	config Config
}

func New(config Config) Handler {
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.BodyLimit <= 0 {
		config.BodyLimit = defaultBodyLimit
	}
	if config.LeaseDuration <= 0 {
		config.LeaseDuration = 30 * time.Second
	}
	if config.RetryDelay <= 0 {
		config.RetryDelay = 5 * time.Second
	}
	if config.Token == nil {
		config.Token = randomToken
	}
	return Handler{config: config}
}

func (h Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	if h.config.Authorizer == nil || h.config.Store == nil || h.config.Publisher == nil {
		h.config.Metrics.ObserveTaskOutcome("not_configured")
		h.config.Logger.Event("task", "not_configured", "")
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "worker_not_configured"})
		return
	}
	if err := h.config.Authorizer.Authorize(request); err != nil {
		h.config.Metrics.ObserveTaskOutcome("unauthorized")
		h.config.Logger.Event("task", "unauthorized", "")
		writeJSON(response, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var command tasks.Command
	rawBody, err := io.ReadAll(io.LimitReader(request.Body, h.config.BodyLimit+1))
	if err != nil {
		h.config.Metrics.ObserveTaskOutcome("retryable")
		writeRetryable(response)
		return
	}
	if int64(len(rawBody)) > h.config.BodyLimit {
		h.config.Metrics.ObserveTaskOutcome("invalid")
		writeJSON(response, http.StatusRequestEntityTooLarge, map[string]string{"error": "body_too_large"})
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(rawBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&command); err != nil {
		h.config.Metrics.ObserveTaskOutcome("invalid")
		h.config.Logger.Event("task", "invalid", "")
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_command"})
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		h.config.Metrics.ObserveTaskOutcome("invalid")
		h.config.Logger.Event("task", "invalid", "")
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_command"})
		return
	}
	now := h.config.Now()
	if err := command.Validate(now); err != nil {
		h.config.Metrics.ObserveTaskOutcome("invalid")
		h.config.Logger.Event("task", "invalid", command.TraceID)
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_command"})
		return
	}

	leaseToken, err := h.config.Token()
	if err != nil || leaseToken == "" {
		h.config.Metrics.ObserveTaskOutcome("retryable")
		h.config.Logger.Event("task", "retryable", command.TraceID)
		writeRetryable(response)
		return
	}
	leaseUntil := now.Add(h.config.LeaseDuration)
	delivery, claimed, err := h.config.Store.Claim(request.Context(), command.DeliveryID, command.EventID, command.OutboxID, command.AttemptNumber, command.ExpectedStateVersion, leaseToken, leaseUntil)
	if err != nil {
		h.config.Metrics.ObserveTaskOutcome("retryable")
		h.config.Logger.Event("task", "retryable", command.TraceID)
		writeRetryable(response)
		return
	}
	if !claimed {
		h.config.Metrics.ObserveTaskOutcome("ignored")
		h.config.Logger.Event("task", "ignored", command.TraceID)
		writeJSON(response, http.StatusOK, map[string]string{"status": "ignored"})
		return
	}

	if err := h.config.Publisher.Publish(request.Context(), delivery); err != nil {
		h.config.Metrics.ObserveTaskOutcome("retryable")
		h.config.Logger.Event("task", "retryable", command.TraceID)
		_, _ = h.config.Store.Retry(request.Context(), command.DeliveryID, leaseToken, now.Add(h.config.RetryDelay), "publish_failed")
		writeRetryable(response)
		return
	}
	// TTS is an optional enrichment. It runs after the durable claim and before
	// release so a successful artifact can be included in replay, but every
	// provider/network failure is deliberately ignored: the visual alert must
	// still be released and the browser falls back to its chime.
	if h.config.Enricher != nil {
		_ = h.config.Enricher.Enrich(request.Context(), delivery.EventID)
	}
	if _, released, err := h.config.Store.Release(request.Context(), command.DeliveryID, leaseToken); err != nil || !released {
		h.config.Metrics.ObserveTaskOutcome("retryable")
		h.config.Logger.Event("task", "retryable", command.TraceID)
		// Publication is durable, but the overlay has not acknowledged display
		// yet. Release the worker lease while keeping the delivery ready so the
		// browser can replay it. A retry is required if release is unconfirmed;
		// without this transition the next task can observe an active lease,
		// return 200/ignored and leave the delivery stranded.
		_, _ = h.config.Store.Retry(request.Context(), command.DeliveryID, leaseToken, now.Add(h.config.RetryDelay), "completion_unconfirmed")
		writeRetryable(response)
		return
	}
	h.config.Metrics.ObserveTaskOutcome("accepted")
	h.config.Logger.Event("task", "accepted", command.TraceID)
	if h.config.Notifier != nil {
		// Notification only wakes listeners; durable replay remains correct if
		// this best-effort call fails.
		_ = h.config.Notifier.Notify(request.Context(), delivery.ChannelID, delivery.EventID)
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "accepted"})
}

func randomToken() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	// The SQL lease functions accept uuid. A plain hex token would pass unit
	// mocks but fail at the real database boundary.
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes)
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
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
