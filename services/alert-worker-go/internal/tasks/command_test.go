package tasks

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func validCommand(now time.Time) Command {
	return Command{
		SchemaVersion:        "v1",
		Action:               "deliver_overlay",
		EventID:              "00000000-0000-4000-8000-000000000001",
		OutboxID:             "00000000-0000-4000-8000-000000000002",
		DeliveryID:           "00000000-0000-4000-8000-000000000003",
		AttemptNumber:        2,
		ExpectedStateVersion: 4,
		TraceID:              "trace-1",
		CreatedAt:            now,
		Deadline:             now.Add(time.Minute),
	}
}

func TestCommandValidationAndStableIdempotencyKey(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	command := validCommand(now)
	if err := command.Validate(now); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if command.IdempotencyKey() != "delivery:00000000-0000-4000-8000-000000000003:version:4:attempt:2" {
		t.Fatalf("idempotency key = %q", command.IdempotencyKey())
	}
	if command.IdempotencyKey() != validCommand(now).IdempotencyKey() {
		t.Fatal("same command did not produce a stable idempotency key")
	}
}

func TestCommandRejectsMissingFieldsAndExpiredDeadline(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	missing := validCommand(now)
	missing.DeliveryID = "not-a-uuid"
	if !errors.Is(missing.Validate(now), ErrInvalidCommand) {
		t.Fatal("missing delivery ID was accepted")
	}
	expired := validCommand(now)
	expired.CreatedAt = now.Add(-2 * time.Minute)
	expired.Deadline = now.Add(-time.Second)
	if !errors.Is(expired.Validate(now), ErrExpiredCommand) {
		t.Fatal("expired command was accepted")
	}
	createdAfterDeadline := validCommand(now)
	createdAfterDeadline.CreatedAt = now.Add(2 * time.Minute)
	if !errors.Is(createdAfterDeadline.Validate(now), ErrInvalidCommand) {
		t.Fatal("command with creation time after deadline was accepted")
	}
}

func TestCommandRejectsMalformedIDs(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	command := validCommand(now)
	command.EventID = "event-1"
	if !errors.Is(command.Validate(now), ErrInvalidCommand) {
		t.Fatal("malformed event ID was accepted")
	}
}

func TestCommandRejectsUnsupportedAction(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	command := validCommand(now)
	command.Action = "delete_payment"
	if !errors.Is(command.Validate(now), ErrInvalidCommand) {
		t.Fatal("unsupported action was accepted")
	}
}

func TestCommandTraceIDIsBoundedAndSafe(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name  string
		value string
		valid bool
	}{
		{name: "provider trace", value: "razorpay:event-123", valid: true},
		{name: "control character", value: "razorpay:event\n123", valid: false},
		{name: "payload separator", value: "razorpay:event|payment", valid: false},
		{name: "too long", value: strings.Repeat("x", maxTraceIDLength+1), valid: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			command := validCommand(now)
			command.TraceID = test.value
			if got := command.Validate(now) == nil; got != test.valid {
				t.Fatalf("trace %q valid=%v, want %v", test.value, got, test.valid)
			}
		})
	}
}

func TestCommandJSONRoundTripPreservesTraceCorrelation(t *testing.T) {
	now := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)
	want := validCommand(now)
	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var got Command
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if err := got.Validate(now); err != nil {
		t.Fatalf("round-tripped command invalid: %v", err)
	}
	if got.TraceID != want.TraceID || got.EventID != want.EventID || got.DeliveryID != want.DeliveryID {
		t.Fatalf("correlation fields changed after JSON round trip: got trace=%q event=%q delivery=%q", got.TraceID, got.EventID, got.DeliveryID)
	}
}
