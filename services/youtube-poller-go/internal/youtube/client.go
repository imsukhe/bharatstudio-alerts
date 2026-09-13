// Package youtube is a minimal, dependency-free client for the two YouTube
// Data API v3 surfaces this poller needs: discovering whether a channel is
// currently live (liveBroadcasts.list) and polling that broadcast's chat
// (liveChatMessages.list) — plus the OAuth2 token-refresh endpoint. It
// intentionally does not import google.golang.org/api: the other services
// in this repo use plain net/http against provider REST APIs
// (payment-webhook-go/internal/provider), and this follows the same house
// style rather than pulling in a generated client neither this repo nor
// this task needs.
package youtube

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultAPIBaseURL  = "https://www.googleapis.com/youtube/v3"
	DefaultTokenURL    = "https://oauth2.googleapis.com/token"
	defaultHTTPTimeout = 10 * time.Second
)

// ErrQuotaExceeded is returned when the API responds with the
// quotaExceeded/dailyLimitExceeded reason — the poller's cue to back off
// for the rest of the day rather than retry (see internal/quota).
var ErrQuotaExceeded = errors.New("youtube data api: quota exceeded")

// ErrTokenExpired signals an access token the caller should refresh and
// retry once, not a quota condition.
var ErrTokenExpired = errors.New("youtube data api: access token expired")

type Client struct {
	HTTPClient *http.Client
	BaseURL    string
	TokenURL   string
}

func NewClient(httpClient *http.Client, baseURL, tokenURL string) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultHTTPTimeout}
	}
	if baseURL == "" {
		baseURL = DefaultAPIBaseURL
	}
	if tokenURL == "" {
		tokenURL = DefaultTokenURL
	}
	return &Client{HTTPClient: httpClient, BaseURL: baseURL, TokenURL: tokenURL}
}

// --- live broadcast discovery ---------------------------------------------

// LiveBroadcast is the subset of youtube#liveBroadcast this poller reads.
type LiveBroadcast struct {
	ID               string
	ActiveLiveChatID string
	LifeCycleStatus  string
}

type liveBroadcastListResponse struct {
	Items []struct {
		ID      string `json:"id"`
		Snippet struct {
			LiveChatID string `json:"liveChatId"`
		} `json:"snippet"`
		Status struct {
			LifeCycleStatus string `json:"lifeCycleStatus"`
		} `json:"status"`
	} `json:"items"`
}

// ActiveBroadcastForChannel finds the channel's currently-active broadcast
// (mine=true + broadcastStatus=active is the documented, 1-unit way to ask
// "is this authenticated channel live right now", cheaper than a
// search.list call which costs 100 units).
func (c *Client) ActiveBroadcastForChannel(ctx context.Context, accessToken string) (*LiveBroadcast, error) {
	values := url.Values{}
	values.Set("part", "snippet,status")
	values.Set("broadcastStatus", "active")
	values.Set("broadcastType", "all")
	values.Set("mine", "true")

	var parsed liveBroadcastListResponse
	if err := c.get(ctx, accessToken, "/liveBroadcasts", values, &parsed); err != nil {
		return nil, err
	}
	if len(parsed.Items) == 0 {
		return nil, nil
	}
	item := parsed.Items[0]
	if item.Snippet.LiveChatID == "" {
		return nil, nil
	}
	return &LiveBroadcast{
		ID:               item.ID,
		ActiveLiveChatID: item.Snippet.LiveChatID,
		LifeCycleStatus:  item.Status.LifeCycleStatus,
	}, nil
}

// --- live chat polling -----------------------------------------------------

// LiveChatPage is one liveChatMessages.list response: the messages plus the
// server-directed pacing this poller must honour (see package quota and
// poller.Run — pollingIntervalMillis comes from here, never a fixed sleep).
type LiveChatPage struct {
	Messages          []RawMessage
	NextPageToken     string
	PollingIntervalMs int
}

