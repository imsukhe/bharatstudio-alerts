// Package domain normalises YouTube Live Chat resources (Super Chat / Super
// Sticker / membership) into the canonical LiveEvent shape that feeds
// alert_events(source_type='youtube', source_id, source_event_type,
// source_user_id, payload) — see migration 0086.
//
// This is a deliberate, field-for-field port of
// apps/api/src/domain/youtube-live-event.ts. Do not invent a second mapping:
// any change to the TypeScript normalisation must be mirrored here, and
// TestNormalizeParity in live_event_test.go pins the two to the same
// fixtures so drift fails a test instead of shipping silently.
//
// An amount here is the platform's own reported figure, in that platform's
// currency's minor unit (e.g. USD cents) — never BharatStudio-INR paise, and
// never a payment-provider-confirmed capture. Financial truth always comes
// from the payment provider; a LiveEvent is display/queue input only.
package domain

import (
	"fmt"
	"math"
	"strconv"
)

type LiveEventType string

const (
	EventSuperChat          LiveEventType = "youtube.super_chat"
	EventSuperSticker       LiveEventType = "youtube.super_sticker"
	EventMembershipNew      LiveEventType = "youtube.membership_new"
	EventMembershipMilepost LiveEventType = "youtube.membership_milestone"
	EventMembershipGift     LiveEventType = "youtube.membership_gift"
)

// LiveEventPayload mirrors LiveEvent['payload'] in youtube-live-event.ts.
// membershipMonths is shared by memberMonth (milestone) and
// giftMembershipsCount (gift), exactly as the TypeScript union does.
type LiveEventPayload struct {
	DisplayName      *string `json:"displayName"`
	Message          *string `json:"message"`
	AmountMinorUnits *int64  `json:"amountMinorUnits"`
	Currency         *string `json:"currency"`
	StickerID        *string `json:"stickerId,omitempty"`
	MembershipLevel  *string `json:"membershipLevelName,omitempty"`
	MembershipMonths *int64  `json:"membershipMonths,omitempty"`
}

type LiveEvent struct {
	SourceType      string           `json:"sourceType"`
	SourceID        string           `json:"sourceId"`
	SourceEventType LiveEventType    `json:"sourceEventType"`
	SourceUserID    string           `json:"sourceUserId"`
	Payload         LiveEventPayload `json:"payload"`
}

// RawAuthorDetails mirrors authorDetails on youtube#liveChatMessage.
type RawAuthorDetails struct {
	ChannelID   string
	DisplayName string
}

// RawSuperChatDetails mirrors snippet.superChatDetails.
type RawSuperChatDetails struct {
	AmountMicros string // carried as the API's own string form; see AmountMicros below for numeric input
	Currency     string
	UserComment  string
}

type RawSuperStickerDetails struct {
	AmountMicros string
	Currency     string
	StickerID    string
}

type RawNewSponsorDetails struct {
	MemberLevelName string
}

type RawMemberMilestoneChatDetails struct {
	MemberLevelName string
	MemberMonth     int64
	UserComment     string
}

type RawMembershipGiftingDetails struct {
	MemberLevelName      string
	GiftMembershipsCount int64
}

// RawSnippet mirrors the subset of youtube#liveChatMessage.snippet this
// mapping consumes. Only one of the *Details pointers is populated,
// matching which Type is set.
type RawSnippet struct {
	Type                       string
	SuperChatDetails           *RawSuperChatDetails
	SuperStickerDetails        *RawSuperStickerDetails
	NewSponsorDetails          *RawNewSponsorDetails
	MemberMilestoneChatDetails *RawMemberMilestoneChatDetails
	MembershipGiftingDetails   *RawMembershipGiftingDetails
}

// RawLiveChatMessage mirrors RawYoutubeLiveChatMessage in
// youtube-live-event.ts.
type RawLiveChatMessage struct {
	ID            string
	AuthorDetails *RawAuthorDetails
	Snippet       RawSnippet
}

// UnsupportedLiveEventError mirrors UnsupportedYoutubeLiveEventError.
type UnsupportedLiveEventError struct {
	RawType string
}

func (e *UnsupportedLiveEventError) Error() string {
	return fmt.Sprintf("Unsupported YouTube live chat event type: %s", e.RawType)
}

