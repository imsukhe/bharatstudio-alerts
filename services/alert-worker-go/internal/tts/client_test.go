package tts

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

type staticTokenSource struct{}

func (staticTokenSource) Token() (*oauth2.Token, error) {
	return &oauth2.Token{AccessToken: "synthetic-worker-token"}, nil
}

func TestClientEnrichesEventThroughInternalRoute(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/internal/v1/tts/events/00000000-0000-4000-8000-000000000001" {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer synthetic-worker-token" {
			t.Fatalf("missing OIDC authorization")
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client, err := NewClientWithTokenSource(server.URL, staticTokenSource{}, server.Client())
	if err != nil {
		t.Fatalf("construct client: %v", err)
	}
	outcome := client.Enrich(context.Background(), "00000000-0000-4000-8000-000000000001")
	if outcome.Class != EnrichSuccess || outcome.Attempts != 1 || outcome.Err != nil {
		t.Fatalf("outcome=%+v", outcome)
	}
}

func TestClientRejectsNonHTTPSEndpoint(t *testing.T) {
	if _, err := NewClientWithTokenSource("http://localhost:4100", staticTokenSource{}, nil); err == nil {
		t.Fatal("non-HTTPS TTS endpoint accepted")
	}
}

// RT-03.3: a timeout must never be retried -- it is ambiguous whether the
// provider already synthesised and billed. One call only.
func TestClientNeverRetriesATimeout(t *testing.T) {
	var calls int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		atomic.AddInt32(&calls, 1)
		// Bounded regardless of whether the client's cancellation reaches
		// this handler promptly, so server.Close() below can never block
		// indefinitely on an outstanding request.
		select {
		case <-request.Context().Done():
		case <-time.After(300 * time.Millisecond):
		}
	}))
	defer server.Close()

	httpClient := server.Client()
	httpClient.Timeout = 50 * time.Millisecond
	client, err := NewClientWithTokenSource(server.URL, staticTokenSource{}, httpClient)
	if err != nil {
		t.Fatalf("construct client: %v", err)
	}
	outcome := client.Enrich(context.Background(), "00000000-0000-4000-8000-000000000001")
	if outcome.Class != EnrichTimeoutAmbiguous || outcome.Attempts != 1 {
		t.Fatalf("outcome=%+v", outcome)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("server received %d calls, want exactly 1 (no retry on timeout)", got)
	}
}

