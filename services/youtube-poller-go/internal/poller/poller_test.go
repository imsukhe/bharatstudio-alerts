package poller

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/domain"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/quota"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/store"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/youtube"
)

// --- fakes -----------------------------------------------------------------

type fakeClient struct {
	mu sync.Mutex

	broadcasts           map[string]*youtube.LiveBroadcast // access token -> broadcast (nil entry = not live)
	pages                map[string][]youtube.LiveChatPage // liveChatID -> queued pages, consumed in order
	pageCalls            map[string]int
	broadcastErr         error
	pollErr              error
	refreshedAccessToken string
	refreshCalls         int

	// streamConnectErr, when set, is returned by every StreamLiveChat call
	// instead of opening a stream (simulates streamList being unavailable,
	// for fallback-engagement tests).
	streamConnectErr error
	streamConnects   int
	// streams tracks every fakeChatStream this client has ever handed out,
	// keyed by liveChatID, so a test can reach in and simulate a mid-stream
	// drop (streams[id].dropWith(err)) independently of connect-time
	// failures.
	streams map[string]*fakeChatStream
}

// fakeChatStream serves the same client.pages/pageCalls queue a
// PollLiveChat fake page-list would, but as streamed chunks: each queued
// youtube.LiveChatPage becomes one Recv() chunk. Once the queue is
// exhausted it blocks like a real idle connection until the caller's ctx
// (streamOne's bounded StreamReadWindow) ends — never returning a
// synthetic "no data" error, so tests exercise the exact same
// context.DeadlineExceeded path production hits.
type fakeChatStream struct {
	client     *fakeClient
	liveChatID string

	mu       sync.Mutex
	dropErr  error // set by dropWith to simulate a mid-stream drop/error
	closed   bool
}

func (s *fakeChatStream) dropWith(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropErr = err
}

func (s *fakeChatStream) Recv(ctx context.Context) (*youtube.LiveChatPage, error) {
	s.mu.Lock()
	if s.dropErr != nil {
		err := s.dropErr
		s.dropErr = nil
		s.mu.Unlock()
		return nil, err
	}
	s.mu.Unlock()

	s.client.mu.Lock()
	if s.client.pollErr != nil {
		err := s.client.pollErr
		s.client.mu.Unlock()
		return nil, err
	}
	queue := s.client.pages[s.liveChatID]
	idx := s.client.pageCalls[s.liveChatID]
	if idx >= len(queue) {
		s.client.mu.Unlock()
		<-ctx.Done()
		return nil, ctx.Err()
	}
	s.client.pageCalls[s.liveChatID] = idx + 1
	page := queue[idx]
	s.client.mu.Unlock()
	return &page, nil
}

func (s *fakeChatStream) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return nil
}

func newFakeClient() *fakeClient {
	return &fakeClient{
		broadcasts: make(map[string]*youtube.LiveBroadcast),
		pages:      make(map[string][]youtube.LiveChatPage),
		pageCalls:  make(map[string]int),
		streams:    make(map[string]*fakeChatStream),
	}
}

func (f *fakeClient) StreamLiveChat(_ context.Context, _ string, liveChatID string) (youtube.ChatStream, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.streamConnects++
	if f.streamConnectErr != nil {
		return nil, f.streamConnectErr
	}
	s := &fakeChatStream{client: f, liveChatID: liveChatID}
	f.streams[liveChatID] = s
	return s, nil
}

func (f *fakeClient) ActiveBroadcastForChannel(_ context.Context, accessToken string) (*youtube.LiveBroadcast, error) {
	if f.broadcastErr != nil {
		return nil, f.broadcastErr
	}
	return f.broadcasts[accessToken], nil
}

func (f *fakeClient) PollLiveChat(_ context.Context, _ string, liveChatID string, _ string) (*youtube.LiveChatPage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pollErr != nil {
		return nil, f.pollErr
	}
	queue := f.pages[liveChatID]
	idx := f.pageCalls[liveChatID]
	f.pageCalls[liveChatID] = idx + 1
	if idx >= len(queue) {
		return &youtube.LiveChatPage{PollingIntervalMs: 5000}, nil
	}
	page := queue[idx]
	return &page, nil
}