// RawMessage is the wire shape of youtube#liveChatMessage, kept separate
// from domain.RawLiveChatMessage so this package has no dependency on the
// normalisation package — the poller does that translation at the call
// site, keeping the parity boundary in exactly one place.
type RawMessage struct {
	ID      string `json:"id"`
	Snippet struct {
		Type                       string          `json:"type"`
		SuperChatDetails           json.RawMessage `json:"superChatDetails"`
		SuperStickerDetails        json.RawMessage `json:"superStickerDetails"`
		NewSponsorDetails          json.RawMessage `json:"newSponsorDetails"`
		MemberMilestoneChatDetails json.RawMessage `json:"memberMilestoneChatDetails"`
		MembershipGiftingDetails   json.RawMessage `json:"membershipGiftingDetails"`
		// TextMessageDetails is populated only when Type == "textMessageEvent"
		// (an ordinary chat message, as opposed to a Super Chat/Sticker/
		// membership event) — this is where a viewer's `!tip` command lives.
		// domain.NormalizeLiveChatMessage does not handle this type (it is
		// not an alert_events-shaped event); the poller's own chatcommand
		// wiring reads MessageText directly off this field instead.
		TextMessageDetails json.RawMessage `json:"textMessageDetails"`
	} `json:"snippet"`
	AuthorDetails struct {
		ChannelID   string `json:"channelId"`
		DisplayName string `json:"displayName"`
	} `json:"authorDetails"`
}

type liveChatMessagesResponse struct {
	Items                 []RawMessage `json:"items"`
	NextPageToken         string       `json:"nextPageToken"`
	PollingIntervalMillis int          `json:"pollingIntervalMillis"`
}

// PollLiveChat fetches one page of chat. pageToken is empty on the first
// call for a given liveChatId; pass back NextPageToken thereafter — never
// re-request the same page, which is how a poller would double-count
// messages before idempotency even gets a chance to reject them.
func (c *Client) PollLiveChat(ctx context.Context, accessToken, liveChatID, pageToken string) (*LiveChatPage, error) {
	values := url.Values{}
	values.Set("part", "snippet,authorDetails")
	values.Set("liveChatId", liveChatID)
	values.Set("maxResults", "200")
	if pageToken != "" {
		values.Set("pageToken", pageToken)
	}

	var parsed liveChatMessagesResponse
	if err := c.get(ctx, accessToken, "/liveChat/messages", values, &parsed); err != nil {
		return nil, err
	}
	return &LiveChatPage{
		Messages:          parsed.Items,
		NextPageToken:     parsed.NextPageToken,
		PollingIntervalMs: parsed.PollingIntervalMillis,
	}, nil
}

// --- live chat streaming (liveChatMessages.streamList) ---------------------
//
// Google documents streamList, on the liveChatMessages.list page itself, as
// the preferred alternative to polling: it "pushes new messages to the
// client as they become available, which reduces the need for constant
// polling and helps to avoid exceeding your quota." The streamList method
// page describes a server-streaming connection with low latency, and warns
// that "[w]hen you first connect, the API sends a series of messages
// containing recent chat history" before continuing to push new ones on the
// same open connection.
//
// That history-on-connect behaviour means every (re)connect can replay
// messages already processed. This client draws no conclusion about
// duplicate-safety on its own — see poller.streamOne, which routes every
// streamed message through the exact same InsertLiveEvent idempotency path
// (alert_events_external_source_unique, 0091) as the polling path, making
// replay a no-op by construction rather than by hoping the stream never
// repeats itself.

// ErrStreamEnded signals a streamList connection ending — cleanly (server
// closed it, e.g. broadcast ended) or otherwise (network drop, idle
// timeout). This client cannot tell those apart from the wire alone; the
// poller resolves the ambiguity by re-running discovery (the same
// ActiveBroadcastForChannel call already used to find the channel live in
// the first place) before deciding to reconnect.
var ErrStreamEnded = errors.New("youtube data api: live chat stream ended")

// ChatStream is a live, open liveChatMessages.streamList connection.
type ChatStream interface {
	// Recv blocks until the next streamed chunk arrives, ctx is done, or
	// the stream ends. Exactly one of (page, error) is non-nil.
	Recv(ctx context.Context) (*LiveChatPage, error)
	// Close releases the underlying connection. Safe to call more than
	// once and safe to call concurrently with Recv.
	Close() error
}

type streamChunk struct {
	page *LiveChatPage
	err  error
}

type liveChatStream struct {
	body    io.ReadCloser
	chunks  chan streamChunk
	closeCh chan struct{}
	closeMu sync.Once
}

