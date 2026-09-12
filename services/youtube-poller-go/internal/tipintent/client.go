// Package tipintent calls apps/api's internal, shared-secret-protected
// TipIntent creation endpoint (POST /v1/public/internal/tip-intents — see
// apps/api/src/routes/public.ts, migration 0097) from the poller. It does
// no chat parsing and no idempotency of its own — internal/chatcommand
// parses `!tip`; internal/store's reservation functions (0101) are the
// idempotency layer; this package's only job is the one HTTP call and
// classifying how it failed.
package tipintent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const defaultHTTPTimeout = 10 * time.Second

// FailureClass tells the caller (poller.go) how to treat a failed Create
// call, reusing the same duplicate/transient/permanent shape
// internal/store/events.go already established for alert_events writes
// (see classifyPgError there) — "duplicate" never applies here (that is
// decided before Create is ever called, by the reservation in
// internal/store/tipintent.go), so only the other two appear.
type FailureClass int

const (
	// FailureNone means Create succeeded; the zero value is never returned
	// alongside a non-nil error.
	FailureNone FailureClass = iota
	// FailureTransient covers conditions a retry has a realistic chance of
	// clearing: network errors, request timeouts, and 5xx/503 responses
	// (503 is what routes/public.ts itself returns, with retryable: true,
	// when its own TipIntent store/secret is not wired up yet). The
	// caller must release its reservation and hold the poller's page
	// cursor for retry — see internal/store's
	// release_youtube_tip_intent_reservation and poller.go's
	// heldByTransientFailure.
	FailureTransient
	// FailurePermanent covers a condition retrying cannot fix: 401 (the
	// connector secret this poller was given does not match what the API
	// expects — a config problem, not a per-message one; treating this as
	// transient would wedge the page cursor on every future !tip until an
	// operator fixes the secret, which is worse than recording this one
	// message as failed and moving on), 400/404 (a malformed request or a
	// route the poller's own build no longer matches), and any other 4xx.
	FailurePermanent
)

// Request is the exact body shape routes/public.ts accepts
// (additionalProperties: false — sending any other field is rejected).
type Request struct {
	ChannelID           string
	AmountPaise         int64
	DonorDisplayName    string // "" is sent as omitted, matching a bare !tip with no viewer-supplied name available
	Message             string // "" is sent as omitted
	SourcePlatform      string // always "youtube" for this poller
	SourceChannelUserID string
}

// Response mirrors the 201 body: schemaVersion, token, shortLink,
// expiresAt. token is intentionally not surfaced by this package's
// callers beyond posting shortLink back to chat (see internal/chatcommand)
// — this poller never needs to resolve or consume a TipIntent itself.
type Response struct {
	Token     string
	ShortLink string
	ExpiresAt string
}

// Client calls the internal tip-intents endpoint. Secret comes from the
// environment only (internal/config) — never hardcoded here or anywhere
// else in this service.
type Client struct {
	httpClient *http.Client
	baseURL    string
	secret     string
}

func NewClient(httpClient *http.Client, baseURL, secret string) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultHTTPTimeout}
	}
	return &Client{httpClient: httpClient, baseURL: baseURL, secret: secret}
}

type createBody struct {
	ChannelID           string  `json:"channelId"`
	AmountPaise         int64   `json:"amountPaise"`
	DonorDisplayName    *string `json:"donorDisplayName,omitempty"`
	Message             *string `json:"message,omitempty"`
	SourcePlatform      string  `json:"sourcePlatform"`
	SourceChannelUserID *string `json:"sourceChannelUserId,omitempty"`
}

type createResponseEnvelope struct {
	Token     string `json:"token"`
	ShortLink string `json:"shortLink"`
	ExpiresAt string `json:"expiresAt"`
}

// Create calls POST /v1/public/internal/tip-intents. On any non-2xx
// response or transport error it returns a nil *Response, a non-nil error,
// and a FailureClass telling the caller whether this specific attempt is
// worth retrying. Callers must not retry FailurePermanent outcomes for the
// same chat message id (see internal/store's terminal 'failed' status).
func (c *Client) Create(ctx context.Context, req Request) (*Response, FailureClass, error) {
	if c.baseURL == "" || c.secret == "" {
		return nil, FailurePermanent, errors.New("tipintent: client is not configured (missing base URL or secret)")
	}

	body := createBody{
		ChannelID:      req.ChannelID,
		AmountPaise:    req.AmountPaise,
		SourcePlatform: req.SourcePlatform,
	}
	if req.DonorDisplayName != "" {
		body.DonorDisplayName = &req.DonorDisplayName
	}
	if req.Message != "" {
		body.Message = &req.Message
	}
	if req.SourceChannelUserID != "" {
		body.SourceChannelUserID = &req.SourceChannelUserID
	}

	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, FailurePermanent, fmt.Errorf("tipintent: marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/public/internal/tip-intents", bytes.NewReader(encoded))
	if err != nil {
		return nil, FailurePermanent, fmt.Errorf("tipintent: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("X-Connector-Secret", c.secret)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		// Network error / timeout / context deadline: no evidence this was
		// ever received, let alone rejected for cause — retry.
		return nil, FailureTransient, fmt.Errorf("tipintent: request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, FailureTransient, fmt.Errorf("tipintent: read response body: %w", err)
	}

	switch {
	case resp.StatusCode == http.StatusCreated || (resp.StatusCode >= 200 && resp.StatusCode < 300):
		var parsed createResponseEnvelope
		if err := json.Unmarshal(respBody, &parsed); err != nil {
			// A 2xx that does not decode is not "not found" or "duplicate" —
			// something has drifted from the contract this poller was built
			// against. Not worth hammering with retries; surface it.
			return nil, FailurePermanent, fmt.Errorf("tipintent: decode 2xx response: %w", err)
		}
		if parsed.Token == "" || parsed.ShortLink == "" {
			return nil, FailurePermanent, errors.New("tipintent: 2xx response missing token/shortLink")
		}
		return &Response{Token: parsed.Token, ShortLink: parsed.ShortLink, ExpiresAt: parsed.ExpiresAt}, FailureNone, nil

	case resp.StatusCode == http.StatusUnauthorized:
		// Wrong/rotated connector secret — a config problem, not a
		// per-message one. Never treated as transient: see FailurePermanent's
		// own doc comment for why that would wedge the page cursor.
		return nil, FailurePermanent, fmt.Errorf("tipintent: unauthorized (401): connector secret rejected: %s", trimmed(respBody))

	case resp.StatusCode == http.StatusServiceUnavailable:
		// routes/public.ts returns exactly this (with retryable: true) when
		// its own TipIntent dependency is not wired up.
		return nil, FailureTransient, fmt.Errorf("tipintent: service unavailable (503): %s", trimmed(respBody))

	case resp.StatusCode >= 500:
		return nil, FailureTransient, fmt.Errorf("tipintent: server error (%d): %s", resp.StatusCode, trimmed(respBody))

	case resp.StatusCode >= 400:
		// Any other 4xx (400 malformed body, 404 unknown route, 429, ...):
		// retrying an identical request would fail identically.
		return nil, FailurePermanent, fmt.Errorf("tipintent: request rejected (%d): %s", resp.StatusCode, trimmed(respBody))

	default:
		return nil, FailureTransient, fmt.Errorf("tipintent: unexpected status %d: %s", resp.StatusCode, trimmed(respBody))
	}
}

func trimmed(b []byte) string {
	const max = 500
	s := string(b)
	if len(s) > max {
		return s[:max] + "..."
	}
	return s
}