func (f *fakeClient) RefreshAccessToken(_ context.Context, _, _, _ string) (*youtube.RefreshedToken, error) {
	f.refreshCalls++
	return &youtube.RefreshedToken{AccessToken: f.refreshedAccessToken, ExpiresIn: 3600}, nil
}

type fakeConnectionsStore struct {
	connections []store.Connection
	updated     map[string]string // connectionID -> new ciphertext, for assertions
}

func (f *fakeConnectionsStore) ActiveConnections(_ context.Context) ([]store.Connection, error) {
	return f.connections, nil
}

func (f *fakeConnectionsStore) UpdateAccessToken(_ context.Context, connectionID, ciphertext, _ string, _ time.Time) error {
	if f.updated == nil {
		f.updated = make(map[string]string)
	}
	f.updated[connectionID] = ciphertext
	return nil
}

type fakeEventStore struct {
	mu       sync.Mutex
	inserted []domain.LiveEvent
	seen     map[string]bool // channelID+"|"+sourceID, to reproduce the real dedup outcome

	// failSourceIDs forces InsertLiveEvent to fail for these source ids
	// instead of inserting: "transient" returns a non-sentinel error (as if
	// every InsertLiveEvent-internal retry had already been exhausted),
	// "permanent" returns store.ErrPermanentFailure (as if the failure had
	// already been durably recorded).
	failSourceIDs map[string]string
}

func newFakeEventStore() *fakeEventStore {
	return &fakeEventStore{seen: make(map[string]bool), failSourceIDs: map[string]string{}}
}

func (f *fakeEventStore) InsertLiveEvent(_ context.Context, channelID string, _ int64, _ string, event domain.LiveEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if mode, ok := f.failSourceIDs[event.SourceID]; ok {
		switch mode {
		case "permanent":
			return fmt.Errorf("%w: synthetic permanent failure", store.ErrPermanentFailure)
		default:
			return errors.New("synthetic transient failure: retries exhausted")
		}
	}
	key := channelID + "|" + event.SourceID
	if f.seen[key] {
		return store.ErrDuplicateEvent
	}
	f.seen[key] = true
	f.inserted = append(f.inserted, event)
	return nil
}

// fakeProtector is a pass-through "encryption" so tests never touch real
// crypto: it just needs to round-trip and be distinguishable from a
// plaintext token for assertions.
type fakeProtector struct{}

func (fakeProtector) Decrypt(envelope string) (string, error) {
	return envelope[len("enc:"):], nil
}
func (fakeProtector) Encrypt(token string) (string, error) { return "enc:" + token, nil }
func (fakeProtector) Fingerprint(token string) string      { return "fp:" + token }

func rawSuperChat(t *testing.T, id, channelID string, amountMicros string) youtube.RawMessage {
	t.Helper()
	details, err := json.Marshal(map[string]any{
		"amountMicros": amountMicros,
		"currency":     "USD",
		"userComment":  "hi",
	})
	if err != nil {
		t.Fatal(err)
	}
	var raw youtube.RawMessage
	raw.ID = id
	raw.Snippet.Type = "superChatEvent"
	raw.Snippet.SuperChatDetails = details
	raw.AuthorDetails.ChannelID = channelID
	raw.AuthorDetails.DisplayName = "Viewer"
	return raw
}

func newTestPoller(t *testing.T, client *fakeClient, connections *fakeConnectionsStore, events *fakeEventStore, now time.Time) *Poller {
	t.Helper()
	clock := now
	return New(Config{
		Client:                client,
		Connections:           connections,
		Events:                events,
		Protector:             fakeProtector{},
		Budget:                quota.NewBudget(1_000_000, func() time.Time { return clock }),
		Now:                   func() time.Time { return clock },
		ConfigSnapshotVersion: func(context.Context, string) (int64, error) { return 1, nil },
		MinChatPollDelay:      time.Second,
		PollCycleInterval:     time.Minute,
		// Kept tiny so a test that drains an exhausted fake stream queue
		// (which blocks on ctx.Done() until the window elapses — see
		// fakeChatStream.Recv) does not actually sleep for wall-clock
		// seconds.
		StreamReadWindow: 5 * time.Millisecond,
	})
}

