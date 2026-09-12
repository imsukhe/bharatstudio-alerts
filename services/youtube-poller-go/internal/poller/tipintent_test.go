package poller

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/quota"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/store"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/tipintent"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/youtube"
)

// --- fakes for L15 gap 2 (TipIntent wiring) ---------------------------------

type fakeTipIntentCreator struct {
	mu    sync.Mutex
	calls []tipintent.Request
	resp  *tipintent.Response
	class tipintent.FailureClass
	err   error
}

func (f *fakeTipIntentCreator) Create(_ context.Context, req tipintent.Request) (*tipintent.Response, tipintent.FailureClass, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, req)
	return f.resp, f.class, f.err
}

func (f *fakeTipIntentCreator) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// fakeTipIntentDedup reproduces the real (channel, source_chat_message_id)
// uniqueness constraint 0101 enforces in Postgres, entirely in memory —
// good enough to prove poller.go's wiring calls Reserve/MarkCreated/
// MarkFailed/Release the way the real store's contract requires.
type fakeTipIntentDedup struct {
	mu           sync.Mutex
	keys         map[string]bool   // channelID|messageID -> a row exists (any status)
	dedupKey     map[string]string // dedupID -> key, so Release can find it
	createCalls  int
	failCalls    int
	releaseCalls int
	reserveErr   error
}

func newFakeTipIntentDedup() *fakeTipIntentDedup {
	return &fakeTipIntentDedup{keys: map[string]bool{}, dedupKey: map[string]string{}}
}

func (f *fakeTipIntentDedup) Reserve(_ context.Context, dedupID, channelID, sourceChatMessageID string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.reserveErr != nil {
		return false, f.reserveErr
	}
	key := channelID + "|" + sourceChatMessageID
	if f.keys[key] {
		return false, nil
	}
	f.keys[key] = true
	f.dedupKey[dedupID] = key
	return true, nil
}

func (f *fakeTipIntentDedup) MarkCreated(_ context.Context, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCalls++
	return nil
}

func (f *fakeTipIntentDedup) MarkFailed(_ context.Context, _ string, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failCalls++
	return nil
}

func (f *fakeTipIntentDedup) Release(_ context.Context, dedupID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.releaseCalls++
	if key, ok := f.dedupKey[dedupID]; ok {
		delete(f.keys, key)
		delete(f.dedupKey, dedupID)
	}
	return nil
}

type fakeChatPoster struct {
	mu    sync.Mutex
	calls []string // liveChatID|text, for assertions
}

func (f *fakeChatPoster) PostChatMessage(_ context.Context, _ /* accessToken */, liveChatID, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, liveChatID+"|"+text)
	return nil
}

func rawTextMessage(t *testing.T, id, channelID, displayName, text string) youtube.RawMessage {
	t.Helper()
	details, err := json.Marshal(map[string]string{"messageText": text})
	if err != nil {
		t.Fatal(err)
	}
	var raw youtube.RawMessage
	raw.ID = id
	raw.Snippet.Type = "textMessageEvent"
	raw.Snippet.TextMessageDetails = details
	raw.AuthorDetails.ChannelID = channelID
	raw.AuthorDetails.DisplayName = displayName
	return raw
}

func newTipTestPoller(t *testing.T, creator *fakeTipIntentCreator, dedup *fakeTipIntentDedup, poster *fakeChatPoster, ack bool) *Poller {
	t.Helper()
	var p Poller
	p.Config = Config{Now: time.Now, NewTipIntentDedupID: sequentialIDs()}
	if creator != nil {
		p.Config.TipIntents = creator
	}
	if dedup != nil {
		p.Config.TipIntentDedup = dedup
	}
	if poster != nil {
		p.Config.ChatPoster = poster
	}
	p.Config.TipBotAckEnabled = ack
	return &p
}

func sequentialIDs() func() string {
	n := 0
	return func() string {
		n++
		return "dedup-id-" + string(rune('a'+n-1))
	}
}

// --- tests -------------------------------------------------------------

