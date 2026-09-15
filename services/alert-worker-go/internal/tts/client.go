package tts

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"google.golang.org/api/idtoken"
)

var ErrInvalidClient = errors.New("invalid TTS client")

// EnrichClass bounds the result of one alert's TTS enrichment call to a
// small, log-safe token -- never an event, channel or provider identifier
// (see internal/observability.StructuredLogger.Event). §19.0 RT-03: checks,
// then synthesis, then one release.
type EnrichClass string

const (
	// EnrichSuccess is any completed HTTP round trip (2xx). apps/api's own
	// route decides audio-vs-chime; that distinction is not transport-level
	// and Enrich does not need it -- either way the call definitely
	// completed, so there is nothing left to retry or classify further.
	EnrichSuccess EnrichClass = "success"
	// EnrichTimeoutAmbiguous means the provider (apps/api's internal TTS
	// route, and Sarvam behind it) may have synthesised and billed the
	// creator's premium characters while the response was lost. Never
	// retried -- retrying would risk spending those characters a second
	// time on audio nobody hears.
	EnrichTimeoutAmbiguous EnrichClass = "timeout_ambiguous"
	// EnrichTerminal is a definitive failure a retry cannot fix: quota
	// exhaustion, safety rejection, an unsupported voice/language, a
	// malformed request, or any transport error this client cannot place in
	// the retryable-unambiguous class. Never retried.
	EnrichTerminal EnrichClass = "terminal"
	// enrichRetryableUnambiguous never escapes Enrich as a final Class: a
	// connection refused, DNS failure, TLS failure, a 5xx, or a 429 with
	// Retry-After means nothing was synthesised or billed (the request
	// never reached, or was rejected fast by, the internal route), so it is
	// retried exactly once inside Enrich and replaced by whatever that
	// retry produced.
	enrichRetryableUnambiguous EnrichClass = "retryable_unambiguous"
)

// EnrichOutcome is what Enrich returns instead of a bare error, so a caller
// can log a bounded classification (Logger.Event) without ever using it to
// delay, duplicate, or change whether a delivery is released -- only
// Store.Release decides that, unconditionally of this value (§19.0 RT-03).
type EnrichOutcome struct {
	Class    EnrichClass
	Attempts int
	Err      error
}

type Enricher interface {
	Enrich(context.Context, string) EnrichOutcome
}

type Client struct {
	endpoint    string
	tokenSource oauth2.TokenSource
	httpClient  *http.Client
}

func NewClient(ctx context.Context, endpoint, audience string, httpClient *http.Client) (Client, error) {
	if strings.TrimSpace(endpoint) == "" || strings.TrimSpace(audience) == "" {
		return Client{}, ErrInvalidClient
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return Client{}, ErrInvalidClient
	}
	source, err := idtoken.NewTokenSource(ctx, audience)
	if err != nil {
		return Client{}, fmt.Errorf("create TTS OIDC token source: %w", err)
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 2500 * time.Millisecond}
	}
	return Client{endpoint: strings.TrimRight(endpoint, "/"), tokenSource: source, httpClient: httpClient}, nil
}

func NewClientWithTokenSource(endpoint string, source oauth2.TokenSource, httpClient *http.Client) (Client, error) {
	if strings.TrimSpace(endpoint) == "" || source == nil {
		return Client{}, ErrInvalidClient
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return Client{}, ErrInvalidClient
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 2500 * time.Millisecond}
	}
	return Client{endpoint: strings.TrimRight(endpoint, "/"), tokenSource: source, httpClient: httpClient}, nil
}