func liveConnection(id, channelID, accessToken string) store.Connection {
	return store.Connection{
		ID:                    id,
		ChannelID:             channelID,
		ExternalChannelID:     "UC_" + channelID,
		AccessTokenCiphertext: sql.NullString{String: "enc:" + accessToken, Valid: true},
		TokenExpiresAt:        sql.NullTime{Time: time.Now().Add(time.Hour), Valid: true},
	}
}

// --- tests ------------------------------------------------------------------

func TestRunCycleDiscoversLiveChannelAndInsertsNormalisedEvent(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	client.pages["chat-1"] = []youtube.LiveChatPage{
		{Messages: []youtube.RawMessage{rawSuperChat(t, "msg-1", "UC_channel-1", "5000000")}, NextPageToken: "p2", PollingIntervalMs: 4000},
	}

	connections := &fakeConnectionsStore{connections: []store.Connection{liveConnection("conn-1", "channel-1", "access-token-1")}}
	events := newFakeEventStore()
	p := newTestPoller(t, client, connections, events, now)

	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}
	// Discovery only marks the channel live; chat still needs to be due
	// (nextPollAt starts at zero value, so it is due immediately).
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() [second pass] error = %v", err)
	}

	events.mu.Lock()
	defer events.mu.Unlock()
	if len(events.inserted) != 1 {
		t.Fatalf("inserted %d events, want 1: %+v", len(events.inserted), events.inserted)
	}
	got := events.inserted[0]
	if got.SourceID != "msg-1" || got.SourceEventType != domain.EventSuperChat || got.SourceUserID != "UC_channel-1" {
		t.Fatalf("unexpected event: %+v", got)
	}
	if got.Payload.AmountMinorUnits == nil || *got.Payload.AmountMinorUnits != 500 {
		t.Fatalf("amountMinorUnits = %v, want 500", got.Payload.AmountMinorUnits)
	}
}

func TestIdempotentRedeliveryOfSameMessageIDIsNotDuplicated(t *testing.T) {
	events := newFakeEventStore()
	event := domain.LiveEvent{SourceType: "youtube", SourceID: "dup-1", SourceEventType: domain.EventSuperChat, SourceUserID: "UC_x"}

	if err := events.InsertLiveEvent(context.Background(), "channel-1", 1, "trace-1", event); err != nil {
		t.Fatalf("first insert error = %v", err)
	}
	err := events.InsertLiveEvent(context.Background(), "channel-1", 1, "trace-1", event)
	if !errors.Is(err, store.ErrDuplicateEvent) {
		t.Fatalf("second insert error = %v, want ErrDuplicateEvent", err)
	}
	if len(events.inserted) != 1 {
		t.Fatalf("inserted count = %d, want 1 (no duplicate row)", len(events.inserted))
	}

	// A restart / overlapping poll replaying the same page must be
	// similarly harmless: poller.pollOne treats ErrDuplicateEvent as a
	// no-op, not a failure that would abort the rest of the page.
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	client.pages["chat-1"] = []youtube.LiveChatPage{
		{Messages: []youtube.RawMessage{rawSuperChat(t, "dup-1", "UC_channel-1", "1000000")}},
	}
	connections := &fakeConnectionsStore{connections: []store.Connection{liveConnection("conn-1", "channel-1", "access-token-1")}}
	events2 := newFakeEventStore()
	if err := events2.InsertLiveEvent(context.Background(), "channel-1", 1, "trace", domain.LiveEvent{SourceID: "dup-1"}); err != nil {
		t.Fatal(err)
	}
	p := newTestPoller(t, client, connections, events2, time.Now())
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() [second pass] error = %v", err)
	}
	if len(events2.inserted) != 1 {
		t.Fatalf("inserted %d events after replaying an already-seen message id, want 1 (the pre-seeded row only)", len(events2.inserted))
	}
}

