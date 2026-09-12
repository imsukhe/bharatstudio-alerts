package tipintent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestServer(t *testing.T, status int, body any, wantSecret string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if wantSecret != "" && r.Header.Get("X-Connector-Secret") != wantSecret {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"schemaVersion":"v1","errorCode":"unauthorized"}`))
			return
		}
		w.WriteHeader(status)
		if body != nil {
			_ = json.NewEncoder(w).Encode(body)
		}
	}))
}

func TestCreateSuccess(t *testing.T) {
	server := newTestServer(t, http.StatusCreated, map[string]any{
		"schemaVersion": "v1",
		"token":         "opaque-token",
		"shortLink":     "https://b.st/abc123",
		"expiresAt":     "2026-09-07T00:00:00Z",
	}, "shhh")
	defer server.Close()

	client := NewClient(nil, server.URL, "shhh")
	resp, class, err := client.Create(context.Background(), Request{
		ChannelID: "channel-1", AmountPaise: 10000, SourcePlatform: "youtube", SourceChannelUserID: "UC_viewer",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if class != FailureNone {
		t.Fatalf("FailureClass = %v, want FailureNone", class)
	}
	if resp.ShortLink != "https://b.st/abc123" || resp.Token != "opaque-token" {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

func TestCreateUnauthorizedIsPermanent(t *testing.T) {
	server := newTestServer(t, http.StatusUnauthorized, map[string]any{"errorCode": "unauthorized"}, "expected-secret")
	defer server.Close()

	client := NewClient(nil, server.URL, "wrong-secret")
	resp, class, err := client.Create(context.Background(), Request{ChannelID: "c1", AmountPaise: 100, SourcePlatform: "youtube"})
	if err == nil {
		t.Fatal("expected an error for a rejected secret")
	}
	if class != FailurePermanent {
		t.Fatalf("FailureClass = %v, want FailurePermanent (a bad secret retrying would never fix)", class)
	}
	if resp != nil {
		t.Fatalf("expected nil response on failure, got %+v", resp)
	}
}

func TestCreateServiceUnavailableIsTransient(t *testing.T) {
	server := newTestServer(t, http.StatusServiceUnavailable, map[string]any{"errorCode": "tip_intent_unavailable", "retryable": true}, "")
	defer server.Close()

	client := NewClient(nil, server.URL, "shhh")
	_, class, err := client.Create(context.Background(), Request{ChannelID: "c1", AmountPaise: 100, SourcePlatform: "youtube"})
	if err == nil {
		t.Fatal("expected an error for 503")
	}
	if class != FailureTransient {
		t.Fatalf("FailureClass = %v, want FailureTransient", class)
	}
}

func TestCreateServerErrorIsTransient(t *testing.T) {
	server := newTestServer(t, http.StatusInternalServerError, map[string]any{"errorCode": "internal"}, "")
	defer server.Close()

	client := NewClient(nil, server.URL, "shhh")
	_, class, err := client.Create(context.Background(), Request{ChannelID: "c1", AmountPaise: 100, SourcePlatform: "youtube"})
	if err == nil {
		t.Fatal("expected an error for 500")
	}
	if class != FailureTransient {
		t.Fatalf("FailureClass = %v, want FailureTransient", class)
	}
}

func TestCreateBadRequestIsPermanent(t *testing.T) {
	server := newTestServer(t, http.StatusBadRequest, map[string]any{"errorCode": "validation"}, "")
	defer server.Close()

	client := NewClient(nil, server.URL, "shhh")
	_, class, err := client.Create(context.Background(), Request{ChannelID: "c1", AmountPaise: 100, SourcePlatform: "youtube"})
	if err == nil {
		t.Fatal("expected an error for 400")
	}
	if class != FailurePermanent {
		t.Fatalf("FailureClass = %v, want FailurePermanent", class)
	}
}

func TestCreateNetworkErrorIsTransient(t *testing.T) {
	// An unroutable URL simulates a network-level failure without any HTTP
	// response at all.
	client := NewClient(nil, "http://127.0.0.1:1", "shhh")
	_, class, err := client.Create(context.Background(), Request{ChannelID: "c1", AmountPaise: 100, SourcePlatform: "youtube"})
	if err == nil {
		t.Fatal("expected a network error")
	}
	if class != FailureTransient {
		t.Fatalf("FailureClass = %v, want FailureTransient", class)
	}
}

func TestCreateSendsSecretHeaderNeverInBody(t *testing.T) {
	var capturedHeader string
	var capturedBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeader = r.Header.Get("X-Connector-Secret")
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"token": "t", "shortLink": "https://b.st/x", "expiresAt": "2026-01-01T00:00:00Z"})
	}))
	defer server.Close()

	client := NewClient(nil, server.URL, "my-secret")
	_, _, err := client.Create(context.Background(), Request{
		ChannelID: "c1", AmountPaise: 500, DonorDisplayName: "Rahul", Message: "great stream", SourcePlatform: "youtube", SourceChannelUserID: "UC_x",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if capturedHeader != "my-secret" {
		t.Fatalf("X-Connector-Secret header = %q, want my-secret", capturedHeader)
	}
	if _, present := capturedBody["secret"]; present {
		t.Fatal("secret must never appear in the request body")
	}
	if capturedBody["channelId"] != "c1" || capturedBody["donorDisplayName"] != "Rahul" || capturedBody["message"] != "great stream" {
		t.Fatalf("unexpected request body: %+v", capturedBody)
	}
}

func TestCreateUnconfiguredClientIsPermanent(t *testing.T) {
	client := NewClient(nil, "", "")
	_, class, err := client.Create(context.Background(), Request{ChannelID: "c1", AmountPaise: 100, SourcePlatform: "youtube"})
	if err == nil {
		t.Fatal("expected an error for an unconfigured client")
	}
	if class != FailurePermanent {
		t.Fatalf("FailureClass = %v, want FailurePermanent", class)
	}
}