// RT-03.4: an unambiguous transport-level failure (connection refused --
// nothing was synthesised or billed) is retried once, and a subsequent
// success is reported as such. classifyTransportError's placement of dial
// errors is proven directly in TestClassifyTransportErrorPlacesKnownShapes;
// this proves Enrich's retry-once behavior end to end using a real closed
// port for the first attempt and a real server for the second, without a
// timing race between them.
func TestClientRetriesUnambiguousFailureThenSucceeds(t *testing.T) {
	// A port nothing is listening on: connecting to it fails fast and
	// unambiguously (connection refused on loopback), never a timeout.
	closedPortListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a closed port: %v", err)
	}
	closedPortAddr := closedPortListener.Addr().String()
	closedPortListener.Close()

	var calls int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		atomic.AddInt32(&calls, 1)
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	// A RoundTripper that fails the first request against the closed port
	// and succeeds every later request against the real TLS test server --
	// deterministic, no goroutine/sleep race between two servers.
	base := server.Client().Transport
	attemptCount := 0
	client, err := NewClientWithTokenSource("https://"+closedPortAddr, staticTokenSource{}, &http.Client{
		Timeout: 2 * time.Second,
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			attemptCount++
			if attemptCount == 1 {
				return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
			}
			redirected := request.Clone(request.Context())
			redirected.URL.Host = server.Listener.Addr().String()
			return base.RoundTrip(redirected)
		}),
	})
	if err != nil {
		t.Fatalf("construct client: %v", err)
	}

	outcome := client.Enrich(context.Background(), "00000000-0000-4000-8000-000000000001")
	if outcome.Attempts != 2 || outcome.Class != EnrichSuccess {
		t.Fatalf("outcome=%+v, want exactly one retry ending in success", outcome)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("real server received %d requests, want exactly 1", got)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

// RT-03.5: a terminal failure (a 4xx with no Retry-After) is never
// retried and releases immediately without audio -- exactly one attempt.
func TestClientNeverRetriesATerminalFailure(t *testing.T) {
	var calls int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		atomic.AddInt32(&calls, 1)
		response.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client, err := NewClientWithTokenSource(server.URL, staticTokenSource{}, server.Client())
	if err != nil {
		t.Fatalf("construct client: %v", err)
	}
	outcome := client.Enrich(context.Background(), "00000000-0000-4000-8000-000000000001")
	if outcome.Class != EnrichTerminal || outcome.Attempts != 1 {
		t.Fatalf("outcome=%+v", outcome)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("server received %d calls, want exactly 1 (no retry on terminal failure)", got)
	}
}

// A 5xx is unambiguous (the request definitely reached the route and
// definitely got an answer) and is retried once.
func TestClientRetriesA5xxOnce(t *testing.T) {
	var calls int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if atomic.AddInt32(&calls, 1) == 1 {
			response.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client, err := NewClientWithTokenSource(server.URL, staticTokenSource{}, server.Client())
	if err != nil {
		t.Fatalf("construct client: %v", err)
	}
	outcome := client.Enrich(context.Background(), "00000000-0000-4000-8000-000000000001")
	if outcome.Class != EnrichSuccess || outcome.Attempts != 2 {
		t.Fatalf("outcome=%+v", outcome)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("server received %d calls, want exactly 2", got)
	}
}

// A 429 without Retry-After is not distinguishable from an ordinary
// terminal 4xx and must not be retried; a 429 with Retry-After is
// unambiguous and is retried once.
func TestClientRetries429OnlyWithRetryAfter(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusTooManyRequests)
	}))
	defer server.Close()
	client, err := NewClientWithTokenSource(server.URL, staticTokenSource{}, server.Client())
	if err != nil {
		t.Fatalf("construct client: %v", err)
	}
	outcome := client.Enrich(context.Background(), "00000000-0000-4000-8000-000000000001")
	if outcome.Class != EnrichTerminal || outcome.Attempts != 1 {
		t.Fatalf("no-retry-after outcome=%+v", outcome)
	}

	var calls int32
	withRetryAfter := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if atomic.AddInt32(&calls, 1) == 1 {
			response.Header().Set("Retry-After", "1")
			response.WriteHeader(http.StatusTooManyRequests)
			return
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer withRetryAfter.Close()
	client2, err := NewClientWithTokenSource(withRetryAfter.URL, staticTokenSource{}, withRetryAfter.Client())
	if err != nil {
		t.Fatalf("construct client: %v", err)
	}
	outcome2 := client2.Enrich(context.Background(), "00000000-0000-4000-8000-000000000001")
	if outcome2.Class != EnrichSuccess || outcome2.Attempts != 2 {
		t.Fatalf("retry-after outcome=%+v", outcome2)
	}
}

func TestClassifyTransportErrorPlacesKnownShapes(t *testing.T) {
	if class := classifyTransportError(context.DeadlineExceeded); class != EnrichTimeoutAmbiguous {
		t.Fatalf("context.DeadlineExceeded classified as %v", class)
	}
	if class := classifyTransportError(context.Canceled); class != EnrichTerminal {
		t.Fatalf("context.Canceled classified as %v", class)
	}
	dnsErr := &net.DNSError{Err: "no such host", Name: "tts.invalid", IsNotFound: true}
	if class := classifyTransportError(dnsErr); class != enrichRetryableUnambiguous {
		t.Fatalf("DNS error classified as %v", class)
	}
	opErr := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
	if class := classifyTransportError(opErr); class != enrichRetryableUnambiguous {
		t.Fatalf("dial error classified as %v", class)
	}
	if class := classifyTransportError(errors.New("some unrecognised error")); class != EnrichTerminal {
		t.Fatalf("unrecognised error classified as %v, want terminal (conservative default)", class)
	}
}
