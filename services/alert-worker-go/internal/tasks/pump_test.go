package tasks

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeReadySource struct{ rows []ReadyDelivery }

func (s fakeReadySource) ListReady(context.Context, int) ([]ReadyDelivery, error) { return s.rows, nil }

type fakeCommandEnqueuer struct {
	commands []Command
	err      error
}

func (e *fakeCommandEnqueuer) Enqueue(_ context.Context, command Command) error {
	if e.err != nil {
		return e.err
	}
	e.commands = append(e.commands, command)
	return nil
}

func TestPumpCreatesStableDeliveryCommands(t *testing.T) {
	now := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)
	enqueuer := &fakeCommandEnqueuer{}
	pump := Pump{
		Source: fakeReadySource{rows: []ReadyDelivery{{
			DeliveryID: "00000000-0000-4000-8000-000000000003", EventID: "00000000-0000-4000-8000-000000000001", OutboxID: "00000000-0000-4000-8000-000000000002", AttemptNumber: 2, StateVersion: 4, TraceID: "trace-1",
		}}},
		Enqueuer: enqueuer,
		Now:      func() time.Time { return now },
	}
	summary, err := pump.RunOnce(context.Background(), 10)
	if err != nil || summary.Enqueued != 1 || len(enqueuer.commands) != 1 {
		t.Fatalf("unexpected pump result: summary=%+v err=%v", summary, err)
	}
	command := enqueuer.commands[0]
	if command.IdempotencyKey() != "delivery:00000000-0000-4000-8000-000000000003:version:4:attempt:2" || !command.CreatedAt.Equal(now) || !command.Deadline.Equal(now.Add(30*time.Second)) {
		t.Fatalf("unexpected command: %+v", command)
	}
}

func TestPumpReturnsRetryablePartialFailureWithoutAcknowledgingRows(t *testing.T) {
	enqueuer := &fakeCommandEnqueuer{err: errors.New("cloud tasks unavailable")}
	pump := Pump{
		Source: fakeReadySource{rows: []ReadyDelivery{{
			DeliveryID: "00000000-0000-4000-8000-000000000003", EventID: "00000000-0000-4000-8000-000000000001", OutboxID: "00000000-0000-4000-8000-000000000002", AttemptNumber: 1, StateVersion: 1, TraceID: "trace-1",
		}}},
		Enqueuer: enqueuer,
	}
	summary, err := pump.RunOnce(context.Background(), 10)
	if !errors.Is(err, ErrPartialPump) || summary.Failed != 1 || summary.Enqueued != 0 {
		t.Fatalf("expected retryable partial pump: summary=%+v err=%v", summary, err)
	}
}

func TestPumpRejectsNonPositiveLimitInsteadOfSilentlyDoingNothing(t *testing.T) {
	enqueuer := &fakeCommandEnqueuer{}
	pump := Pump{Source: fakeReadySource{}, Enqueuer: enqueuer}
	summary, err := pump.RunOnce(context.Background(), 0)
	if !errors.Is(err, ErrInvalidPumpLimit) {
		t.Fatalf("expected invalid limit error, got %v", err)
	}
	if summary.Candidates != 0 || summary.Enqueued != 0 || len(enqueuer.commands) != 0 {
		t.Fatalf("invalid limit should not query or enqueue: summary=%+v commands=%d", summary, len(enqueuer.commands))
	}
}
