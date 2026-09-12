package domain

import "testing"

// TestNormalizeParity mirrors, case for case, apps/api/test/youtube-live-event.test.ts
// so the Go mapping cannot silently drift from the TypeScript one.
func TestNormalizeParity(t *testing.T) {
	author := &RawAuthorDetails{ChannelID: "UC_synthetic_viewer", DisplayName: "Synthetic Viewer"}

	tests := []struct {
		name    string
		message RawLiveChatMessage
		check   func(t *testing.T, event LiveEvent)
	}{
		{
			name: "super chat",
			message: RawLiveChatMessage{
				ID:            "chat-superchat-1",
				AuthorDetails: author,
				Snippet: RawSnippet{
					Type: "superChatEvent",
					SuperChatDetails: &RawSuperChatDetails{
						AmountMicros: "5000000",
						Currency:     "USD",
						UserComment:  "Great stream!",
					},
				},
			},
			check: func(t *testing.T, event LiveEvent) {
				requireString(t, "sourceType", event.SourceType, "youtube")
				requireString(t, "sourceId", event.SourceID, "chat-superchat-1")
				requireString(t, "sourceEventType", string(event.SourceEventType), "youtube.super_chat")
				requireString(t, "sourceUserId", event.SourceUserID, "UC_synthetic_viewer")
				requirePtrString(t, "displayName", event.Payload.DisplayName, "Synthetic Viewer")
				requirePtrString(t, "message", event.Payload.Message, "Great stream!")
				requirePtrInt64(t, "amountMinorUnits", event.Payload.AmountMinorUnits, 500)
				requirePtrString(t, "currency", event.Payload.Currency, "USD")
			},
		},
		{
			name: "super sticker carries no chat text",
			message: RawLiveChatMessage{
				ID:            "chat-supersticker-1",
				AuthorDetails: author,
				Snippet: RawSnippet{
					Type: "superStickerEvent",
					SuperStickerDetails: &RawSuperStickerDetails{
						AmountMicros: "2000000",
						Currency:     "INR",
						StickerID:    "sticker-42",
					},
				},
			},
			check: func(t *testing.T, event LiveEvent) {
				requireString(t, "sourceEventType", string(event.SourceEventType), "youtube.super_sticker")
				if event.Payload.Message != nil {
					t.Fatalf("message = %v, want nil", *event.Payload.Message)
				}
				requirePtrInt64(t, "amountMinorUnits", event.Payload.AmountMinorUnits, 200)
				requirePtrString(t, "currency", event.Payload.Currency, "INR")
				requirePtrString(t, "stickerId", event.Payload.StickerID, "sticker-42")
			},
		},
		{
			name: "new membership carries no monetary amount",
			message: RawLiveChatMessage{
				ID:            "chat-newsponsor-1",
				AuthorDetails: author,
				Snippet: RawSnippet{
					Type:              "newSponsorEvent",
					NewSponsorDetails: &RawNewSponsorDetails{MemberLevelName: "Super Fan"},
				},
			},
			check: func(t *testing.T, event LiveEvent) {
				requireString(t, "sourceEventType", string(event.SourceEventType), "youtube.membership_new")
				if event.Payload.AmountMinorUnits != nil {
					t.Fatalf("amountMinorUnits = %v, want nil", *event.Payload.AmountMinorUnits)
				}
				if event.Payload.Currency != nil {
					t.Fatalf("currency = %v, want nil", *event.Payload.Currency)
				}
				requirePtrString(t, "membershipLevelName", event.Payload.MembershipLevel, "Super Fan")
			},
		},
		{
			name: "membership milestone carries month and comment",
			message: RawLiveChatMessage{
				ID:            "chat-milestone-1",
				AuthorDetails: author,
				Snippet: RawSnippet{
					Type: "memberMilestoneChatEvent",
					MemberMilestoneChatDetails: &RawMemberMilestoneChatDetails{
						MemberLevelName: "Super Fan",
						MemberMonth:     6,
						UserComment:     "Six months in!",
					},
				},
			},
			check: func(t *testing.T, event LiveEvent) {
				requireString(t, "sourceEventType", string(event.SourceEventType), "youtube.membership_milestone")
				requirePtrInt64(t, "membershipMonths", event.Payload.MembershipMonths, 6)
				requirePtrString(t, "message", event.Payload.Message, "Six months in!")
			},
		},
		{
			name: "gifted membership",
			message: RawLiveChatMessage{
				ID:            "chat-gift-1",
				AuthorDetails: author,
				Snippet: RawSnippet{
					Type: "membershipGiftingEvent",
					MembershipGiftingDetails: &RawMembershipGiftingDetails{
						MemberLevelName:      "Super Fan",
						GiftMembershipsCount: 5,
					},
				},
			},
			check: func(t *testing.T, event LiveEvent) {
				requireString(t, "sourceEventType", string(event.SourceEventType), "youtube.membership_gift")
				requirePtrInt64(t, "membershipMonths", event.Payload.MembershipMonths, 5)
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			event, err := NormalizeLiveChatMessage(tc.message)
			if err != nil {
				t.Fatalf("NormalizeLiveChatMessage() error = %v", err)
			}
			tc.check(t, event)
		})
	}
}

func TestNormalizeRejectsUnsupportedType(t *testing.T) {
	author := &RawAuthorDetails{ChannelID: "UC_synthetic_viewer", DisplayName: "Synthetic Viewer"}
	_, err := NormalizeLiveChatMessage(RawLiveChatMessage{
		ID:            "x",
		AuthorDetails: author,
		Snippet:       RawSnippet{Type: "textMessageEvent"},
	})
	var unsupported *UnsupportedLiveEventError
	if err == nil {
		t.Fatal("expected an UnsupportedLiveEventError, got nil")
	}
	if !isUnsupported(err, &unsupported) {
		t.Fatalf("expected *UnsupportedLiveEventError, got %T: %v", err, err)
	}
}

func TestNormalizeRejectsMissingAuthorChannelID(t *testing.T) {
	_, err := NormalizeLiveChatMessage(RawLiveChatMessage{
		ID:      "x",
		Snippet: RawSnippet{Type: "superChatEvent"},
	})
	if err == nil {
		t.Fatal("expected an error for a missing author channel id, got nil")
	}
}

func isUnsupported(err error, target **UnsupportedLiveEventError) bool {
	if e, ok := err.(*UnsupportedLiveEventError); ok {
		*target = e
		return true
	}
	return false
}

func requireString(t *testing.T, field, got, want string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s = %q, want %q", field, got, want)
	}
}

func requirePtrString(t *testing.T, field string, got *string, want string) {
	t.Helper()
	if got == nil {
		t.Fatalf("%s = nil, want %q", field, want)
	}
	if *got != want {
		t.Fatalf("%s = %q, want %q", field, *got, want)
	}
}

func requirePtrInt64(t *testing.T, field string, got *int64, want int64) {
	t.Helper()
	if got == nil {
		t.Fatalf("%s = nil, want %d", field, want)
	}
	if *got != want {
		t.Fatalf("%s = %d, want %d", field, *got, want)
	}
}