func TestHandleTipCommandCreatesExactlyOneTipIntent(t *testing.T) {
	creator := &fakeTipIntentCreator{resp: &tipintent.Response{Token: "t", ShortLink: "https://b.st/x"}, class: tipintent.FailureNone}
	dedup := newFakeTipIntentDedup()
	p := newTipTestPoller(t, creator, dedup, nil, false)

	conn := store.Connection{ChannelID: "channel-1"}
	raw := rawTextMessage(t, "msg-1", "UC_viewer", "Rahul", "!tip 100 great stream")

	held := p.handleTipCommand(context.Background(), conn, "access-token", "chat-1", raw, "!tip 100 great stream")
	if held {
		t.Fatal("expected the cursor not to be held for a successful creation")
	}
	if creator.callCount() != 1 {
		t.Fatalf("Create called %d times, want 1", creator.callCount())
	}
	if dedup.createCalls != 1 {
		t.Fatalf("MarkCreated called %d times, want 1", dedup.createCalls)
	}
	got := creator.calls[0]
	if got.ChannelID != "channel-1" || got.AmountPaise != 10000 || got.SourceChannelUserID != "UC_viewer" || got.DonorDisplayName != "Rahul" || got.Message != "great stream" || got.SourcePlatform != "youtube" {
		t.Fatalf("unexpected request: %+v", got)
	}
}

func TestHandleTipCommandDuplicateMessageIDCreatesNone(t *testing.T) {
	creator := &fakeTipIntentCreator{resp: &tipintent.Response{Token: "t", ShortLink: "https://b.st/x"}, class: tipintent.FailureNone}
	dedup := newFakeTipIntentDedup()
	p := newTipTestPoller(t, creator, dedup, nil, false)

	conn := store.Connection{ChannelID: "channel-1"}
	raw := rawTextMessage(t, "msg-dup", "UC_viewer", "Rahul", "!tip 50")

	// First processing (overlapping chat pages, or a retried page after a
	// held cursor) succeeds.
	if held := p.handleTipCommand(context.Background(), conn, "access-token", "chat-1", raw, "!tip 50"); held {
		t.Fatal("first attempt unexpectedly held the cursor")
	}
	// Same message id reprocessed — must be a no-op, not a second TipIntent.
	if held := p.handleTipCommand(context.Background(), conn, "access-token", "chat-1", raw, "!tip 50"); held {
		t.Fatal("reprocessing a duplicate message id unexpectedly held the cursor")
	}

	if creator.callCount() != 1 {
		t.Fatalf("Create called %d times for the same chat message id, want exactly 1", creator.callCount())
	}
}

func TestHandleTipCommandBotAckOffSkipsChatPost(t *testing.T) {
	creator := &fakeTipIntentCreator{resp: &tipintent.Response{Token: "t", ShortLink: "https://b.st/x"}, class: tipintent.FailureNone}
	dedup := newFakeTipIntentDedup()
	poster := &fakeChatPoster{}
	p := newTipTestPoller(t, creator, dedup, poster, false) // ack flag OFF

	conn := store.Connection{ChannelID: "channel-1"}
	raw := rawTextMessage(t, "msg-ack-off", "UC_viewer", "Rahul", "!tip 100")

	p.handleTipCommand(context.Background(), conn, "access-token", "chat-1", raw, "!tip 100")

	if creator.callCount() != 1 {
		t.Fatalf("TipIntent creation was skipped even though only the ack should be gated: Create called %d times", creator.callCount())
	}
	poster.mu.Lock()
	postCount := len(poster.calls)
	poster.mu.Unlock()
	if postCount != 0 {
		t.Fatalf("chat post happened %d times with the bot-ack flag off, want 0", postCount)
	}
}

func TestHandleTipCommandBotAckOnPostsShortLink(t *testing.T) {
	creator := &fakeTipIntentCreator{resp: &tipintent.Response{Token: "t", ShortLink: "https://b.st/x"}, class: tipintent.FailureNone}
	dedup := newFakeTipIntentDedup()
	poster := &fakeChatPoster{}
	p := newTipTestPoller(t, creator, dedup, poster, true) // ack flag ON

	conn := store.Connection{ChannelID: "channel-1"}
	raw := rawTextMessage(t, "msg-ack-on", "UC_viewer", "Rahul", "!tip 100")

	p.handleTipCommand(context.Background(), conn, "access-token", "chat-1", raw, "!tip 100")

	poster.mu.Lock()
	defer poster.mu.Unlock()
	if len(poster.calls) != 1 || poster.calls[0] != "chat-1|@Rahul — support link ready ❤️ https://b.st/x" {
		t.Fatalf("unexpected chat post calls: %+v", poster.calls)
	}
}

