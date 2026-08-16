package tts

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

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
	if err := client.Enrich(context.Background(), "00000000-0000-4000-8000-000000000001"); err != nil {
		t.Fatalf("enrich: %v", err)
	}
}

func TestClientRejectsNonHTTPSEndpoint(t *testing.T) {
	if _, err := NewClientWithTokenSource("http://localhost:4100", staticTokenSource{}, nil); err == nil {
		t.Fatal("non-HTTPS TTS endpoint accepted")
	}
}
