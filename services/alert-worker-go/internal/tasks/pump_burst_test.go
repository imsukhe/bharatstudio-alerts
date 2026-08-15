package tasks

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

type burstReadySource struct {
	rows []ReadyDelivery
}

func (s burstReadySource) ListReady(context.Context, int) ([]ReadyDelivery, error) {
	return append([]ReadyDelivery(nil), s.rows...), nil
}

type burstCommandEnqueuer struct {
	mu       sync.Mutex
	commands map[string]Command
	failAt   map[string]bool
}

type concurrentCommandEnqueuer struct {
	mu        sync.Mutex
	commands  map[string]Command
	active    int
	maxActive int
	delay     time.Duration
}

func (e *concurrentCommandEnqueuer) Enqueue(ctx context.Context, command Command) error {
	e.mu.Lock()
	e.active++
	if e.active > e.maxActive {
		e.maxActive = e.active
	}
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		e.active--
		e.mu.Unlock()
	}()
	select {
	case <-time.After(e.delay):
	case <-ctx.Done():
		return ctx.Err()
	}
	e.mu.Lock()
	e.commands[command.DeliveryID] = command
	e.mu.Unlock()
	return nil
}

func (e *burstCommandEnqueuer) Enqueue(_ context.Context, command Command) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.failAt[command.DeliveryID] {
		return errors.New("synthetic enqueue outage")
	}
	e.commands[command.DeliveryID] = command
	return nil
}

func syntheticBurstRows(count int) []ReadyDelivery {
	rows := make([]ReadyDelivery, 0, count)
	for index := 1; index <= count; index++ {
		rows = append(rows, ReadyDelivery{
			DeliveryID:    fmt.Sprintf("00000000-0000-4000-8000-%012d", index),
			EventID:       fmt.Sprintf("00000000-0000-4000-8000-%012d", index+1000),
			OutboxID:      fmt.Sprintf("00000000-0000-4000-8000-%012d", index+2000),
			AttemptNumber: 1,
			StateVersion:  1,
			TraceID:       fmt.Sprintf("trace-%04d", index),
		})
	}
	return rows
}

func TestPumpBurstPreservesEveryDurableCandidate(t *testing.T) {
	const count = 1000
	enqueuer := &burstCommandEnqueuer{commands: make(map[string]Command), failAt: make(map[string]bool)}
	pump := Pump{Source: burstReadySource{rows: syntheticBurstRows(count)}, Enqueuer: enqueuer}

	summary, err := pump.RunOnce(context.Background(), count)
	if err != nil {
		t.Fatalf("burst pump failed: %v", err)
	}
	if summary.Candidates != count || summary.Enqueued != count || summary.Failed != 0 {
		t.Fatalf("unexpected burst summary: %+v", summary)
	}
	if len(enqueuer.commands) != count {
		t.Fatalf("enqueued %d unique commands, want %d", len(enqueuer.commands), count)
	}
	for _, row := range syntheticBurstRows(count) {
		command, ok := enqueuer.commands[row.DeliveryID]
		if !ok {
			t.Fatalf("durable candidate %s did not produce a command", row.DeliveryID)
		}
		want := fmt.Sprintf("delivery:%s:version:1:attempt:1", row.DeliveryID)
		if command.IdempotencyKey() != want {
			t.Fatalf("delivery %s has idempotency key %q, want %q", row.DeliveryID, command.IdempotencyKey(), want)
		}
	}
}

func TestPumpBurstFailureIsRetryableAndDoesNotAcknowledgeCandidates(t *testing.T) {
	const count = 1000
	rows := syntheticBurstRows(count)
	failAt := make(map[string]bool)
	for index := 0; index < count; index += 7 {
		failAt[rows[index].DeliveryID] = true
	}
	enqueuer := &burstCommandEnqueuer{commands: make(map[string]Command), failAt: failAt}
	pump := Pump{Source: burstReadySource{rows: rows}, Enqueuer: enqueuer}

	summary, err := pump.RunOnce(context.Background(), count)
	if !errors.Is(err, ErrPartialPump) {
		t.Fatalf("expected retryable partial error, got %v", err)
	}
	if summary.Candidates != count || summary.Failed != len(failAt) || summary.Enqueued != count-len(failAt) {
		t.Fatalf("unexpected partial burst summary: %+v failed=%d", summary, len(failAt))
	}
	if len(enqueuer.commands) != count-len(failAt) {
		t.Fatalf("recorded %d commands after partial failure, want %d", len(enqueuer.commands), count-len(failAt))
	}

	// The source remains unchanged after the failed pass. A later healthy scan
	// can therefore retry every candidate; the pump has no acknowledgement or
	// destructive operation to hide the failed rows.
	enqueuer.failAt = make(map[string]bool)
	second, err := pump.RunOnce(context.Background(), count)
	if err != nil || second.Candidates != count || second.Enqueued != count {
		t.Fatalf("healthy retry did not recover all candidates: summary=%+v err=%v", second, err)
	}
}

func TestPumpUsesBoundedConcurrencyWithoutDroppingCandidates(t *testing.T) {
	const count = 24
	enqueuer := &concurrentCommandEnqueuer{
		commands: make(map[string]Command),
		delay:    5 * time.Millisecond,
	}
	pump := Pump{
		Source:      burstReadySource{rows: syntheticBurstRows(count)},
		Enqueuer:    enqueuer,
		Concurrency: 4,
	}

	summary, err := pump.RunOnce(context.Background(), count)
	if err != nil {
		t.Fatalf("concurrent pump failed: %v", err)
	}
	if summary.Candidates != count || summary.Enqueued != count || summary.Failed != 0 {
		t.Fatalf("unexpected concurrent pump summary: %+v", summary)
	}
	if len(enqueuer.commands) != count {
		t.Fatalf("enqueued %d commands, want %d", len(enqueuer.commands), count)
	}
	if enqueuer.maxActive < 2 || enqueuer.maxActive > 4 {
		t.Fatalf("pump concurrency was %d, want between 2 and 4", enqueuer.maxActive)
	}
}