// StreamLiveChat opens a liveChatMessages.streamList connection.
//
// Wire format note (honesty over guessing): this repo has no live,
// quota-approved Google Cloud project to observe streamList's real framing
// against (governance/AGENTS.md:28 — no conclusion drawn here about
// verification/approval status, this is just why the byte-level format is
// unverified). This client assumes Google's common REST server-streaming
// convention used elsewhere in its APIs: a chunked HTTP response body
// carrying back-to-back JSON values, each shaped like one
// liveChatMessages.list response page, decoded with repeated
// json.Decoder.Decode calls. If the real wire format differs, the very
// first Decode fails immediately and the poller's fallback-to-list path
// (poller.streamOne / Config.StreamFailureThreshold) engages within a few
// failed reconnects rather than silently losing chat.
func (c *Client) StreamLiveChat(ctx context.Context, accessToken, liveChatID string) (ChatStream, error) {
	values := url.Values{}
	values.Set("part", "snippet,authorDetails")
	values.Set("liveChatId", liveChatID)

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/liveChat/messages:streamList?"+values.Encode(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Accept", "application/json")

	response, err := c.HTTPClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("youtube data api stream request: %w", err)
	}
	if response.StatusCode == http.StatusUnauthorized {
		response.Body.Close()
		return nil, ErrTokenExpired
	}
	if response.StatusCode == http.StatusForbidden {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4<<20))
		response.Body.Close()
		var envelope apiErrorEnvelope
		_ = json.Unmarshal(body, &envelope)
		for _, e := range envelope.Error.Errors {
			if e.Reason == "quotaExceeded" || e.Reason == "dailyLimitExceeded" || e.Reason == "userRateLimitExceeded" {
				return nil, ErrQuotaExceeded
			}
		}
		return nil, fmt.Errorf("youtube data api stream forbidden: %s", strings.TrimSpace(string(body)))
	}
	if response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4<<20))
		response.Body.Close()
		return nil, fmt.Errorf("youtube data api stream status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}

	stream := &liveChatStream{
		body:    response.Body,
		chunks:  make(chan streamChunk, 8),
		closeCh: make(chan struct{}),
	}
	go stream.pump()
	return stream, nil
}

// pump continuously drains the connection into a buffered channel so a
// slow or momentarily-idle consumer (the poller only calls Recv during its
// bounded per-cycle read window) never stalls the underlying TCP socket.
func (s *liveChatStream) pump() {
	defer close(s.chunks)
	defer s.body.Close()
	decoder := json.NewDecoder(s.body)
	for {
		var parsed liveChatMessagesResponse
		if err := decoder.Decode(&parsed); err != nil {
			select {
			case s.chunks <- streamChunk{err: fmt.Errorf("%w: %v", ErrStreamEnded, err)}:
			case <-s.closeCh:
			}
			return
		}
		page := &LiveChatPage{Messages: parsed.Items, NextPageToken: parsed.NextPageToken, PollingIntervalMs: parsed.PollingIntervalMillis}
		select {
		case s.chunks <- streamChunk{page: page}:
		case <-s.closeCh:
			return
		}
	}
}

func (s *liveChatStream) Recv(ctx context.Context) (*LiveChatPage, error) {
	select {
	case chunk, ok := <-s.chunks:
		if !ok {
			return nil, ErrStreamEnded
		}
		return chunk.page, chunk.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *liveChatStream) Close() error {
	s.closeMu.Do(func() { close(s.closeCh) })
	return s.body.Close()
}

// TextMessage returns the plain chat text and true when this message is a
// textMessageEvent (an ordinary chat message, not Super Chat/Sticker/
// membership) with a non-empty messageText. Every other case (wrong type,
// unparseable/absent textMessageDetails, empty text) returns ("", false) —
// this package never guesses at a malformed payload.
func (m RawMessage) TextMessage() (string, bool) {
	if m.Snippet.Type != "textMessageEvent" || len(m.Snippet.TextMessageDetails) == 0 {
		return "", false
	}
	var details struct {
		MessageText string `json:"messageText"`
	}
	if err := json.Unmarshal(m.Snippet.TextMessageDetails, &details); err != nil || details.MessageText == "" {
		return "", false
	}
	return details.MessageText, true
}

// --- posting a chat reply (bot acknowledgement) ----------------------------

// PostChatMessage implements chatcommand.ChatPoster: liveChatMessages.insert,
// posting one plain textMessageEvent into liveChatID. This method exists so
// the capability is wired end-to-end, but it is only ever reached when the
// poller's bot-ack flag (default OFF — see internal/chatcommand/ack.go and
// this task's own constraint) is explicitly turned on; the chat-write scope
// it requires is not yet verified with Google (governance/AGENTS.md:28 — no
// conclusion is drawn here about verification status).
func (c *Client) PostChatMessage(ctx context.Context, accessToken, liveChatID, text string) error {
	body, err := json.Marshal(map[string]any{
		"snippet": map[string]any{
			"liveChatId": liveChatID,
			"type":       "textMessageEvent",
			"textMessageDetails": map[string]any{
				"messageText": text,
			},
		},
	})
	if err != nil {
		return fmt.Errorf("marshal live chat message insert body: %w", err)
	}
	values := url.Values{}
	values.Set("part", "snippet")

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/liveChat/messages?"+values.Encode(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")

	response, err := c.HTTPClient.Do(request)
	if err != nil {
		return fmt.Errorf("youtube data api post chat message: %w", err)
	}
	defer response.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("youtube data api read post chat message body: %w", err)
	}
	if response.StatusCode == http.StatusUnauthorized {
		return ErrTokenExpired
	}
	if response.StatusCode == http.StatusForbidden {
		var envelope apiErrorEnvelope
		_ = json.Unmarshal(respBody, &envelope)
		for _, e := range envelope.Error.Errors {
			if e.Reason == "quotaExceeded" || e.Reason == "dailyLimitExceeded" || e.Reason == "userRateLimitExceeded" {
				return ErrQuotaExceeded
			}
		}
		return fmt.Errorf("youtube data api post chat message forbidden: %s", strings.TrimSpace(string(respBody)))
	}
	if response.StatusCode >= 300 {
		return fmt.Errorf("youtube data api post chat message status %d: %s", response.StatusCode, strings.TrimSpace(string(respBody)))
	}
	return nil
}

