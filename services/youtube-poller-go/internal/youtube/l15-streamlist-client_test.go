package youtube

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestStreamLiveChatDecodesConcatenatedChunks exercises the assumed wire
// format (back-to-back JSON liveChatMessagesResponse values on one chunked
// response) end to end: connect, then Recv each chunk in order.
func TestStreamLiveChatDecodesConcatenatedChunks(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/liveChat/messages:streamList" {
			t.Errorf("request path = %q, want /liveChat/messages:streamList", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization header = %q, want Bearer test-token", got)
		}
		flusher, _ := w.(http.Flusher)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"items":[{"id":"msg-1"}]}`))
		if flusher != nil {
			flusher.Flush()
		}
		_, _ = w.Write([]byte(`{"items":[{"id":"msg-2"}]}`))
	}))
	defer server.Close()

	client := NewClient(nil, server.URL, "")
	stream, err := client.StreamLiveChat(context.Background(), "test-token", "chat-1")
	if err != nil {
		t.Fatalf("StreamLiveChat() error = %v", err)
	}
	defer stream.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	page1, err := stream.Recv(ctx)
	if err != nil {
		t.Fatalf("Recv() [1] error = %v", err)
	}
	if len(page1.Messages) != 1 || page1.Messages[0].ID != "msg-1" {
		t.Fatalf("page1 = %+v, want one message msg-1", page1)
	}

	page2, err := stream.Recv(ctx)
	if err != nil {
		t.Fatalf("Recv() [2] error = %v", err)
	}
	if len(page2.Messages) != 1 || page2.Messages[0].ID != "msg-2" {
		t.Fatalf("page2 = %+v, want one message msg-2", page2)
	}

	// The server closes the connection after two chunks: the next Recv
	// must report the stream ended, not hang or panic.
	if _, err := stream.Recv(ctx); !errors.Is(err, ErrStreamEnded) {
		t.Fatalf("Recv() [3] error = %v, want ErrStreamEnded", err)
	}
}

func TestStreamLiveChatTokenExpiredAtConnect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client := NewClient(nil, server.URL, "")
	_, err := client.StreamLiveChat(context.Background(), "stale-token", "chat-1")
	if !errors.Is(err, ErrTokenExpired) {
		t.Fatalf("StreamLiveChat() error = %v, want ErrTokenExpired", err)
	}
}

func TestStreamLiveChatQuotaExceededAtConnect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":403,"errors":[{"reason":"quotaExceeded"}]}}`))
	}))
	defer server.Close()

	client := NewClient(nil, server.URL, "")
	_, err := client.StreamLiveChat(context.Background(), "test-token", "chat-1")
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("StreamLiveChat() error = %v, want ErrQuotaExceeded", err)
	}
}

// TestStreamLiveChatMalformedChunkEndsStreamFast documents the honesty
// requirement in StreamLiveChat's own doc comment: if the real wire format
// ever differs from this client's assumption, decoding fails on the very
// first chunk rather than hanging or silently dropping data, so the
// poller's fallback path engages quickly.
func TestStreamLiveChatMalformedChunkEndsStreamFast(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`not json at all`))
	}))
	defer server.Close()

	client := NewClient(nil, server.URL, "")
	stream, err := client.StreamLiveChat(context.Background(), "test-token", "chat-1")
	if err != nil {
		t.Fatalf("StreamLiveChat() error = %v", err)
	}
	defer stream.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := stream.Recv(ctx); !errors.Is(err, ErrStreamEnded) {
		t.Fatalf("Recv() error = %v, want ErrStreamEnded (decode failure)", err)
	}
}

// TestStreamLiveChatRecvRespectsContext confirms Recv returns promptly on
// ctx cancellation rather than blocking on an idle connection forever —
// this is what lets poller.streamOne bound its per-cycle drain window.
func TestStreamLiveChatRecvRespectsContext(t *testing.T) {
	block := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush() // send headers now; StreamLiveChat's connect must not wait on body data
		}
		<-block // hold the connection open with no data, like an idle live chat
	}))
	defer server.Close()
	defer close(block)

	client := NewClient(nil, server.URL, "")
	stream, err := client.StreamLiveChat(context.Background(), "test-token", "chat-1")
	if err != nil {
		t.Fatalf("StreamLiveChat() error = %v", err)
	}
	defer stream.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err = stream.Recv(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Recv() error = %v, want context.DeadlineExceeded", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("Recv() took %v to respect a 20ms context deadline", elapsed)
	}
}