func TestHandleTipCommandTransientFailureHoldsCursorAndReleasesReservation(t *testing.T) {
	creator := &fakeTipIntentCreator{class: tipintent.FailureTransient, err: errFakeTransient}
	dedup := newFakeTipIntentDedup()
	p := newTipTestPoller(t, creator, dedup, nil, false)

	conn := store.Connection{ChannelID: "channel-1"}
	raw := rawTextMessage(t, "msg-transient", "UC_viewer", "Rahul", "!tip 100")

	held := p.handleTipCommand(context.Background(), conn, "access-token", "chat-1", raw, "!tip 100")
	if !held {
		t.Fatal("a transient TipIntent creation failure did not hold the cursor")
	}
	if dedup.releaseCalls != 1 {
		t.Fatalf("Release called %d times, want 1", dedup.releaseCalls)
	}
	if dedup.failCalls != 0 {
		t.Fatalf("MarkFailed called %d times for a transient failure, want 0", dedup.failCalls)
	}

	// The released reservation lets the SAME message id be retried and
	// this time succeed.
	creator.class = tipintent.FailureNone
	creator.err = nil
	creator.resp = &tipintent.Response{Token: "t", ShortLink: "https://b.st/x"}
	held = p.handleTipCommand(context.Background(), conn, "access-token", "chat-1", raw, "!tip 100")
	if held {
		t.Fatal("retry after a released transient failure unexpectedly held the cursor")
	}
	if creator.callCount() != 2 {
		t.Fatalf("Create called %d times across the retry, want 2", creator.callCount())
	}
}

func TestHandleTipCommandPermanentFailureDoesNotHoldCursor(t *testing.T) {
	creator := &fakeTipIntentCreator{class: tipintent.FailurePermanent, err: errFakePermanent}
	dedup := newFakeTipIntentDedup()
	p := newTipTestPoller(t, creator, dedup, nil, false)

	conn := store.Connection{ChannelID: "channel-1"}
	raw := rawTextMessage(t, "msg-permanent", "UC_viewer", "Rahul", "!tip 100")

	held := p.handleTipCommand(context.Background(), conn, "access-token", "chat-1", raw, "!tip 100")
	if held {
		t.Fatal("a permanent TipIntent creation failure incorrectly held the cursor (this would wedge the poller)")
	}
	if dedup.failCalls != 1 {
		t.Fatalf("MarkFailed called %d times, want 1", dedup.failCalls)
	}
	if dedup.releaseCalls != 0 {
		t.Fatalf("Release called %d times for a permanent failure, want 0 (must stay terminal)", dedup.releaseCalls)
	}

	// A DIFFERENT message id on the same channel is unaffected.
	otherRaw := rawTextMessage(t, "msg-permanent-2", "UC_viewer", "Rahul", "!tip 100")
	creator.class = tipintent.FailureNone
	creator.err = nil
	creator.resp = &tipintent.Response{Token: "t", ShortLink: "https://b.st/x"}
	if held := p.handleTipCommand(context.Background(), conn, "access-token", "chat-1", otherRaw, "!tip 100"); held {
		t.Fatal("a different message id was unexpectedly held")
	}
	if creator.callCount() != 2 {
		t.Fatalf("Create called %d times, want 2 (one failed permanently, one distinct message succeeded)", creator.callCount())
	}
}

