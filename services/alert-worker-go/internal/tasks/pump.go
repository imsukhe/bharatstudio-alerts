package tasks

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
)

var ErrPartialPump = errors.New("delivery task pump completed with retryable enqueue failures")
var ErrInvalidPumpLimit = errors.New("delivery task pump limit must be positive")

const defaultPumpConcurrency = 8

// defaultDispatchLeaseDuration is not a new number: it is the
// "outbox-recovery" schedule's own timeoutSeconds (bharatstudio-crons/
// schedules/v1.json), which already bounds how long a dispatch run to this
// same endpoint is allowed to take. Reusing it as the lease TTL means a
// dispatcher that dies mid-scan (RT-04.8) is recoverable well before the
// next scheduled tick two minutes later, without inventing a second number.
const defaultDispatchLeaseDuration = 60 * time.Second

type ReadyDelivery struct {
	DeliveryID    string
	EventID       string
	OutboxID      string
	QueueID       string
	BindingID     string
	AttemptNumber int
	StateVersion  int64
	TraceID       string
}

type ReadyDeliverySource interface {
	ListReady(context.Context, int) ([]ReadyDelivery, error)
}

type CommandEnqueuer interface {
	Enqueue(context.Context, Command) error
}

// DispatchLeaser coordinates concurrent dispatch runs (RT-05) so a burst of
// post-commit wake-ups, or a wake-up overlapping the scheduled
// "outbox-recovery" tick, does not list and enqueue the same backlog more
// than once. TryAcquire returning (false, nil) is a normal, non-error
// outcome: it means another run currently holds the lease. Release is
// best-effort and only reached on a graceful return; a crash relies on the
// lease's own expiry (RT-04.8).
type DispatchLeaser interface {
	TryAcquire(ctx context.Context, token string, until time.Time) (bool, error)
	Release(ctx context.Context, token string) error
}

type Pump struct {
	Source      ReadyDeliverySource
	Enqueuer    CommandEnqueuer
	Now         func() time.Time
	Deadline    time.Duration
	Concurrency int

	// Leaser is optional. When nil, RunOnce behaves exactly as before this
	// field was added: it always scans. Set it in production so concurrent
	// dispatch runs are coordinated (RT-05).
	Leaser DispatchLeaser
	// LeaseDuration defaults to defaultDispatchLeaseDuration (60s, the
	// outbox-recovery schedule's own timeoutSeconds) when unset.
	LeaseDuration time.Duration
	// NewLeaseToken defaults to uuid.NewString. Overridable only for tests
	// that need a deterministic token.
	NewLeaseToken func() string
}

type PumpSummary struct {
	Candidates int `json:"candidates"`
	Enqueued   int `json:"enqueued"`
	Failed     int `json:"failed"`
	// Skipped is true when this run did not scan at all because another
	// dispatch run already held the lease. It is not a failure: the
	// backlog is being worked by that other run, or will be recovered on a
	// later tick if that run dies first.
	Skipped bool `json:"skipped,omitempty"`
}

func (p Pump) RunOnce(ctx context.Context, limit int) (PumpSummary, error) {
	var summary PumpSummary
	if p.Source == nil || p.Enqueuer == nil {
		return summary, errors.New("delivery task pump dependencies are not configured")
	}
	if limit <= 0 {
		return summary, ErrInvalidPumpLimit
	}
	now := time.Now()
	if p.Now != nil {
		now = p.Now()
	}

	if p.Leaser != nil {
		leaseDuration := p.LeaseDuration
		if leaseDuration <= 0 {
			leaseDuration = defaultDispatchLeaseDuration
		}
		newToken := p.NewLeaseToken
		if newToken == nil {
			newToken = uuid.NewString
		}
		token := newToken()
		acquired, err := p.Leaser.TryAcquire(ctx, token, now.Add(leaseDuration))
		if err != nil {
			return summary, err
		}
		if !acquired {
			summary.Skipped = true
			return summary, nil
		}
		// Best-effort, graceful-return release: it runs whenever RunOnce
		// returns normally (success, partial failure, or a returned error
		// other than a crash), including on the panic-free early returns
		// below, so a benign failure does not hold the backlog closed for
		// the full lease window. A process crash never reaches this defer
		// at all; the lease then simply expires (RT-04.8). Release uses its
		// own background context rather than ctx, so a cancelled or expired
		// request context cannot itself prevent the graceful release.
		defer func() {
			_ = p.Leaser.Release(context.Background(), token)
		}()
	}

	deadline := p.Deadline
	if deadline <= 0 {
		deadline = 30 * time.Second
	}
	rows, err := p.Source.ListReady(ctx, limit)
	if err != nil {
		return summary, err
	}
	summary.Candidates = len(rows)
	commands := make([]Command, 0, len(rows))
	for _, row := range rows {
		command := Command{
			SchemaVersion:        "v1",
			Action:               ActionDeliverOverlay,
			EventID:              row.EventID,
			OutboxID:             row.OutboxID,
			DeliveryID:           row.DeliveryID,
			AttemptNumber:        row.AttemptNumber,
			ExpectedStateVersion: row.StateVersion,
			TraceID:              row.TraceID,
			CreatedAt:            now,
			Deadline:             now.Add(deadline),
		}
		if err := command.Validate(now); err != nil {
			return summary, err
		}
		commands = append(commands, command)
	}

	concurrency := p.Concurrency
	if concurrency <= 0 {
		concurrency = defaultPumpConcurrency
	}
	if concurrency > len(commands) {
		concurrency = len(commands)
	}
	if concurrency == 0 {
		return summary, nil
	}

	jobs := make(chan Command)
	results := make(chan error, len(commands))
	var workers sync.WaitGroup
	workers.Add(concurrency)
	for index := 0; index < concurrency; index++ {
		go func() {
			defer workers.Done()
			for command := range jobs {
				results <- p.Enqueuer.Enqueue(ctx, command)
			}
		}()
	}

	cancelled := false
	for _, command := range commands {
		select {
		case jobs <- command:
		case <-ctx.Done():
			cancelled = true
		}
		if cancelled {
			break
		}
	}
	close(jobs)
	workers.Wait()
	close(results)

	partial := false
	for err := range results {
		if err != nil {
			summary.Failed++
			partial = true
			continue
		}
		summary.Enqueued++
	}
	if cancelled {
		return summary, ctx.Err()
	}
	if partial {
		return summary, ErrPartialPump
	}
	return summary, nil
}
