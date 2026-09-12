// Package poller orchestrates discovery ("which connected channels are
// live right now") and live-chat polling ("read that channel's chat,
// respecting the server's own pacing and this process's quota budget"),
// normalising each message via internal/domain and persisting it via
// internal/store.
//
// See internal/quota for the budget/fair-share/backoff model this package
// enforces on every call into the YouTube Data API.
package poller

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/chatcommand"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/domain"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/quota"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/store"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/tipintent"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/youtube"
)

// --- narrow interfaces so this package is unit-testable without a real DB or network ---

type ytClient interface {
	ActiveBroadcastForChannel(ctx context.Context, accessToken string) (*youtube.LiveBroadcast, error)
	PollLiveChat(ctx context.Context, accessToken, liveChatID, pageToken string) (*youtube.LiveChatPage, error)
	RefreshAccessToken(ctx context.Context, clientID, clientSecret, refreshToken string) (*youtube.RefreshedToken, error)
}

type connectionsStore interface {
	ActiveConnections(ctx context.Context) ([]store.Connection, error)
	UpdateAccessToken(ctx context.Context, connectionID, ciphertext, fingerprint string, expiresAt time.Time) error
}

type eventStore interface {
	InsertLiveEvent(ctx context.Context, channelID string, configSnapshotVersion int64, traceID string, event domain.LiveEvent) error
}

type protector interface {
	Decrypt(envelope string) (string, error)
	Encrypt(token string) (string, error)
	Fingerprint(token string) string
}

// tipIntentCreator is internal/tipintent.Client's shape, narrowed for
// testability (a fake never has to speak HTTP).
type tipIntentCreator interface {
	Create(ctx context.Context, req tipintent.Request) (*tipintent.Response, tipintent.FailureClass, error)
}

// tipIntentDedupStore is internal/store.TipIntentDedupStore's shape (0101):
// the per-chat-message-id idempotency gate. See its own doc comments for
// what each method guarantees.
type tipIntentDedupStore interface {
	Reserve(ctx context.Context, dedupID, channelID, sourceChatMessageID string) (bool, error)
	MarkCreated(ctx context.Context, dedupID string) error
	MarkFailed(ctx context.Context, dedupID, errorDetail string) error
	Release(ctx context.Context, dedupID string) error
}

// chatPoster is internal/youtube.Client's PostChatMessage, narrowed and
// kept access-token-aware here (chatcommand.ChatPoster itself is not —
// chatPosterAdapter below bridges the two) so a fake never needs a real
// YouTube client either.
type chatPoster interface {
	PostChatMessage(ctx context.Context, accessToken, liveChatID, text string) error
}

// chatPosterAdapter binds one resolved accessToken to a chatPoster so it
// satisfies chatcommand.ChatPoster (which carries no token of its own —
// see internal/chatcommand/ack.go).
type chatPosterAdapter struct {
	poster      chatPoster
	accessToken string
}

func (a chatPosterAdapter) PostChatMessage(ctx context.Context, liveChatID, text string) error {
	return a.poster.PostChatMessage(ctx, a.accessToken, liveChatID, text)
}

// channelState is the poller's in-memory (never persisted — see
// Idempotency note on store.EventStore) view of one connection's live
// status and chat cursor.
type channelState struct {
	liveChatID      string // empty when not currently known to be live
	pageToken       string
	nextPollAt      time.Time
	lastDiscoveryAt time.Time
	epochSpent      int64 // quota units spent by this channel in the current fairness epoch
}

// Config is the by-value construction argument for New — kept separate
// from Poller itself so Poller (which holds a sync.Mutex) is never copied.
type Config struct {
	Client       ytClient
	Connections  connectionsStore
	Events       eventStore
	Protector    protector
	DB           *sql.DB // only for the default ConfigSnapshotVersion; never queried for tokens directly
	Budget       *quota.Budget
	ClientID     string
	ClientSecret string

	PollCycleInterval time.Duration
	MinChatPollDelay  time.Duration

	Now func() time.Time

	// ConfigSnapshotVersion resolves the channel's current config version
	// to stamp on alert_events, the same way the manual/webhook insert
	// paths do (0019, 0007). Defaults to store.LatestConfigSnapshotVersion
	// against DB; tests inject a fake so this package needs no real
	// database.
	ConfigSnapshotVersion func(ctx context.Context, channelID string) (int64, error)

	// TipIntents/TipIntentDedup wire a parsed !tip through to
	// POST /v1/public/internal/tip-intents (L15 gap 2). Either or both may
	// be nil, in which case a !tip is parsed but never acted on — the
	// same "optional, feature simply does not run" shape
	// apps/api/src/routes/tts.ts uses for its own optional quotaMeter.
	TipIntents     tipIntentCreator
	TipIntentDedup tipIntentDedupStore

	// ChatPoster/TipBotAckEnabled gate posting the TipIntent short link
	// back into chat. TipBotAckEnabled MUST default to false in every
	// caller of New — see chatcommand.PostTipAcknowledgement's own doc
	// comment and Config.TipBotAckEnabled in internal/config.
	ChatPoster       chatPoster
	TipBotAckEnabled bool

	// NewTipIntentDedupID generates the row id passed to
	// TipIntentDedup.Reserve. Defaults to uuid.New().String(); tests
	// inject a deterministic sequence.
	NewTipIntentDedupID func() string
}

