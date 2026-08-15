package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

type taskClient struct {
	task Task
	err  error
}

func (c *taskClient) CreateTask(_ context.Context, task Task) error {
	c.task = task
	return c.err
}

type taskExistsError struct{}

func (taskExistsError) Error() string       { return "already exists" }
func (taskExistsError) AlreadyExists() bool { return true }

func validEnqueueCommand() Command {
	return Command{
		SchemaVersion:        "v1",
		Action:               ActionDeliverOverlay,
		EventID:              "00000000-0000-4000-8000-000000000001",
		OutboxID:             "00000000-0000-4000-8000-000000000002",
		DeliveryID:           "00000000-0000-4000-8000-000000000003",
		AttemptNumber:        1,
		ExpectedStateVersion: 1,
		TraceID:              "trace-1",
		CreatedAt:            time.Now(),
		Deadline:             time.Now().Add(time.Minute),
	}
}

func TestEnqueueBuildsStableOIDCTask(t *testing.T) {
	client := &taskClient{}
	enqueuer, err := NewEnqueuer(client, "projects/p/locations/l/queues/q", "https://worker.example/internal/tasks", "https://worker.example", "worker@example.iam.gserviceaccount.com")
	if err != nil {
		t.Fatal(err)
	}
	command := validEnqueueCommand()
	if err := enqueuer.Enqueue(context.Background(), command); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(client.task.Name, "/tasks/bsa-") || client.task.Queue == "" || client.task.TargetURL == "" || client.task.OIDCAudience != "https://worker.example" || client.task.OIDCServiceAccount == "" {
		t.Fatalf("incomplete task: %#v", client.task)
	}
	var decoded Command
	if err := json.Unmarshal(client.task.Body, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.IdempotencyKey() != command.IdempotencyKey() {
		t.Fatalf("command changed: %#v", decoded)
	}

	firstName := client.task.Name
	if err := enqueuer.Enqueue(context.Background(), command); err != nil {
		t.Fatal(err)
	}
	if client.task.Name != firstName {
		t.Fatalf("task name was not stable: %q vs %q", firstName, client.task.Name)
	}
}

func TestEnqueueTreatsProviderAlreadyExistsAsSuccess(t *testing.T) {
	client := &taskClient{err: taskExistsError{}}
	enqueuer, err := NewEnqueuer(client, "queue", "https://worker.example/tasks", "https://worker.example", "worker@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if err := enqueuer.Enqueue(context.Background(), validEnqueueCommand()); err != nil {
		t.Fatalf("already exists should be idempotent success: %v", err)
	}
}

func TestEnqueueRejectsWrongActionOrProviderFailure(t *testing.T) {
	client := &taskClient{err: errors.New("provider unavailable")}
	enqueuer, err := NewEnqueuer(client, "queue", "https://worker.example/tasks", "https://worker.example", "worker@example.com")
	if err != nil {
		t.Fatal(err)
	}
	command := validEnqueueCommand()
	command.Action = "reconcile"
	if err := enqueuer.Enqueue(context.Background(), command); !errors.Is(err, ErrInvalidCommand) {
		t.Fatalf("wrong action error = %v", err)
	}
	command.Action = ActionDeliverOverlay
	if err := enqueuer.Enqueue(context.Background(), command); err == nil || !strings.Contains(err.Error(), "provider unavailable") {
		t.Fatalf("provider failure = %v", err)
	}
}

func TestNewEnqueuerFailsClosedForInvalidTarget(t *testing.T) {
	client := &taskClient{}
	if _, err := NewEnqueuer(client, "queue", "http://worker.example/tasks", "https://worker.example", "worker@example.com"); !errors.Is(err, ErrInvalidEnqueuer) {
		t.Fatalf("http target error = %v", err)
	}
	if _, err := NewEnqueuer(client, "queue", "https://worker.example/tasks", "https://worker.example", ""); !errors.Is(err, ErrInvalidEnqueuer) {
		t.Fatalf("missing OIDC account error = %v", err)
	}
	if _, err := NewEnqueuer(client, "queue", "https://worker.example/tasks", "", "worker@example.com"); !errors.Is(err, ErrInvalidEnqueuer) {
		t.Fatalf("missing OIDC audience error = %v", err)
	}
}