// microsToMinorUnits mirrors microsToMinorUnits() exactly: 1 unit =
// 1_000_000 micros; 1 minor unit (e.g. a cent) = unit / 100, so micros /
// 10_000, rounded half-away-from-zero the same way JS Math.round rounds
// (ties round toward +Infinity).
func microsToMinorUnits(amountMicros string) *int64 {
	if amountMicros == "" {
		return nil
	}
	micros, err := strconv.ParseFloat(amountMicros, 64)
	if err != nil || math.IsNaN(micros) || math.IsInf(micros, 0) {
		return nil
	}
	result := int64(math.Floor(micros/10_000 + 0.5))
	return &result
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// strPtrRequired returns a pointer even for "", used where TypeScript keeps
// an empty-but-present string (never applicable here — kept for clarity of
// intent at call sites that need "unset" vs "empty").
func int64Ptr(v int64) *int64 { return &v }

// NormalizeLiveChatMessage is the Go port of normalizeYoutubeLiveChatMessage.
func NormalizeLiveChatMessage(message RawLiveChatMessage) (LiveEvent, error) {
	var authorChannelID string
	var displayName *string
	if message.AuthorDetails != nil {
		authorChannelID = message.AuthorDetails.ChannelID
		displayName = strPtr(message.AuthorDetails.DisplayName)
	}
	if authorChannelID == "" {
		return LiveEvent{}, fmt.Errorf("YouTube live chat message has no author channel id")
	}

	switch message.Snippet.Type {
	case "superChatEvent":
		details := message.Snippet.SuperChatDetails
		if details == nil {
			details = &RawSuperChatDetails{}
		}
		return LiveEvent{
			SourceType:      "youtube",
			SourceID:        message.ID,
			SourceEventType: EventSuperChat,
			SourceUserID:    authorChannelID,
			Payload: LiveEventPayload{
				DisplayName:      displayName,
				Message:          strPtr(details.UserComment),
				AmountMinorUnits: microsToMinorUnits(details.AmountMicros),
				Currency:         strPtr(details.Currency),
			},
		}, nil

	case "superStickerEvent":
		details := message.Snippet.SuperStickerDetails
		if details == nil {
			details = &RawSuperStickerDetails{}
		}
		return LiveEvent{
			SourceType:      "youtube",
			SourceID:        message.ID,
			SourceEventType: EventSuperSticker,
			SourceUserID:    authorChannelID,
			Payload: LiveEventPayload{
				DisplayName:      displayName,
				Message:          nil,
				AmountMinorUnits: microsToMinorUnits(details.AmountMicros),
				Currency:         strPtr(details.Currency),
				StickerID:        strPtr(details.StickerID),
			},
		}, nil

	case "newSponsorEvent":
		details := message.Snippet.NewSponsorDetails
		if details == nil {
			details = &RawNewSponsorDetails{}
		}
		return LiveEvent{
			SourceType:      "youtube",
			SourceID:        message.ID,
			SourceEventType: EventMembershipNew,
			SourceUserID:    authorChannelID,
			Payload: LiveEventPayload{
				DisplayName:     displayName,
				Message:         nil,
				MembershipLevel: strPtr(details.MemberLevelName),
			},
		}, nil

	case "memberMilestoneChatEvent":
		details := message.Snippet.MemberMilestoneChatDetails
		if details == nil {
			details = &RawMemberMilestoneChatDetails{}
		}
		return LiveEvent{
			SourceType:      "youtube",
			SourceID:        message.ID,
			SourceEventType: EventMembershipMilepost,
			SourceUserID:    authorChannelID,
			Payload: LiveEventPayload{
				DisplayName:      displayName,
				Message:          strPtr(details.UserComment),
				MembershipLevel:  strPtr(details.MemberLevelName),
				MembershipMonths: int64Ptr(details.MemberMonth),
			},
		}, nil

	case "membershipGiftingEvent":
		details := message.Snippet.MembershipGiftingDetails
		if details == nil {
			details = &RawMembershipGiftingDetails{}
		}
		return LiveEvent{
			SourceType:      "youtube",
			SourceID:        message.ID,
			SourceEventType: EventMembershipGift,
			SourceUserID:    authorChannelID,
			Payload: LiveEventPayload{
				DisplayName:      displayName,
				Message:          nil,
				MembershipLevel:  strPtr(details.MemberLevelName),
				MembershipMonths: int64Ptr(details.GiftMembershipsCount),
			},
		}, nil

	default:
		return LiveEvent{}, &UnsupportedLiveEventError{RawType: message.Snippet.Type}
	}
}
