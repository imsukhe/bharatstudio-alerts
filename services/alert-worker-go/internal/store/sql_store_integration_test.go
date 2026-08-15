//go:build integration

package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	workerdb "github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/db"
	"github.com/bharatstudio/bharatstudio-alerts/services/alert-worker-go/internal/tasks"
)

type integrationCommandEnqueuer struct {
	mu       sync.Mutex
	commands []tasks.Command
	err      error
}

func (e *integrationCommandEnqueuer) Enqueue(_ context.Context, command tasks.Command) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.err != nil {
		return e.err
	}
	e.commands = append(e.commands, command)
	return nil
}

func TestSQLDeliveryStoreClaimReleaseAgainstPostgres(t *testing.T) {
	dsn := os.Getenv("BSA_ALERT_WORKER_SQL_DSN")
	if dsn == "" {
		t.Skip("BSA_ALERT_WORKER_SQL_DSN is required for the disposable PostgreSQL integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	database, err := workerdb.Open(ctx, workerdb.Config{DSN: dsn, MaxOpenConns: 2, MaxIdleConns: 2})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer database.Close()

	const (
		eventID         = "00000000-0000-4000-8000-000000000225"
		outboxID        = "00000000-0000-4000-8000-000000000226"
		deliveryID      = "00000000-0000-4000-8000-000000000227"
		readyEventID    = "00000000-0000-4000-8000-000000000228"
		readyOutboxID   = "00000000-0000-4000-8000-000000000229"
		readyDeliveryID = "00000000-0000-4000-8000-000000000230"
		queueID         = "00000000-0000-4000-8000-000000000021"
		bindingID       = "00000000-0000-4000-8000-000000000031"
		channelID       = "00000000-0000-4000-8000-000000000011"
	)
	now := time.Now().UTC()
	if _, err := database.ExecContext(ctx, `
insert into alert_events
  (id, channel_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values ($1::uuid, $2::uuid, 'manual', 'worker-integration', 'trace-worker-integration', 1, '{"message":"worker integration"}'::jsonb, $3)`, eventID, channelID, now); err != nil {
		t.Fatalf("create synthetic event: %v", err)
	}
	if _, err := database.ExecContext(ctx, `
insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values ($1::uuid, $2::uuid, 'pending', $3, $3, $3)`, outboxID, eventID, now); err != nil {
		t.Fatalf("create synthetic outbox: %v", err)
	}
	if _, err := database.ExecContext(ctx, `
insert into event_outbox_deliveries
  (id, event_id, outbox_id, queue_id, binding_id, source_id,
   config_snapshot_version, delivery_sequence, source_priority, override_values,
   status, attempt_count, state_version, created_at, updated_at)
values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'worker-integration',
        1, 1, 40, '{"style":"worker-integration"}'::jsonb,
        'pending', 0, 1, $6, $6)`, deliveryID, eventID, outboxID, queueID, bindingID, now); err != nil {
		t.Fatalf("create synthetic delivery: %v", err)
	}

	store := NewSQLDeliveryStore(database)
	claimed, ok, err := store.Claim(ctx, deliveryID, eventID, outboxID, 1, 1, "00000000-0000-4000-8000-0000000000d1", now.Add(time.Minute))
	if err != nil || !ok {
		t.Fatalf("claim delivery: delivery=%+v claimed=%t err=%v", claimed, ok, err)
	}
	var overrides map[string]string
	if err := json.Unmarshal(claimed.OverrideValues, &overrides); err != nil {
		t.Fatalf("decode claimed override values: %v", err)
	}
	if claimed.DeliveryID != deliveryID || claimed.EventID != eventID || claimed.ChannelID != channelID || claimed.SourcePriority != 40 || overrides["style"] != "worker-integration" || claimed.AttemptNumber != 1 || claimed.StateVersion != 2 {
		t.Fatalf("unexpected claimed delivery: %+v", claimed)
	}

	released, ok, err := store.Release(ctx, deliveryID, "00000000-0000-4000-8000-0000000000d1")
	if err != nil || !ok || released.DeliveryID != deliveryID || released.Status != "ready" || released.StateVersion != 3 {
		t.Fatalf("release delivery: delivery=%+v released=%t err=%v", released, ok, err)
	}

	if _, ok, err := store.Claim(ctx, deliveryID, eventID, outboxID, 1, 1, "00000000-0000-4000-8000-0000000000d2", now.Add(time.Minute)); err != nil || ok {
		t.Fatalf("stale claim after release: claimed=%t err=%v", ok, err)
	}
	if _, err := database.ExecContext(ctx, `
insert into alert_events
  (id, channel_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
values ($1::uuid, $2::uuid, 'manual', 'worker-ready-pump', 'trace-worker-ready-pump', 1, '{"message":"ready pump"}'::jsonb, $3)`, readyEventID, channelID, now); err != nil {
		t.Fatalf("create ready-pump event: %v", err)
	}
	if _, err := database.ExecContext(ctx, `
insert into event_outbox (id, event_id, status, available_at, created_at, updated_at)
values ($1::uuid, $2::uuid, 'pending', $3, $3, $3)`, readyOutboxID, readyEventID, now); err != nil {
		t.Fatalf("create ready-pump outbox: %v", err)
	}
	if _, err := database.ExecContext(ctx, `
insert into event_outbox_deliveries
  (id, event_id, outbox_id, queue_id, binding_id, source_id,
   config_snapshot_version, delivery_sequence, source_priority, override_values,
   status, attempt_count, state_version, created_at, updated_at)
values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'worker-ready-pump',
        1, 1, 5, '{"style":"ready-pump"}'::jsonb,
        'pending', 0, 1, $6, $6)`, readyDeliveryID, readyEventID, readyOutboxID, queueID, bindingID, now); err != nil {
		t.Fatalf("create ready-pump delivery: %v", err)
	}

	// The ready-row adapter and pump are read-only with respect to durable
	// delivery state. A successful scan creates a stable command, while a
	// failed enqueue leaves the same SQL row available for a later scan.
	readySource := NewSQLReadyDeliveryStore(database)
	enqueuer := &integrationCommandEnqueuer{}
	pump := tasks.Pump{
		Source:   readySource,
		Enqueuer: enqueuer,
		Now:      func() time.Time { return now },
	}
	summary, err := pump.RunOnce(ctx, 10)
	if err != nil || summary.Candidates < 1 || summary.Enqueued != summary.Candidates || summary.Failed != 0 || len(enqueuer.commands) != summary.Candidates {
		t.Fatalf("ready delivery pump: summary=%+v commands=%d err=%v", summary, len(enqueuer.commands), err)
	}
	var targetCommand *tasks.Command
	for index := range enqueuer.commands {
		command := &enqueuer.commands[index]
		if command.DeliveryID == readyDeliveryID {
			targetCommand = command
			break
		}
	}
	if targetCommand == nil || targetCommand.Action != tasks.ActionDeliverOverlay || targetCommand.DeliveryID != readyDeliveryID || targetCommand.EventID != readyEventID || targetCommand.OutboxID != readyOutboxID || targetCommand.AttemptNumber != 1 || targetCommand.ExpectedStateVersion != 1 || targetCommand.IdempotencyKey() != "delivery:"+readyDeliveryID+":version:1:attempt:1" {
		t.Fatalf("target ready delivery command was not emitted: target=%+v commands=%+v summary=%+v", targetCommand, enqueuer.commands, summary)
	}

	failingEnqueuer := &integrationCommandEnqueuer{err: errors.New("synthetic enqueue outage")}
	failingPump := tasks.Pump{Source: readySource, Enqueuer: failingEnqueuer, Now: func() time.Time { return now }}
	failedSummary, err := failingPump.RunOnce(ctx, 10)
	if !errors.Is(err, tasks.ErrPartialPump) || failedSummary.Candidates < 1 || failedSummary.Enqueued != 0 || failedSummary.Failed != failedSummary.Candidates {
		t.Fatalf("failed ready delivery pump: summary=%+v err=%v", failedSummary, err)
	}
	remaining, err := readySource.ListReady(ctx, 10)
	var foundReady bool
	for _, row := range remaining {
		if row.DeliveryID == readyDeliveryID {
			foundReady = true
			break
		}
	}
	if err != nil || !foundReady {
		t.Fatalf("failed pump changed durable ready rows: rows=%+v err=%v", remaining, err)
	}
}
