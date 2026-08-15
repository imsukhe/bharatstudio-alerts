package tasks

import (
	"context"
	"errors"
	"sync"
	"time"
)

var ErrPartialPump = errors.New("delivery task pump completed with retryable enqueue failures")
var ErrInvalidPumpLimit = errors.New("delivery task pump limit must be positive")

const defaultPumpConcurrency = 8

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

type Pump struct {
	Source      ReadyDeliverySource
	Enqueuer    CommandEnqueuer
	Now         func() time.Time
	Deadline    time.Duration
	Concurrency int
}

type PumpSummary struct {
	Candidates int `json:"candidates"`
	Enqueued   int `json:"enqueued"`
	Failed     int `json:"failed"`
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
