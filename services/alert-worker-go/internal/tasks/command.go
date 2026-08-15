package tasks

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	ErrInvalidCommand = errors.New("invalid alert task command")
	ErrExpiredCommand = errors.New("alert task command deadline expired")
)

const maxTraceIDLength = 128

// validTraceID keeps the task envelope correlation field bounded and free of
// control characters. Trace IDs are diagnostic metadata only; they must never
// become a place for arbitrary payloads or a high-cardinality metric label.
func validTraceID(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxTraceIDLength {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
			(char < '0' || char > '9') && char != '-' && char != '_' && char != '.' && char != ':' {
			return false
		}
	}
	return true
}

func validCommandID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	_, err := uuid.Parse(value)
	return err == nil
}

// Command is the language-neutral durable action envelope sent through Cloud
// Tasks. The delivery row and expected state version are the correctness
// boundary; Cloud Tasks only transports and retries this command.
type Command struct {
	SchemaVersion        string    `json:"schemaVersion"`
	Action               string    `json:"action"`
	EventID              string    `json:"eventId"`
	OutboxID             string    `json:"outboxId"`
	DeliveryID           string    `json:"deliveryId"`
	AttemptNumber        int       `json:"attemptNumber"`
	ExpectedStateVersion int64     `json:"expectedStateVersion"`
	TraceID              string    `json:"traceId"`
	CreatedAt            time.Time `json:"createdAt"`
	Deadline             time.Time `json:"deadline"`
}

func (c Command) Validate(now time.Time) error {
	if c.SchemaVersion != "v1" || c.Action != ActionDeliverOverlay || !validCommandID(c.EventID) || !validCommandID(c.OutboxID) || !validCommandID(c.DeliveryID) || !validTraceID(c.TraceID) || c.AttemptNumber < 1 || c.ExpectedStateVersion < 1 || c.CreatedAt.IsZero() || c.Deadline.IsZero() || c.Deadline.Before(c.CreatedAt) {
		return ErrInvalidCommand
	}
	if c.Deadline.Before(now) {
		return ErrExpiredCommand
	}
	return nil
}

// IdempotencyKey is stable across Cloud Tasks retries for the same expected
// delivery version and attempt. A later retry with a new attempt is a new
// processing attempt and is recorded separately.
func (c Command) IdempotencyKey() string {
	return fmt.Sprintf("delivery:%s:version:%d:attempt:%d", c.DeliveryID, c.ExpectedStateVersion, c.AttemptNumber)
}