// Enrich makes at most two HTTP attempts: the first, and -- only when it
// classifies as retryable-unambiguous -- exactly one more. §19.0 RT-03
// requires this to stay bounded at "one synthesis attempt's worth of
// delay" with no new timeout and no cumulative retry budget; the class this
// retries is specifically the one the authority documents as failing in
// milliseconds (connection refused, DNS, TLS, a fast 5xx/429), so the
// second attempt adds no visible delay. A timeout is never retried, by
// construction: classifyTransportError never returns
// enrichRetryableUnambiguous for one.
func (c Client) Enrich(ctx context.Context, eventID string) EnrichOutcome {
	first := c.attempt(ctx, eventID)
	if first.class != enrichRetryableUnambiguous {
		return EnrichOutcome{Class: first.class, Attempts: 1, Err: first.err}
	}
	second := c.attempt(ctx, eventID)
	return EnrichOutcome{Class: second.class, Attempts: 2, Err: second.err}
}

type attemptResult struct {
	class EnrichClass
	err   error
}

func (c Client) attempt(ctx context.Context, eventID string) attemptResult {
	if c.tokenSource == nil || c.httpClient == nil || strings.TrimSpace(eventID) == "" {
		return attemptResult{class: EnrichTerminal, err: ErrInvalidClient}
	}
	token, err := c.tokenSource.Token()
	if err != nil {
		return attemptResult{class: EnrichTerminal, err: fmt.Errorf("get TTS OIDC token: %w", err)}
	}
	body, err := json.Marshal(map[string]string{"eventId": eventID})
	if err != nil {
		return attemptResult{class: EnrichTerminal, err: err}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+"/internal/v1/tts/events/"+url.PathEscape(eventID), bytes.NewReader(body))
	if err != nil {
		return attemptResult{class: EnrichTerminal, err: err}
	}
	request.Header.Set("Authorization", "Bearer "+token.AccessToken)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return attemptResult{class: classifyTransportError(err), err: err}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return attemptResult{
			class: classifyStatus(response.StatusCode, response.Header),
			err:   fmt.Errorf("TTS enrichment returned HTTP %d", response.StatusCode),
		}
	}
	return attemptResult{class: EnrichSuccess}
}

// classifyTransportError separates an ambiguous timeout (the request may
// have already reached apps/api's internal TTS route, and Sarvam behind it,
// and been billed while the response was lost -- never retried) from an
// unambiguous failure that never got a response at all: connection refused,
// DNS failure, or a TLS failure (safe to retry once, because nothing was
// synthesised or billed). An error shape this cannot place is treated as
// terminal -- the conservative choice, since retrying is only ever safe
// once we are sure nothing was billed.
func classifyTransportError(err error) EnrichClass {
	if errors.Is(err, context.DeadlineExceeded) {
		return EnrichTimeoutAmbiguous
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return EnrichTimeoutAmbiguous
	}
	if errors.Is(err, context.Canceled) {
		// The caller cancelled (e.g. the inbound Cloud Tasks request was
		// aborted); this is not our call to retry.
		return EnrichTerminal
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return enrichRetryableUnambiguous
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		// Covers connection refused and other dial/connect-level failures,
		// including a TLS handshake failure surfaced through the dial.
		return enrichRetryableUnambiguous
	}
	var certErr *tls.CertificateVerificationError
	if errors.As(err, &certErr) {
		return enrichRetryableUnambiguous
	}
	return EnrichTerminal
}

// classifyStatus: a 429 carrying Retry-After, or any 5xx, arrived as a
// complete HTTP response -- the request definitely reached the internal TTS
// route and definitely got an answer, so nothing is ambiguous about whether
// it was billed (apps/api's own release path, §19.0 RT-03.6, guarantees a
// failure response never leaves a charge behind). Any other non-2xx (401,
// 400, 403, ...) is a terminal, request-shaped failure a retry cannot fix.
func classifyStatus(statusCode int, header http.Header) EnrichClass {
	if statusCode == http.StatusTooManyRequests && strings.TrimSpace(header.Get("Retry-After")) != "" {
		return enrichRetryableUnambiguous
	}
	if statusCode >= 500 {
		return enrichRetryableUnambiguous
	}
	return EnrichTerminal
}

var _ Enricher = Client{}
