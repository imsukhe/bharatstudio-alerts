package store

import (
	"context"
	"strings"
	"testing"
)

type fakeExecer struct {
	query string
	args  []any
	err   error
}

func (e *fakeExecer) ExecContext(_ context.Context, query string, args ...any) error {
	e.query = query
	e.args = args
	return e.err
}

func TestWakeupNotifierCallsOnlyWorkerFunction(t *testing.T) {
	execer := &fakeExecer{}
	notifier := NewWakeupNotifier(execer)
	if err := notifier.Notify(context.Background(), "channel-1", "event-1"); err != nil {
		t.Fatalf("Notify() error = %v", err)
	}
	if !strings.Contains(execer.query, "app_private.notify_overlay_wakeup") {
		t.Fatalf("query = %q", execer.query)
	}
}