func TestQuotaExhaustionStopsFurtherSpendForTheDay(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcastErr = youtube.ErrQuotaExceeded

	connections := &fakeConnectionsStore{connections: []store.Connection{liveConnection("conn-1", "channel-1", "access-token-1")}}
	events := newFakeEventStore()
	p := newTestPoller(t, client, connections, events, now)

	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}
	if !p.Budget.Exhausted() {
		t.Fatal("Budget.Exhausted() = false after a quotaExceeded response, want true")
	}
	if got := p.Budget.Remaining(); got != 0 {
		t.Fatalf("Budget.Remaining() = %d, want 0 once exhausted", got)
	}

	// A second cycle must not call the API again for discovery (graceful
	// degradation: no further spend attempted once exhausted).
	client.broadcastErr = errors.New("should not be called again")
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() [second pass] error = %v", err)
	}
}

func TestFairShareCapsAPollForOneBusyChannelSoOthersAreNotStarved(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	client.broadcasts["access-token-2"] = &youtube.LiveBroadcast{ID: "b2", ActiveLiveChatID: "chat-2"}
	// chat-1 has many pages queued (a "busy" channel); chat-2 has one.
	for i := 0; i < 100; i++ {
		client.pages["chat-1"] = append(client.pages["chat-1"], youtube.LiveChatPage{PollingIntervalMs: 100})
	}
	client.pages["chat-2"] = []youtube.LiveChatPage{{PollingIntervalMs: 100}}

	connections := &fakeConnectionsStore{connections: []store.Connection{
		liveConnection("conn-1", "channel-1", "access-token-1"),
		liveConnection("conn-2", "channel-2", "access-token-2"),
	}}
	events := newFakeEventStore()
	// A tiny total budget forces a small, easy-to-check fair share.
	p := New(Config{
		Client:                client,
		Connections:           connections,
		Events:                events,
		Protector:             fakeProtector{},
		Budget:                quota.NewBudget(2*quota.CostLiveChatMessagesList+2*quota.CostLiveBroadcastsList, func() time.Time { return now }),
		Now:                   func() time.Time { return now },
		ConfigSnapshotVersion: func(context.Context, string) (int64, error) { return 1, nil },
		MinChatPollDelay:      0,
		PollCycleInterval:     time.Minute,
		StreamReadWindow:      5 * time.Millisecond,
	})

	// Discovery cycle.
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}
	// Chat cycles: run many times; chat-1 must not be able to consume
	// chat-2's share even though it has far more pages queued.
	for i := 0; i < 20; i++ {
		if err := p.RunCycle(context.Background()); err != nil {
			t.Fatalf("RunCycle() iteration %d error = %v", i, err)
		}
	}

	calls1 := client.pageCalls["chat-1"]
	calls2 := client.pageCalls["chat-2"]
	if calls1 == 0 {
		t.Fatal("chat-1 was never streamed")
	}
	if calls2 == 0 {
		t.Fatal("chat-2 (the less busy channel) was starved: never streamed while chat-1 kept its connection open")
	}
	// Fair share now gates CONNECTS, not messages: streamList is charged
	// once per connect (CostLiveChatMessagesStreamList), not per message,
	// so a channel's fair share of (2*5=10 units after 2*1 discovery
	// spend, 5 units each) buys it exactly one connect — after that,
	// draining however many messages arrive on that already-open
	// connection is free, which is why chat-1 (the "busy" channel) can
	// legitimately drain all 100 of its queued messages once connected.
	// The invariant this test actually protects is that chat-1 being busy
	// never prevents chat-2 from getting ITS one connect too.
	if client.streamConnects != 2 {
		t.Fatalf("total stream connects = %d, want exactly 2 (one per channel's fair share)", client.streamConnects)
	}
	if calls1 != 100 {
		t.Fatalf("chat-1 drained %d of its 100 queued messages, want all 100 once connected (no per-message quota cost)", calls1)
	}
	if calls2 != 1 {
		t.Fatalf("chat-2 drained %d of its 1 queued message, want 1", calls2)
	}
}

func TestExpiredAccessTokenIsRefreshedBeforePolling(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.refreshedAccessToken = "fresh-access-token"
	client.broadcasts["fresh-access-token"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}

	expiredConnection := liveConnection("conn-1", "channel-1", "stale-access-token")
	expiredConnection.TokenExpiresAt = sql.NullTime{Time: now.Add(-time.Hour), Valid: true}
	expiredConnection.RefreshTokenCiphertext = sql.NullString{String: "enc:refresh-token", Valid: true}

	connections := &fakeConnectionsStore{connections: []store.Connection{expiredConnection}}
	events := newFakeEventStore()
	p := newTestPoller(t, client, connections, events, now)

	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}
	if client.refreshCalls != 1 {
		t.Fatalf("refresh calls = %d, want 1", client.refreshCalls)
	}
	if connections.updated["conn-1"] != "enc:fresh-access-token" {
		t.Fatalf("stored ciphertext = %q, want the refreshed token re-encrypted", connections.updated["conn-1"])
	}
}

