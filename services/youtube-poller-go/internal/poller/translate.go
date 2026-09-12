package poller

import (
	"encoding/json"

	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/domain"
	"github.com/bharatstudio/bharatstudio-alerts/services/youtube-poller-go/internal/youtube"
)

// toDomainMessage converts the wire shape (youtube.RawMessage) into the
// normalisation package's input shape. This is the one place the two
// packages meet, keeping domain free of any YouTube HTTP/JSON concerns and
// keeping the parity boundary (matching apps/api's TypeScript mapping) in
// exactly one function on the Go side.
func toDomainMessage(raw youtube.RawMessage) domain.RawLiveChatMessage {
	message := domain.RawLiveChatMessage{
		ID: raw.ID,
		AuthorDetails: &domain.RawAuthorDetails{
			ChannelID:   raw.AuthorDetails.ChannelID,
			DisplayName: raw.AuthorDetails.DisplayName,
		},
		Snippet: domain.RawSnippet{Type: raw.Snippet.Type},
	}

	switch raw.Snippet.Type {
	case "superChatEvent":
		var details struct {
			AmountMicros json.Number `json:"amountMicros"`
			Currency     string      `json:"currency"`
			UserComment  string      `json:"userComment"`
		}
		_ = json.Unmarshal(raw.Snippet.SuperChatDetails, &details)
		message.Snippet.SuperChatDetails = &domain.RawSuperChatDetails{
			AmountMicros: details.AmountMicros.String(),
			Currency:     details.Currency,
			UserComment:  details.UserComment,
		}
	case "superStickerEvent":
		var details struct {
			AmountMicros         json.Number `json:"amountMicros"`
			Currency             string      `json:"currency"`
			SuperStickerMetadata struct {
				StickerID string `json:"stickerId"`
			} `json:"superStickerMetadata"`
		}
		_ = json.Unmarshal(raw.Snippet.SuperStickerDetails, &details)
		message.Snippet.SuperStickerDetails = &domain.RawSuperStickerDetails{
			AmountMicros: details.AmountMicros.String(),
			Currency:     details.Currency,
			StickerID:    details.SuperStickerMetadata.StickerID,
		}
	case "newSponsorEvent":
		var details struct {
			MemberLevelName string `json:"memberLevelName"`
		}
		_ = json.Unmarshal(raw.Snippet.NewSponsorDetails, &details)
		message.Snippet.NewSponsorDetails = &domain.RawNewSponsorDetails{
			MemberLevelName: details.MemberLevelName,
		}
	case "memberMilestoneChatEvent":
		var details struct {
			MemberLevelName string `json:"memberLevelName"`
			MemberMonth     int64  `json:"memberMonth"`
			UserComment     string `json:"userComment"`
		}
		_ = json.Unmarshal(raw.Snippet.MemberMilestoneChatDetails, &details)
		message.Snippet.MemberMilestoneChatDetails = &domain.RawMemberMilestoneChatDetails{
			MemberLevelName: details.MemberLevelName,
			MemberMonth:     details.MemberMonth,
			UserComment:     details.UserComment,
		}
	case "membershipGiftingEvent":
		var details struct {
			MemberLevelName      string `json:"memberLevelName"`
			GiftMembershipsCount int64  `json:"giftMembershipsCount"`
		}
		_ = json.Unmarshal(raw.Snippet.MembershipGiftingDetails, &details)
		message.Snippet.MembershipGiftingDetails = &domain.RawMembershipGiftingDetails{
			MemberLevelName:      details.MemberLevelName,
			GiftMembershipsCount: details.GiftMembershipsCount,
		}
	}
	return message
}
