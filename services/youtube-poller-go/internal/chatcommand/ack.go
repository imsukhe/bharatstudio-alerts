package chatcommand

import "context"

// ChatPoster is the minimal capability PostTipAcknowledgement needs from a
// YouTube chat client. It is implemented and injected by the poller's own
// internal/youtube package (out of this lane's ownership: this package's
// scope is a new package only) — chatcommand depends only on this
// interface, never on a concrete client, so bot-ack behaviour is testable
// with a fake and carries no live-API dependency.
type ChatPoster interface {
	PostChatMessage(ctx context.Context, liveChatID string, text string) error
}

// PostTipAcknowledgement implements L15 task 9 / 10.3 item 18: after a
// TipIntent is created, post its short link back into chat. The chat-write
// scope this requires is a high-sensitivity Google OAuth scope that is not
// yet verified (governance/AGENTS.md:28 — no conclusion is drawn here about
// verification status), so this is built behind the `enabled` flag, which
// callers must default to OFF. With enabled=false this is a pure no-op:
// the TipIntent, its short link, and the /t/<token> confirmation page all
// still work — the ONLY thing skipped is this one chat reply. Nothing else
// in the tip flow depends on it.
func PostTipAcknowledgement(ctx context.Context, poster ChatPoster, enabled bool, liveChatID, shortLink, displayName string) error {
	if !enabled || poster == nil {
		return nil
	}
	return poster.PostChatMessage(ctx, liveChatID, AcknowledgementText(displayName, shortLink))
}

// AcknowledgementText builds the exact chat reply text (master plan L15
// task 7 example: "@Rahul — ₹100 support ready ❤️ / b.st/7AK2"), collapsed
// to one line for a chat message. shortLink must already be the opaque
// public URL — this function never receives or embeds amount, message, or
// any other TipIntent field beyond the display name and the link itself.
func AcknowledgementText(displayName, shortLink string) string {
	if displayName == "" {
		return "Support link ready ❤️ " + shortLink
	}
	return "@" + displayName + " — support link ready ❤️ " + shortLink
}