func TestBackoffMarksBudgetExhaustedOnQuotaErrorDuringChatPoll(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	connections := &fakeConnectionsStore{connections: []store.Connection{liveConnection("conn-1", "channel-1", "access-token-1")}}
	events := newFakeEventStore()
	p := newTestPoller(t, client, connections, events, now)

	// Discovery and the first chat poll happen inside a single RunCycle
	// when the channel is discovered live and its cursor is fresh (nextPollAt
	// starts at the zero value, so it is immediately due) — so the quota
	// error must already be wired in before this one call.
	client.pollErr = youtube.ErrQuotaExceeded
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}
	if !p.Budget.Exhausted() {
		t.Fatal("Budget.Exhausted() = false after quotaExceeded from PollLiveChat, want true")
	}
}

func TestTransientInsertFailureForcesStreamReconnectForRetry(t *testing.T) {
	// A polling channel holds its pageToken in place on a transient
	// failure so the same page is re-fetched next cycle (see
	// TestPermanentInsertFailureIsRecordedAndCursorAdvances's polling
	// sibling in git history / the fallback path exercised by
	// TestFallbackToListEngagesAfterPersistentStreamFailures). A streamed
	// message has no pageToken to hold — once delivered on the wire it
	// cannot be re-requested from the same connection — so streamOne's
	// retry mechanism is instead to force a reconnect: see
	// poller.go:streamOne's forced-Close comment. Google's own documented
	// "recent chat history" replay on connect is what makes the retry
	// actually happen.
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	client.pages["chat-1"] = []youtube.LiveChatPage{
		{Messages: []youtube.RawMessage{rawSuperChat(t, "msg-transient", "UC_channel-1", "1000000")}, PollingIntervalMs: 4000},
	}
	connections := &fakeConnectionsStore{connections: []store.Connection{liveConnection("conn-1", "channel-1", "access-token-1")}}
	events := newFakeEventStore()
	events.failSourceIDs["msg-transient"] = "transient"
	p := newTestPoller(t, client, connections, events, now)

	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}
	if len(events.inserted) != 0 {
		t.Fatalf("inserted %d events, want 0: a transient failure must not be silently treated as delivered", len(events.inserted))
	}
	state := p.stateFor("conn-1")
	p.mu.Lock()
	stillOpen := state.stream != nil
	p.mu.Unlock()
	if stillOpen {
		t.Fatal("stream still open after a transient insert failure, want it closed so the next cycle reconnects")
	}
	if client.streamConnects != 1 {
		t.Fatalf("streamConnects = %d, want 1 (only the original connect so far)", client.streamConnects)
	}

	// Next cycle reconnects. Google's documented reconnect-history replay
	// means the SAME message id is expected to arrive again on the fresh
	// connection — simulate that (the earlier one was already consumed
	// off the fake's queue by the first, failed, delivery) and resolve
	// the underlying condition, as a real retry would.
	client.pages["chat-1"] = append(client.pages["chat-1"], youtube.LiveChatPage{
		Messages: []youtube.RawMessage{rawSuperChat(t, "msg-transient", "UC_channel-1", "1000000")},
	})
	delete(events.failSourceIDs, "msg-transient")
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() [reconnect] error = %v", err)
	}
	if client.streamConnects != 2 {
		t.Fatalf("streamConnects = %d, want 2 (one forced reconnect after the transient failure)", client.streamConnects)
	}
	if len(events.inserted) != 1 || events.inserted[0].SourceID != "msg-transient" {
		t.Fatalf("inserted = %+v, want exactly [msg-transient] (message recovered via reconnect, not lost)", events.inserted)
	}
}