func TestHandleTipCommandBareTipWithNoAmountCreatesNothing(t *testing.T) {
	creator := &fakeTipIntentCreator{resp: &tipintent.Response{Token: "t", ShortLink: "https://b.st/x"}, class: tipintent.FailureNone}
	dedup := newFakeTipIntentDedup()
	p := newTipTestPoller(t, creator, dedup, nil, false)

	conn := store.Connection{ChannelID: "channel-1"}
	raw := rawTextMessage(t, "msg-bare", "UC_viewer", "Rahul", "!tip")

	if held := p.handleTipCommand(context.Background(), conn, "access-token", "chat-1", raw, "!tip"); held {
		t.Fatal("a bare !tip unexpectedly held the cursor")
	}
	if creator.callCount() != 0 {
		t.Fatalf("Create called %d times for a bare !tip with no amount, want 0", creator.callCount())
	}
}

func TestHandleTipCommandNotConfiguredIsANoOp(t *testing.T) {
	p := newTipTestPoller(t, nil, nil, nil, false) // TipIntents/TipIntentDedup both nil

	conn := store.Connection{ChannelID: "channel-1"}
	raw := rawTextMessage(t, "msg-unconfigured", "UC_viewer", "Rahul", "!tip 100")

	if held := p.handleTipCommand(context.Background(), conn, "access-token", "chat-1", raw, "!tip 100"); held {
		t.Fatal("an unconfigured TipIntent feature unexpectedly held the cursor")
	}
}

func TestHandleTipCommandNonCommandTextIsIgnored(t *testing.T) {
	creator := &fakeTipIntentCreator{}
	dedup := newFakeTipIntentDedup()
	p := newTipTestPoller(t, creator, dedup, nil, false)

	conn := store.Connection{ChannelID: "channel-1"}
	raw := rawTextMessage(t, "msg-plain", "UC_viewer", "Rahul", "hello everyone!")

	if held := p.handleTipCommand(context.Background(), conn, "access-token", "chat-1", raw, "hello everyone!"); held {
		t.Fatal("ordinary chat text unexpectedly held the cursor")
	}
	if creator.callCount() != 0 {
		t.Fatalf("Create called %d times for non-command text, want 0", creator.callCount())
	}
}

// --- sentinel errors for the fakes above -----------------------------------

var (
	errFakeTransient = fakeErr("synthetic transient tip intent failure")
	errFakePermanent = fakeErr("synthetic permanent tip intent failure")
)

type fakeErr string

func (e fakeErr) Error() string { return string(e) }

// --- RunCycle-level integration of the wiring above -------------------------

func TestRunCycleTransientTipIntentFailureHoldsPageCursor(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	client.pages["chat-1"] = []youtube.LiveChatPage{
		{Messages: []youtube.RawMessage{rawTextMessage(t, "msg-tip-transient", "UC_viewer", "Rahul", "!tip 100")}, NextPageToken: "page-2", PollingIntervalMs: 4000},
	}
	connections := &fakeConnectionsStore{connections: []store.Connection{liveConnection("conn-1", "channel-1", "access-token-1")}}
	events := newFakeEventStore()
	creator := &fakeTipIntentCreator{class: tipintent.FailureTransient, err: errFakeTransient}
	dedup := newFakeTipIntentDedup()

	p := New(Config{
		Client:                client,
		Connections:           connections,
		Events:                events,
		Protector:             fakeProtector{},
		Budget:                quota.NewBudget(1_000_000, func() time.Time { return now }),
		Now:                   func() time.Time { return now },
		ConfigSnapshotVersion: func(context.Context, string) (int64, error) { return 1, nil },
		MinChatPollDelay:      time.Second,
		PollCycleInterval:     time.Minute,
		TipIntents:            creator,
		TipIntentDedup:        dedup,
	})

	// Discovery and the first chat poll attempt happen inside this single
	// RunCycle (nextPollAt starts at the zero value, so a poll is
	// immediately due). RunCycle itself never surfaces a single channel's
	// pollOne error (it `continue`s to the next channel and always returns
	// nil — see TestTransientInsertFailureHoldsPageCursorForRetry, which
	// asserts the very same "no error" shape for a structured event); the
	// held cursor is what proves the failure was not silently dropped.
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}

	p.mu.Lock()
	pageToken := p.states["conn-1"].pageToken
	p.mu.Unlock()
	if pageToken != "" {
		t.Fatalf("page cursor advanced to %q despite a transient TipIntent failure; want it held", pageToken)
	}
	if dedup.releaseCalls != 1 {
		t.Fatalf("Release called %d times, want 1", dedup.releaseCalls)
	}
}

