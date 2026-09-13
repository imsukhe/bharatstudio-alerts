package poller

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/quota"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/store"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/youtube"
)

// This file covers the streamList switch (L15 streamlist finding): a
// dropped connection reconnects with backoff, token expiry mid-stream is
// handled, and persistent streamList failure engages the PollLiveChat
// fallback. See poller_test.go's TestStreamReconnectReplayIsNotDuplicated
// and TestTransientInsertFailureForcesStreamReconnectForRetry for the
// idempotency/taxonomy side of this same change.

func newStreamTestPoller(client *fakeClient, connections *fakeConnectionsStore, events *fakeEventStore, clock *time.Time) *Poller {
	return New(Config{
		Client:                 client,
		Connections:            connections,
		Events:                 events,
		Protector:              fakeProtector{},
		Budget:                 quota.NewBudget(1_000_000, func() time.Time { return *clock }),
		Now:                    func() time.Time { return *clock },
		ConfigSnapshotVersion:  func(context.Context, string) (int64, error) { return 1, nil },
		MinChatPollDelay:       time.Second,
		PollCycleInterval:      time.Minute,
		StreamReadWindow:       5 * time.Millisecond,
		StreamFailureThreshold: 3,
		FallbackCooldown:       5 * time.Minute,
		StreamUsage:            quota.NewStreamUsage(),
	})
}

// TestDroppedConnectionReconnectsWithBackoff verifies: (1) a mid-stream
// drop schedules a reconnect rather than wedging the channel forever, (2)
// the poller does not hammer a reconnect immediately (nextPollAt holds it
// back), and (3) once the backoff elapses it does reconnect.
func TestDroppedConnectionReconnectsWithBackoff(t *testing.T) {
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	connections := &fakeConnectionsStore{connections: []store.Connection{liveConnection("conn-1", "channel-1", "access-token-1")}}
	events := newFakeEventStore()
	p := newStreamTestPoller(client, connections, events, &clock)

	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}
	if client.streamConnects != 1 {
		t.Fatalf("streamConnects = %d, want 1 after the initial connect", client.streamConnects)
	}

	client.mu.Lock()
	client.streams["chat-1"].dropWith(youtube.ErrStreamEnded)
	client.mu.Unlock()

	// RunCycle itself always returns nil for a single channel's failure
	// (see RunCycle's own `continue` on a per-channel error — one
	// channel's trouble must never abort the whole cycle); the drop shows
	// up in state instead.
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v, want nil (per-channel errors are swallowed)", err)
	}
	state := p.stateFor("conn-1")
	p.mu.Lock()
	nextPollAt := state.nextPollAt
	failures := state.streamConsecutiveFailures
	p.mu.Unlock()
	if !nextPollAt.After(clock) {
		t.Fatalf("nextPollAt = %v, want a backoff strictly after %v", nextPollAt, clock)
	}
	if failures != 1 {
		t.Fatalf("streamConsecutiveFailures = %d, want 1", failures)
	}

	// Immediately retrying (clock unchanged) must not reconnect yet.
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() [still backing off] unexpected error = %v", err)
	}
	if client.streamConnects != 1 {
		t.Fatalf("streamConnects = %d, want still 1 while backoff has not elapsed", client.streamConnects)
	}

	// Advance past the backoff: now it reconnects.
	clock = clock.Add(5 * time.Second)
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() [after backoff] error = %v", err)
	}
	if client.streamConnects != 2 {
		t.Fatalf("streamConnects = %d, want 2 once the backoff elapsed", client.streamConnects)
	}
}