type cachedAccessToken struct {
	value     string
	expiresAt time.Time
}

type Poller struct {
	Config

	mu         sync.Mutex
	states     map[string]*channelState // keyed by connection ID
	tokenCache map[string]cachedAccessToken
}

func (p *Poller) cacheToken(connectionID, token string, expiresAt time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.tokenCache[connectionID] = cachedAccessToken{value: token, expiresAt: expiresAt}
}

func New(cfg Config) *Poller {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.MinChatPollDelay <= 0 {
		cfg.MinChatPollDelay = 2 * time.Second
	}
	if cfg.PollCycleInterval <= 0 {
		cfg.PollCycleInterval = 20 * time.Second
	}
	if cfg.ConfigSnapshotVersion == nil {
		database := cfg.DB
		cfg.ConfigSnapshotVersion = func(ctx context.Context, channelID string) (int64, error) {
			return store.LatestConfigSnapshotVersion(ctx, database, channelID)
		}
	}
	if cfg.NewTipIntentDedupID == nil {
		cfg.NewTipIntentDedupID = func() string { return uuid.New().String() }
	}
	return &Poller{Config: cfg, states: make(map[string]*channelState), tokenCache: make(map[string]cachedAccessToken)}
}

// RunForever calls RunCycle on a fixed tick until ctx is cancelled. Each
// individual channel's chat pacing is governed by pollingIntervalMillis
// from YouTube (see channelState.nextPollAt), not by this outer tick —
// the tick only bounds how often the poller re-checks for state changes
// (newly live/offline channels, budget resets).
func (p *Poller) RunForever(ctx context.Context, logger *log.Logger) {
	ticker := time.NewTicker(p.PollCycleInterval)
	defer ticker.Stop()
	for {
		if err := p.RunCycle(ctx); err != nil && logger != nil {
			logger.Printf("youtube poller cycle error: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// RunCycle performs one discovery+poll pass across every active
// connection. It is the unit tests exercise directly.
func (p *Poller) RunCycle(ctx context.Context) error {
	now := p.Now()

	connections, err := p.Connections.ActiveConnections(ctx)
	if err != nil {
		return fmt.Errorf("list active connections: %w", err)
	}

	p.mu.Lock()
	// Drop state for connections that were revoked/removed since last cycle.
	seen := make(map[string]bool, len(connections))
	for _, c := range connections {
		seen[c.ID] = true
	}
	for id := range p.states {
		if !seen[id] {
			delete(p.states, id)
		}
	}
	p.mu.Unlock()

	// --- discovery, budget-gated -------------------------------------
	dueForDiscovery := make([]store.Connection, 0, len(connections))
	for _, c := range connections {
		state := p.stateFor(c.ID)
		if now.Sub(state.lastDiscoveryAt) >= p.PollCycleInterval {
			dueForDiscovery = append(dueForDiscovery, c)
		}
	}
	discoveryReserve := int64(len(dueForDiscovery)) * quota.CostLiveBroadcastsList
	if p.Budget.Exhausted() {
		// Graceful degradation: quota is exhausted for the day. Skip
		// discovery entirely and keep serving only the fair share of
		// whatever budget already-known-live channels can still draw
		// (which will itself be 0 once Remaining() hits 0) rather than
		// spending anything further trying to find newly-live channels.
		dueForDiscovery = nil
	} else if p.Budget.Remaining() < discoveryReserve {
		// Not enough left to safely re-check every due channel this
		// cycle: degrade to rechecking none rather than partially
		// checking some and leaving the rest starved of a liveness
		// answer for an arbitrary reason (call order).
		dueForDiscovery = nil
	}

	for _, c := range dueForDiscovery {
		if err := p.discoverOne(ctx, c, now); err != nil {
			// A single channel's discovery failure (token/network/API
			// error) must not abort the whole cycle for every other
			// channel.
			continue
		}
	}

	// --- compute this cycle's live set and fair share ------------------
	live := p.liveConnections(connections)
	share := quota.FairShare(p.Budget.Remaining(), len(live))

	for _, c := range live {
		state := p.stateFor(c.ID)
		if state.epochSpent >= share {
			continue // this channel already used its share of the current epoch
		}
		if now.Before(state.nextPollAt) {
			continue // server-directed pacing: not yet time to poll this channel again
		}
		if p.Budget.Exhausted() || p.Budget.Remaining() <= 0 {
			continue
		}
		if err := p.pollOne(ctx, c, state, now); err != nil {
			continue
		}
	}

	return nil
}

func (p *Poller) stateFor(connectionID string) *channelState {
	p.mu.Lock()
	defer p.mu.Unlock()
	state, ok := p.states[connectionID]
	if !ok {
		state = &channelState{}
		p.states[connectionID] = state
	}
	return state
}

func (p *Poller) liveConnections(connections []store.Connection) []store.Connection {
	p.mu.Lock()
	defer p.mu.Unlock()
	live := make([]store.Connection, 0, len(connections))
	for _, c := range connections {
		if state, ok := p.states[c.ID]; ok && state.liveChatID != "" {
			live = append(live, c)
		}
	}
	return live
}

// accessTokenFor decrypts the connection's stored access token, refreshing
// it first if it is expired or missing. A refreshed token is cached
// in-memory for the connection's TTL so that discovery and chat polling
// within the same cycle (or several close-together cycles) share one
// refresh call instead of each independently hitting the token endpoint.
func (p *Poller) accessTokenFor(ctx context.Context, c store.Connection) (string, error) {
	now := p.Now()

	p.mu.Lock()
	if cached, ok := p.tokenCache[c.ID]; ok && now.Before(cached.expiresAt) {
		p.mu.Unlock()
		return cached.value, nil
	}
	p.mu.Unlock()

	needsRefresh := !c.AccessTokenCiphertext.Valid ||
		!c.TokenExpiresAt.Valid ||
		now.After(c.TokenExpiresAt.Time.Add(-1*time.Minute))

	if !needsRefresh {
		token, err := p.Protector.Decrypt(c.AccessTokenCiphertext.String)
		if err != nil {
			return "", err
		}
		p.cacheToken(c.ID, token, c.TokenExpiresAt.Time.Add(-1*time.Minute))
		return token, nil
	}

	if !c.RefreshTokenCiphertext.Valid {
		return "", errors.New("youtube connection has no refresh token to renew an expired access token")
	}
	refreshToken, err := p.Protector.Decrypt(c.RefreshTokenCiphertext.String)
	if err != nil {
		return "", fmt.Errorf("decrypt refresh token: %w", err)
	}
	refreshed, err := p.Client.RefreshAccessToken(ctx, p.ClientID, p.ClientSecret, refreshToken)
	if err != nil {
		return "", fmt.Errorf("refresh access token: %w", err)
	}
	ciphertext, err := p.Protector.Encrypt(refreshed.AccessToken)
	if err != nil {
		return "", fmt.Errorf("encrypt refreshed access token: %w", err)
	}
	fingerprint := p.Protector.Fingerprint(refreshed.AccessToken)
	expiresAt := now.Add(time.Duration(refreshed.ExpiresIn) * time.Second)
	if err := p.Connections.UpdateAccessToken(ctx, c.ID, ciphertext, fingerprint, expiresAt); err != nil {
		return "", fmt.Errorf("persist refreshed access token: %w", err)
	}
	p.cacheToken(c.ID, refreshed.AccessToken, expiresAt.Add(-1*time.Minute))
	return refreshed.AccessToken, nil
}

func (p *Poller) discoverOne(ctx context.Context, c store.Connection, now time.Time) error {
	accessToken, err := p.accessTokenFor(ctx, c)
	if err != nil {
		return err
	}

	broadcast, err := p.Client.ActiveBroadcastForChannel(ctx, accessToken)
	p.Budget.Spend(quota.CostLiveBroadcastsList)
	state := p.stateFor(c.ID)

	p.mu.Lock()
	state.lastDiscoveryAt = now
	p.mu.Unlock()

	if err != nil {
		if errors.Is(err, youtube.ErrQuotaExceeded) {
			p.Budget.MarkExhausted()
		}
		return err
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if broadcast == nil {
		// Channel is not live: clear any prior chat cursor so a later
		// stream by the same channel starts its own fresh chat, never
		// resuming a stale page token from an earlier, unrelated stream.
		state.liveChatID = ""
		state.pageToken = ""
		state.epochSpent = 0
		return nil
	}
	if state.liveChatID != broadcast.ActiveLiveChatID {
		// Newly live, or a different broadcast than before: reset cursor
		// and the fairness epoch.
		state.liveChatID = broadcast.ActiveLiveChatID
		state.pageToken = ""
		state.epochSpent = 0
	}
	return nil
}

func (p *Poller) pollOne(ctx context.Context, c store.Connection, state *channelState, now time.Time) error {
	accessToken, err := p.accessTokenFor(ctx, c)
	if err != nil {
		return err
	}

	p.mu.Lock()
	liveChatID := state.liveChatID
	pageToken := state.pageToken
	p.mu.Unlock()

	page, err := p.Client.PollLiveChat(ctx, accessToken, liveChatID, pageToken)
	p.Budget.Spend(quota.CostLiveChatMessagesList)

	p.mu.Lock()
	state.epochSpent += quota.CostLiveChatMessagesList
	p.mu.Unlock()

	if err != nil {
		if errors.Is(err, youtube.ErrQuotaExceeded) {
			p.Budget.MarkExhausted()
		}
		return err
	}

	configVersion, err := p.ConfigSnapshotVersion(ctx, c.ChannelID)
	if err != nil {
		return err
	}

	// heldByTransientFailure becomes true when a message on this page could
	// not be durably recorded and the failure was NOT one InsertLiveEvent
	// already recorded on our behalf (duplicate, or a confirmed-permanent
	// rejection). A tip alert is a lost payment notification, so the page
	// cursor is held in place rather than advanced whenever that happens:
	// the same page is re-fetched and re-attempted next cycle. Because
	// InsertLiveEvent is idempotent (alert_events_external_source_unique,
	// 0091), re-processing the messages on this page that already
	// succeeded is a safe no-op, not a second alert.
	heldByTransientFailure := false

	for _, raw := range page.Messages {
		// Plain chat text (textMessageEvent) is never alert_events-shaped —
		// domain.NormalizeLiveChatMessage would just reject it as
		// UnsupportedLiveEventError below. This is where `!tip` actually
		// lives (L15 gap 2), so it is handled on its own path, never
		// reaching NormalizeLiveChatMessage at all.
		if text, ok := raw.TextMessage(); ok {
			if p.handleTipCommand(ctx, c, accessToken, liveChatID, raw, text) {
				heldByTransientFailure = true
			}
			continue
		}

		domainMessage := toDomainMessage(raw)
		event, err := domain.NormalizeLiveChatMessage(domainMessage)
		if err != nil {
			var unsupported *domain.UnsupportedLiveEventError
			if errors.As(err, &unsupported) {
				continue // moderation/other chat events this task's mapping does not cover
			}
			continue // malformed message (e.g. missing author) — skip, never abort the whole page
		}
		traceID := "youtube-poller:" + event.SourceID
		insertErr := p.Events.InsertLiveEvent(ctx, c.ChannelID, configVersion, traceID, event)
		switch {
		case insertErr == nil:
			// delivered
		case errors.Is(insertErr, store.ErrDuplicateEvent):
			// already recorded (and already routed) — a no-op, not a failure.
		case errors.Is(insertErr, store.ErrPermanentFailure):
			// InsertLiveEvent already retried what was retryable, decided
			// this message can never succeed, and durably recorded the
			// rejection (packages/db/tests/l15_youtube_delivery.sql /
			// youtube_event_ingest_failures). Safe to move on: recorded,
			// not dropped.
		default:
			// Every retry InsertLiveEvent was willing to attempt is
			// already exhausted (see internal/store/events.go
			// retryAttempts) and the failure was not confirmed permanent.
			// Do not advance past this message: hold the cursor so the
			// whole page — including this message — is retried next
			// cycle rather than lost.
			heldByTransientFailure = true
		}
	}

	if heldByTransientFailure {
		return fmt.Errorf("channel %s: transient failure persisting a youtube live event or tip intent; page cursor held for retry", c.ChannelID)
	}

	interval := time.Duration(page.PollingIntervalMs) * time.Millisecond
	if interval < p.MinChatPollDelay {
		interval = p.MinChatPollDelay
	}

	p.mu.Lock()
	state.pageToken = page.NextPageToken
	state.nextPollAt = now.Add(interval)
	p.mu.Unlock()

	return nil
}

// handleTipCommand implements L15 gap 2: a valid `!tip` becomes exactly one
// TipIntent, and (behind the still-default-off bot-ack flag) its short
// link is posted back to chat. Returns true when the page cursor must be
// held for retry (a transient failure, mirroring pollOne's own
// heldByTransientFailure contract for InsertLiveEvent) — false in every
// other case, including "not a command", "malformed command", "duplicate
// message id", "feature not configured", and "permanent failure" (all of
// which are final for this message and safe to advance past).
func (p *Poller) handleTipCommand(ctx context.Context, c store.Connection, accessToken, liveChatID string, raw youtube.RawMessage, text string) (heldForRetry bool) {
	parsed, err := chatcommand.ParseTipCommand(text)
	if err != nil {
		// Not a command at all, or invoked but malformed (bad amount,
		// message too long, ...) — chatcommand's own job, already done;
		// nothing here is retryable by trying again with the same text.
		return false
	}
	if parsed.AmountRupees == nil {
		// Bare `!tip` with no amount. ParseTipCommand's own doc comment is
		// explicit that inventing a default (e.g. the channel's configured
		// minimum tip) is a server-side decision outside that package's
		// scope; this lane does not fetch or apply a channel minimum
		// either (see this task's Remaining open) — a bare !tip is parsed,
		// never acted on, exactly like every other "not enough to act on"
		// case here.
		return false
	}
	if p.TipIntents == nil || p.TipIntentDedup == nil {
		// Not configured in this environment (see Config.TipIntentServiceURL/
		// TipIntentServiceSecret) — the command was still parsed correctly;
		// creation is simply not wired up here.
		return false
	}

	dedupID := p.NewTipIntentDedupID()
	reserved, err := p.TipIntentDedup.Reserve(ctx, dedupID, c.ChannelID, raw.ID)
	if err != nil {
		// Could not even determine reservation state (DB connectivity,
		// etc.) — no evidence either way, so treat like any other
		// transient failure: hold the cursor, retry the same message next
		// cycle rather than silently skip it.
		return true
	}
	if !reserved {
		// This exact chat message id already has a row (created, failed,
		// or another in-flight attempt) — a database-enforced no-op, not a
		// retry.
		return false
	}

	displayName := raw.AuthorDetails.DisplayName
	amountPaise := *parsed.AmountRupees * 100 // MinAmountRupees=1..MaxAmountRupees=100000 maps exactly onto the API's 100..10000000 paise bounds

	resp, class, createErr := p.TipIntents.Create(ctx, tipintent.Request{
		ChannelID:           c.ChannelID,
		AmountPaise:         amountPaise,
		DonorDisplayName:    displayName,
		Message:             parsed.Message,
		SourcePlatform:      "youtube",
		SourceChannelUserID: raw.AuthorDetails.ChannelID,
	})
	if createErr != nil {
		if class == tipintent.FailureTransient {
			// Release the reservation so the SAME chat message id can be
			// re-attempted once this page is re-fetched next cycle — never
			// marked 'failed' (that is terminal) for a failure that might
			// well succeed on retry.
			_ = p.TipIntentDedup.Release(ctx, dedupID)
			return true
		}
		// Permanent (see tipintent.FailurePermanent's own doc comment for
		// why 401 is classified here, not as transient): recorded via
		// mark_youtube_tip_intent_failed and never retried for this exact
		// message id, but the page cursor advances — a bad secret or a
		// malformed request must not wedge every future message behind it.
		_ = p.TipIntentDedup.MarkFailed(ctx, dedupID, createErr.Error())
		return false
	}

	if err := p.TipIntentDedup.MarkCreated(ctx, dedupID); err != nil {
		// The TipIntent now exists upstream (apps/api already durably
		// created it) but this lane could not record that locally. Holding
		// the cursor here would retry the whole !tip and risk a SECOND
		// upstream TipIntent for the same message — worse than the
		// alternative. Move on; the local ledger is now out of sync with
		// upstream for this one message, which is a narrower, safer gap
		// than a duplicate financial event (see this task's Remaining
		// open).
		return false
	}

	if p.TipBotAckEnabled && p.ChatPoster != nil && resp != nil {
		adapter := chatPosterAdapter{poster: p.ChatPoster, accessToken: accessToken}
		// Best-effort: the TipIntent is already durably created either way,
		// so a failed chat reply is never a reason to retry or recreate it.
		_ = chatcommand.PostTipAcknowledgement(ctx, adapter, true, liveChatID, resp.ShortLink, displayName)
	}
	return false
}
