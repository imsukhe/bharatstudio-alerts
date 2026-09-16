package tasks

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeLeaser mirrors the single-row lease semantics of migration 0129
// (app_private.acquire_outbox_dispatch_lease / release_outbox_dispatch_lease)
// in memory: a lease is acquirable when it has never been held, or its
// previous holder's lease_until has passed.
type fakeLeaser struct {
	mu          sync.Mutex
	token       string
	until       time.Time
	acquireErr  error
	acquireHook func()
	acquireLog  []string
	releaseLog  []string
}

func (l *fakeLeaser) TryAcquire(_ context.Context, token string, until time.Time) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.acquireLog = append(l.acquireLog, token)
	if l.acquireHook != nil {
		l.acquireHook()
	}
	if l.acquireErr != nil {
		return false, l.acquireErr
	}
	if l.token != "" && time.Now().Before(l.until) {
		return false, nil
	}
	l.token = token
	l.until = until
	return true, nil
}

func (l *fakeLeaser) Release(_ context.Context, token string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.releaseLog = append(l.releaseLog, token)
	if l.token == token {
		l.token = ""
		l.until = time.Time{}
	}
	return nil
}

func sequentialTokens(prefix string) func() string {
	count := 0
	return func() string {
		count++
		return prefix + string(rune('a'+count-1))
	}
}

// RT-04.7: two concurrent dispatcher runs do not enqueue the same delivery
// twice. The second run never even reaches ListReady/Enqueue once the first
// holds the lease.
func TestConcurrentDispatchRunsDoNotBothScanAndEnqueue(t *testing.T) {
	leaser := &fakeLeaser{}
	source := fakeReadySource{rows: []ReadyDelivery{{
		DeliveryID: "00000000-0000-4000-8000-000000000003", EventID: "00000000-0000-4000-8000-000000000001",
		OutboxID: "00000000-0000-4000-8000-000000000002", AttemptNumber: 1, StateVersion: 1, TraceID: "trace-1",
	}}}
	enqueuer := &fakeCommandEnqueuer{}
	first := Pump{Source: source, Enqueuer: enqueuer, Leaser: leaser, NewLeaseToken: sequentialTokens("first-")}
	second := Pump{Source: source, Enqueuer: enqueuer, Leaser: leaser, NewLeaseToken: sequentialTokens("second-")}

	firstSummary, err := first.RunOnce(context.Background(), 10)
	if err != nil || firstSummary.Skipped || firstSummary.Enqueued != 1 {
		t.Fatalf("first run: summary=%+v err=%v", firstSummary, err)
	}

	// The first run's defer already released its lease by the time RunOnce
	// returned, so make the second run race a STILL-HELD lease directly
	// rather than relying on timing: acquire on the second pump's behalf
	// first, simulating "another run is mid-scan right now".
	if acquired, err := leaser.TryAcquire(context.Background(), "third-party-holder", time.Now().Add(time.Minute)); err != nil || !acquired {
		t.Fatalf("expected the test to be able to seize the lease: acquired=%v err=%v", acquired, err)
	}

	secondSummary, err := second.RunOnce(context.Background(), 10)
	if err != nil {
		t.Fatalf("second run should skip cleanly, not error: %v", err)
	}
	if !secondSummary.Skipped {
		t.Fatalf("expected the second concurrent run to be skipped: %+v", secondSummary)
	}
	if len(enqueuer.commands) != 1 {
		t.Fatalf("enqueued %d commands, want exactly 1 (no double dispatch)", len(enqueuer.commands))
	}
}

// RT-04.8: a dispatcher that dies mid-scan (never reaches its release)
// leaves the lease to expire on its own; a later run then picks the work up.
func TestExpiredLeaseFromACrashedRunIsPickedUpLater(t *testing.T) {
	leaser := &fakeLeaser{token: "dead-run", until: time.Now().Add(-time.Second)}
	enqueuer := &fakeCommandEnqueuer{}
	pump := Pump{
		Source: fakeReadySource{rows: []ReadyDelivery{{
			DeliveryID: "00000000-0000-4000-8000-000000000003", EventID: "00000000-0000-4000-8000-000000000001",
			OutboxID: "00000000-0000-4000-8000-000000000002", AttemptNumber: 1, StateVersion: 1, TraceID: "trace-1",
		}}},
		Enqueuer:      enqueuer,
		Leaser:        leaser,
		NewLeaseToken: sequentialTokens("recovery-"),
	}
	summary, err := pump.RunOnce(context.Background(), 10)
	if err != nil || summary.Skipped || summary.Enqueued != 1 {
		t.Fatalf("expected the expired lease to be acquirable: summary=%+v err=%v", summary, err)
	}
}

// A graceful (non-crash) return releases the lease immediately, so the next
// tick is not stuck waiting out the full lease window for no reason.
func TestSuccessfulRunReleasesTheLeaseBeforeReturning(t *testing.T) {
	leaser := &fakeLeaser{}
	pump := Pump{Source: fakeReadySource{}, Enqueuer: &fakeCommandEnqueuer{}, Leaser: leaser, NewLeaseToken: sequentialTokens("run-")}
	if _, err := pump.RunOnce(context.Background(), 10); err != nil {
		t.Fatalf("run: %v", err)
	}
	acquired, err := leaser.TryAcquire(context.Background(), "next-run", time.Now().Add(time.Minute))
	if err != nil || !acquired {
		t.Fatalf("expected the lease to already be released: acquired=%v err=%v", acquired, err)
	}
}

// A lease acquisition failure (a genuine database error, not a lost race)
// must surface as a retryable error, exactly like any other pump
// dependency failure -- it must not be silently treated as "skipped".
func TestLeaseAcquisitionFailureIsARealErrorNotASkip(t *testing.T) {
	leaser := &fakeLeaser{acquireErr: errors.New("lease store unavailable")}
	pump := Pump{Source: fakeReadySource{}, Enqueuer: &fakeCommandEnqueuer{}, Leaser: leaser}
	summary, err := pump.RunOnce(context.Background(), 10)
	if err == nil {
		t.Fatal("expected a lease store failure to be a real error")
	}
	if summary.Skipped {
		t.Fatal("a database failure must not be reported as a benign skip")
	}
}

// Without a Leaser configured, RunOnce behaves exactly as it always has --
// this is the default for every pre-existing test in this package and must
// not change.
func TestRunOnceWithoutALeaserAlwaysScans(t *testing.T) {
	enqueuer := &fakeCommandEnqueuer{}
	pump := Pump{
		Source: fakeReadySource{rows: []ReadyDelivery{{
			DeliveryID: "00000000-0000-4000-8000-000000000003", EventID: "00000000-0000-4000-8000-000000000001",
			OutboxID: "00000000-0000-4000-8000-000000000002", AttemptNumber: 1, StateVersion: 1, TraceID: "trace-1",
		}}},
		Enqueuer: enqueuer,
	}
	summary, err := pump.RunOnce(context.Background(), 10)
	if err != nil || summary.Skipped || summary.Enqueued != 1 {
		t.Fatalf("summary=%+v err=%v", summary, err)
	}
}