// --- shared GET + error classification ------------------------------------

type apiErrorEnvelope struct {
	Error struct {
		Code   int `json:"code"`
		Errors []struct {
			Reason string `json:"reason"`
		} `json:"errors"`
		Message string `json:"message"`
	} `json:"error"`
}

func (c *Client) get(ctx context.Context, accessToken, path string, values url.Values, out any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path+"?"+values.Encode(), nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Accept", "application/json")

	response, err := c.HTTPClient.Do(request)
	if err != nil {
		return fmt.Errorf("youtube data api request: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("youtube data api read body: %w", err)
	}

	if response.StatusCode == http.StatusUnauthorized {
		return ErrTokenExpired
	}
	if response.StatusCode == http.StatusForbidden {
		var envelope apiErrorEnvelope
		_ = json.Unmarshal(body, &envelope)
		for _, e := range envelope.Error.Errors {
			if e.Reason == "quotaExceeded" || e.Reason == "dailyLimitExceeded" || e.Reason == "userRateLimitExceeded" {
				return ErrQuotaExceeded
			}
		}
		return fmt.Errorf("youtube data api forbidden: %s", strings.TrimSpace(string(body)))
	}
	if response.StatusCode >= 300 {
		return fmt.Errorf("youtube data api status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	if out != nil {
		if err := json.Unmarshal(body, out); err != nil {
			return fmt.Errorf("youtube data api decode: %w", err)
		}
	}
	return nil
}

// --- OAuth token refresh ----------------------------------------------------

// RefreshedToken mirrors the token endpoint's response for a
// grant_type=refresh_token exchange.
type RefreshedToken struct {
	AccessToken string
	ExpiresIn   int
}

// RefreshAccessToken exchanges a stored refresh token for a new access
// token. Google does not rotate the refresh token on this grant, so callers
// keep the existing stored refresh token and only replace the access token
// and its expiry.
func (c *Client) RefreshAccessToken(ctx context.Context, clientID, clientSecret, refreshToken string) (*RefreshedToken, error) {
	form := url.Values{}
	form.Set("client_id", clientID)
	form.Set("client_secret", clientSecret)
	form.Set("refresh_token", refreshToken)
	form.Set("grant_type", "refresh_token")

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	response, err := c.HTTPClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("youtube oauth refresh request: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("youtube oauth refresh read body: %w", err)
	}
	if response.StatusCode >= 300 {
		return nil, fmt.Errorf("youtube oauth refresh status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}

	var parsed struct {
		AccessToken string      `json:"access_token"`
		ExpiresIn   json.Number `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("youtube oauth refresh decode: %w", err)
	}
	if parsed.AccessToken == "" {
		return nil, errors.New("youtube oauth refresh: empty access_token in response")
	}
	expiresIn := 3600
	if parsed.ExpiresIn != "" {
		if n, err := strconv.Atoi(parsed.ExpiresIn.String()); err == nil {
			expiresIn = n
		}
	}
	return &RefreshedToken{AccessToken: parsed.AccessToken, ExpiresIn: expiresIn}, nil
}
