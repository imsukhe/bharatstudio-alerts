package chatcommand

import (
	"context"
	"testing"
)

type fakePoster struct {
	calls int
	last  string
}

func (f *fakePoster) PostChatMessage(_ context.Context, _ string, text string) error {
	f.calls++
	f.last = text
	return nil
}

func TestPostTipAcknowledgement_NoopWhenFlagOff(t *testing.T) {
	poster := &fakePoster{}
	err := PostTipAcknowledgement(context.Background(), poster, false, "live-chat-1", "https://b.st/7AK2", "Rahul")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if poster.calls != 0 {
		t.Fatalf("expected no chat post when flag is off, got %d calls", poster.calls)
	}
}

func TestPostTipAcknowledgement_NoopWhenNoPosterInjected(t *testing.T) {
	// enabled=true but no client wired yet must still not panic or error —
	// "fully functional with it off" also covers "not wired yet".
	if err := PostTipAcknowledgement(context.Background(), nil, true, "live-chat-1", "https://b.st/7AK2", "Rahul"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPostTipAcknowledgement_PostsWhenEnabled(t *testing.T) {
	poster := &fakePoster{}
	err := PostTipAcknowledgement(context.Background(), poster, true, "live-chat-1", "https://b.st/7AK2", "Rahul")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if poster.calls != 1 {
		t.Fatalf("expected exactly one chat post, got %d", poster.calls)
	}
	if poster.last != "@Rahul — support link ready ❤️ https://b.st/7AK2" {
		t.Fatalf("unexpected ack text: %q", poster.last)
	}
}

func TestAcknowledgementText_NoDisplayName(t *testing.T) {
	got := AcknowledgementText("", "https://b.st/7AK2")
	if got != "Support link ready ❤️ https://b.st/7AK2" {
		t.Fatalf("unexpected text: %q", got)
	}
}