// TestStreamReconnectReplayIsNotDuplicated is this task's core safety
// requirement: a streamList reconnect replays "recent chat history" per
// Google's own docs, and that replay must be a no-op against
// alert_events, never a second alert_events row / second financial event.
func TestStreamReconnectReplayIsNotDuplicated(t *testing.T) {
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	client.pages["chat-1"] = []youtube.LiveChatPage{
		{Messages: []youtube.RawMessage{rawSuperChat(t, "msg-1", "UC_channel-1", "1000000")}},
	}
	connections := &fakeConnectionsStore{connections: []store.Connection{liveConnection("conn-1", "channel-1", "access-token-1")}}
	events := newFakeEventStore()
	p := New(Config{
		Client:                client,
		Connections:           connections,
		Events:                events,
		Protector:             fakeProtector{},
		Budget:                quota.NewBudget(1_000_000, func() time.Time { return clock }),
		Now:                   func() time.Time { return clock },
		ConfigSnapshotVersion: func(context.Context, string) (int64, error) { return 1, nil },
		MinChatPollDelay:      time.Second,
		PollCycleInterval:     time.Minute,
		StreamReadWindow:      5 * time.Millisecond,
	})

	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}
	if len(events.inserted) != 1 {
		t.Fatalf("inserted %d events after first delivery, want 1", len(events.inserted))
	}

	// Simulate a drop and reconnect: force the live stream's next Recv to
	// fail (a network drop looks the same from streamOne's side as any
	// other stream-ended error) and re-queue the SAME message id, exactly
	// as Google's documented "recent chat history" replay would on a real
	// reconnect.
	client.mu.Lock()
	client.streams["chat-1"].dropWith(youtube.ErrStreamEnded)
	client.pages["chat-1"] = append(client.pages["chat-1"], youtube.LiveChatPage{
		Messages: []youtube.RawMessage{rawSuperChat(t, "msg-1", "UC_channel-1", "1000000")},
	})
	client.mu.Unlock()

	// Cycle 1: observes the drop, closes the stream, schedules a backoff
	// reconnect. Advance the fake clock past every possible backoff
	// (max 30s) between cycles so the reconnect is never held back by
	// nextPollAt — this test is about replay safety, not backoff timing
	// (see TestDroppedConnectionReconnectsWithBackoff for that).
	for i := 0; i < 3; i++ {
		_ = p.RunCycle(context.Background())
		clock = clock.Add(31 * time.Second)
	}

	if len(events.inserted) != 1 {
		t.Fatalf("inserted %d events after a reconnect replayed msg-1, want 1 (still exactly the first insert — replay must be a no-op)", len(events.inserted))
	}
	if client.streamConnects < 2 {
		t.Fatalf("streamConnects = %d, want at least 2 (the drop must have caused a reconnect)", client.streamConnects)
	}
}

func TestPermanentInsertFailureIsRecordedAndCursorAdvances(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	client.pages["chat-1"] = []youtube.LiveChatPage{
		{Messages: []youtube.RawMessage{
			rawSuperChat(t, "msg-bad", "UC_channel-1", "1000000"),
			rawSuperChat(t, "msg-good", "UC_channel-1", "2000000"),
		}, NextPageToken: "p2", PollingIntervalMs: 4000},
	}
	connections := &fakeConnectionsStore{connections: []store.Connection{liveConnection("conn-1", "channel-1", "access-token-1")}}
	events := newFakeEventStore()
	events.failSourceIDs["msg-bad"] = "permanent"
	p := newTestPoller(t, client, connections, events, now)

	// Discovery and the first chat stream connect happen inside this
	// single RunCycle.
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}

	state := p.stateFor("conn-1")
	p.mu.Lock()
	stillOpen := state.stream != nil
	p.mu.Unlock()
	if !stillOpen {
		t.Fatal("stream closed after a permanent (already-recorded) failure, want it left open: a confirmed-permanent rejection must not wedge the channel or force a reconnect")
	}
	if client.streamConnects != 1 {
		t.Fatalf("streamConnects = %d, want 1: a permanent failure must not trigger a reconnect", client.streamConnects)
	}
	if len(events.inserted) != 1 || events.inserted[0].SourceID != "msg-good" {
		t.Fatalf("inserted = %+v, want exactly [msg-good]: the permanently-rejected message must not be inserted, and must not block its neighbour on the same connection", events.inserted)
	}
}
