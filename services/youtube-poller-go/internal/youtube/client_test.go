package youtube

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRawMessageTextMessage(t *testing.T) {
	textEvent := func(messageText string) RawMessage {
		var raw RawMessage
		raw.Snippet.Type = "textMessageEvent"
		details, _ := json.Marshal(map[string]string{"messageText": messageText})
		raw.Snippet.TextMessageDetails = details
		return raw
	}

	if text, ok := textEvent("!tip 100 thanks").TextMessage(); !ok || text != "!tip 100 thanks" {
		t.Fatalf("TextMessage() = (%q, %v), want (!tip 100 thanks, true)", text, ok)
	}

	if _, ok := textEvent("").TextMessage(); ok {
		t.Fatal("empty messageText was unexpectedly accepted")
	}

	var superChat RawMessage
	superChat.Snippet.Type = "superChatEvent"
	if _, ok := superChat.TextMessage(); ok {
		t.Fatal("a non-textMessageEvent was unexpectedly treated as one")
	}

	var malformed RawMessage
	malformed.Snippet.Type = "textMessageEvent"
	malformed.Snippet.TextMessageDetails = json.RawMessage(`{not valid json`)
	if _, ok := malformed.TextMessage(); ok {
		t.Fatal("malformed textMessageDetails was unexpectedly accepted")
	}
}

func TestPostChatMessage(t *testing.T) {
	var capturedAuth string
	var capturedBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client := NewClient(nil, server.URL, "")
	if err := client.PostChatMessage(context.Background(), "access-token-1", "chat-1", "support link ready"); err != nil {
		t.Fatalf("PostChatMessage() error = %v", err)
	}
	if capturedAuth != "Bearer access-token-1" {
		t.Fatalf("Authorization header = %q", capturedAuth)
	}
	snippet, _ := capturedBody["snippet"].(map[string]any)
	if snippet["liveChatId"] != "chat-1" || snippet["type"] != "textMessageEvent" {
		t.Fatalf("unexpected snippet: %+v", snippet)
	}
	details, _ := snippet["textMessageDetails"].(map[string]any)
	if details["messageText"] != "support link ready" {
		t.Fatalf("unexpected textMessageDetails: %+v", details)
	}
}

func TestPostChatMessageForbiddenQuota(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"errors":[{"reason":"quotaExceeded"}]}}`))
	}))
	defer server.Close()

	client := NewClient(nil, server.URL, "")
	err := client.PostChatMessage(context.Background(), "token", "chat-1", "hi")
	if err != ErrQuotaExceeded {
		t.Fatalf("err = %v, want ErrQuotaExceeded", err)
	}
}