// TestTokenExpiryMidStreamIsHandled verifies that a stream ending because
// the access token expired forces a real token refresh (not a retry of the
// same now-invalid token) before reconnecting.
func TestTokenExpiryMidStreamIsHandled(t *testing.T) {
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	client.refreshedAccessToken = "refreshed-access-token"
	client.broadcasts["refreshed-access-token"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}

	conn := liveConnection("conn-1", "channel-1", "access-token-1")
	conn.RefreshTokenCiphertext = sql.NullString{String: "enc:refresh-token-1", Valid: true}
	connections := &fakeConnectionsStore{connections: []store.Connection{conn}}
	events := newFakeEventStore()
	p := newStreamTestPoller(client, connections, events, &clock)

	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}
	if client.refreshCalls != 0 {
		t.Fatalf("refreshCalls = %d, want 0 before any expiry is observed", client.refreshCalls)
	}

	// Mid-stream token invalidation: the connection just ends (Google
	// cannot send a fresh 401 mid-stream), surfaced here the same way any
	// other stream end is — but this repo's client marks the CONNECT-time
	// 401 case as youtube.ErrTokenExpired specifically (see
	// StreamLiveChat), so a persistent invalid token is what
	// handleStreamFailure's cache-eviction branch is for. Simulate that:
	// force the next connect attempt to see an expired token.
	client.mu.Lock()
	client.streams["chat-1"].dropWith(youtube.ErrTokenExpired)
	client.streamConnectErr = youtube.ErrTokenExpired
	client.mu.Unlock()

	clock = clock.Add(31 * time.Second)
	_ = p.RunCycle(context.Background()) // observes the drop; connect still fails with ErrTokenExpired

	// Clear the forced connect failure — like a real refresh fixing it —
	// and confirm the poller actually calls RefreshAccessToken rather than
	// looping on the stale cached token.
	client.mu.Lock()
	client.streamConnectErr = nil
	client.mu.Unlock()
	clock = clock.Add(31 * time.Second)
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() [after refresh] error = %v", err)
	}
	if client.refreshCalls == 0 {
		t.Fatal("refreshCalls = 0, want at least 1: a token-expired stream end must force a real refresh, not a retry of the same cached token")
	}
}

// TestFallbackToListEngagesAfterPersistentStreamFailures verifies that
// StreamFailureThreshold consecutive streamList failures switch the
// channel to PollLiveChat for FallbackCooldown, rather than leaving it
// with no chat ingestion at all.
func TestFallbackToListEngagesAfterPersistentStreamFailures(t *testing.T) {
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	client.streamConnectErr = errPersistentStreamFailure
	client.pages["chat-1"] = []youtube.LiveChatPage{
		{Messages: []youtube.RawMessage{rawSuperChat(t, "msg-fallback", "UC_channel-1", "1000000")}, PollingIntervalMs: 100},
	}
	connections := &fakeConnectionsStore{connections: []store.Connection{liveConnection("conn-1", "channel-1", "access-token-1")}}
	events := newFakeEventStore()
	p := newStreamTestPoller(client, connections, events, &clock)
	p.StreamFailureThreshold = 3

	// Discovery cycle, then three failed connect attempts (each needing
	// the clock advanced past its own backoff).
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() [discovery] error = %v", err)
	}
	for i := 0; i < 3; i++ {
		_ = p.RunCycle(context.Background())
		clock = clock.Add(35 * time.Second)
	}

	state := p.stateFor("conn-1")
	p.mu.Lock()
	fallbackUntil := state.fallbackUntil
	p.mu.Unlock()
	if fallbackUntil.IsZero() {
		t.Fatal("fallbackUntil is zero after StreamFailureThreshold consecutive failures, want fallback engaged")
	}
	if client.streamConnects == 0 {
		t.Fatal("streamConnects = 0, want at least one attempted connect before falling back")
	}

	// Now in the fallback window: PollLiveChat must be used and actually
	// deliver chat, proving the creator is not left with no ingestion.
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() [fallback] error = %v", err)
	}
	if client.pageCalls["chat-1"] == 0 {
		t.Fatal("PollLiveChat was never called during the fallback window")
	}
	if len(events.inserted) != 1 || events.inserted[0].SourceID != "msg-fallback" {
		t.Fatalf("inserted = %+v, want exactly [msg-fallback] delivered via the list fallback", events.inserted)
	}
}

var errPersistentStreamFailure = &fallbackTestError{"synthetic persistent streamList failure"}

type fallbackTestError struct{ msg string }

func (e *fallbackTestError) Error() string { return e.msg }