func TestRunCyclePermanentTipIntentFailureAdvancesPageCursor(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	client.pages["chat-1"] = []youtube.LiveChatPage{
		{Messages: []youtube.RawMessage{rawTextMessage(t, "msg-tip-permanent", "UC_viewer", "Rahul", "!tip 100")}, NextPageToken: "page-2", PollingIntervalMs: 4000},
	}
	connections := &fakeConnectionsStore{connections: []store.Connection{liveConnection("conn-1", "channel-1", "access-token-1")}}
	events := newFakeEventStore()
	creator := &fakeTipIntentCreator{class: tipintent.FailurePermanent, err: errFakePermanent}
	dedup := newFakeTipIntentDedup()

	p := New(Config{
		Client:                client,
		Connections:           connections,
		Events:                events,
		Protector:             fakeProtector{},
		Budget:                quota.NewBudget(1_000_000, func() time.Time { return now }),
		Now:                   func() time.Time { return now },
		ConfigSnapshotVersion: func(context.Context, string) (int64, error) { return 1, nil },
		MinChatPollDelay:      time.Second,
		PollCycleInterval:     time.Minute,
		TipIntents:            creator,
		TipIntentDedup:        dedup,
	})

	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() [discovery] error = %v", err)
	}
	// A permanent failure (this task's own scenario: a failed TipIntent
	// creation must not wedge the poller's page cursor) must let the
	// cycle succeed and the cursor advance past the offending message.
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() unexpectedly failed on a permanent TipIntent failure: %v", err)
	}

	p.mu.Lock()
	pageToken := p.states["conn-1"].pageToken
	p.mu.Unlock()
	if pageToken != "page-2" {
		t.Fatalf("page cursor = %q, want it to advance to page-2 despite the permanent TipIntent failure", pageToken)
	}
	if dedup.failCalls != 1 {
		t.Fatalf("MarkFailed called %d times, want 1", dedup.failCalls)
	}
}

func TestRunCycleTipCommandsDoNotInterfereWithStructuredEvents(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := newFakeClient()
	client.broadcasts["access-token-1"] = &youtube.LiveBroadcast{ID: "b1", ActiveLiveChatID: "chat-1"}
	client.pages["chat-1"] = []youtube.LiveChatPage{
		{Messages: []youtube.RawMessage{
			rawTextMessage(t, "msg-tip", "UC_viewer", "Rahul", "!tip 100"),
			rawSuperChat(t, "msg-superchat", "UC_channel-1", "5000000"),
		}, NextPageToken: "page-2", PollingIntervalMs: 4000},
	}
	connections := &fakeConnectionsStore{connections: []store.Connection{liveConnection("conn-1", "channel-1", "access-token-1")}}
	events := newFakeEventStore()
	creator := &fakeTipIntentCreator{resp: &tipintent.Response{Token: "t", ShortLink: "https://b.st/x"}, class: tipintent.FailureNone}
	dedup := newFakeTipIntentDedup()

	p := New(Config{
		Client:                client,
		Connections:           connections,
		Events:                events,
		Protector:             fakeProtector{},
		Budget:                quota.NewBudget(1_000_000, func() time.Time { return now }),
		Now:                   func() time.Time { return now },
		ConfigSnapshotVersion: func(context.Context, string) (int64, error) { return 1, nil },
		MinChatPollDelay:      time.Second,
		PollCycleInterval:     time.Minute,
		TipIntents:            creator,
		TipIntentDedup:        dedup,
	})

	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() [discovery] error = %v", err)
	}
	if err := p.RunCycle(context.Background()); err != nil {
		t.Fatalf("RunCycle() error = %v", err)
	}

	events.mu.Lock()
	insertedCount := len(events.inserted)
	events.mu.Unlock()
	if insertedCount != 1 {
		t.Fatalf("inserted %d structured events, want 1 (the Super Chat only — !tip must never reach InsertLiveEvent)", insertedCount)
	}
	if creator.callCount() != 1 {
		t.Fatalf("Create called %d times, want 1", creator.callCount())
	}
}
