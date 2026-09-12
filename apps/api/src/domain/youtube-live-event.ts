// Normalises YouTube Live Chat resources (Super Chat / Super Sticker /
// membership) into the canonical LiveEvent shape that feeds
// alert_events(source_type='youtube', source_id, source_event_type,
// source_user_id, payload) — see migration 0086. The poller that will call
// this (services/youtube-poller-go) does not exist yet (later batch); this
// module and its tests exist so that poller has an already-proven mapping
// to call into.
//
// A Super Chat/Super Sticker/membership amount here is the platform's own
// reported figure, in that platform's currency's minor unit (e.g. USD
// cents) — never BharatStudio-INR paise, and never a payment-provider-
// confirmed capture. Financial truth always comes from the payment
// provider; a LiveEvent is display/queue input only.
export type YoutubeLiveEventType =
  | 'youtube.super_chat'
  | 'youtube.super_sticker'
  | 'youtube.membership_new'
  | 'youtube.membership_milestone'
  | 'youtube.membership_gift';

export type LiveEvent = {
  sourceType: 'youtube';
  // The platform's own message/event id — used as alert_events.source_id
  // for idempotency; a duplicate webhook/poll delivery of the same id must
  // never produce a second LiveEvent.
  sourceId: string;
  sourceEventType: YoutubeLiveEventType;
  sourceUserId: string;
  payload: {
    displayName: string | null;
    message: string | null;
    amountMinorUnits: number | null;
    currency: string | null;
    stickerId?: string;
    membershipLevelName?: string;
    membershipMonths?: number;
  };
};

type RawAuthorDetails = {
  channelId?: string;
  displayName?: string;
};

// Shape of the subset of youtube#liveChatMessage this lane's mapping
// consumes. The real resource carries far more fields; only what's needed
// to build a LiveEvent is modelled.
export type RawYoutubeLiveChatMessage = {
  id: string;
  authorDetails?: RawAuthorDetails;
  snippet: {
    type: 'superChatEvent' | 'superStickerEvent' | 'newSponsorEvent' | 'memberMilestoneChatEvent' | 'membershipGiftingEvent' | string;
    superChatDetails?: {
      amountMicros?: string | number;
      currency?: string;
      userComment?: string;
    };
    superStickerDetails?: {
      amountMicros?: string | number;
      currency?: string;
      superStickerMetadata?: { stickerId?: string; altText?: string };
    };
    newSponsorDetails?: {
      memberLevelName?: string;
      isUpgrade?: boolean;
    };
    memberMilestoneChatDetails?: {
      memberLevelName?: string;
      memberMonth?: number;
      userComment?: string;
    };
    membershipGiftingDetails?: {
      memberLevelName?: string;
      giftMembershipsCount?: number;
    };
  };
};

function microsToMinorUnits(amountMicros: string | number | undefined): number | null {
  if (amountMicros === undefined) return null;
  const micros = typeof amountMicros === 'string' ? Number(amountMicros) : amountMicros;
  if (!Number.isFinite(micros)) return null;
  // 1 unit = 1_000_000 micros; 1 minor unit (e.g. a cent) = unit / 100.
  return Math.round(micros / 10_000);
}

export class UnsupportedYoutubeLiveEventError extends Error {
  constructor(public readonly rawType: string) {
    super(`Unsupported YouTube live chat event type: ${rawType}`);
  }
}

export function normalizeYoutubeLiveChatMessage(message: RawYoutubeLiveChatMessage): LiveEvent {
  const authorChannelId = message.authorDetails?.channelId;
  if (!authorChannelId) throw new Error('YouTube live chat message has no author channel id');
  const displayName = message.authorDetails?.displayName ?? null;

  switch (message.snippet.type) {
    case 'superChatEvent': {
      const details = message.snippet.superChatDetails ?? {};
      return {
        sourceType: 'youtube',
        sourceId: message.id,
        sourceEventType: 'youtube.super_chat',
        sourceUserId: authorChannelId,
        payload: {
          displayName,
          message: details.userComment ?? null,
          amountMinorUnits: microsToMinorUnits(details.amountMicros),
          currency: details.currency ?? null,
        },
      };
    }
    case 'superStickerEvent': {
      const details = message.snippet.superStickerDetails ?? {};
      return {
        sourceType: 'youtube',
        sourceId: message.id,
        sourceEventType: 'youtube.super_sticker',
        sourceUserId: authorChannelId,
        payload: {
          displayName,
          message: null,
          amountMinorUnits: microsToMinorUnits(details.amountMicros),
          currency: details.currency ?? null,
          stickerId: details.superStickerMetadata?.stickerId,
        },
      };
    }
    case 'newSponsorEvent': {
      const details = message.snippet.newSponsorDetails ?? {};
      return {
        sourceType: 'youtube',
        sourceId: message.id,
        sourceEventType: 'youtube.membership_new',
        sourceUserId: authorChannelId,
        payload: {
          displayName,
          message: null,
          amountMinorUnits: null,
          currency: null,
          membershipLevelName: details.memberLevelName,
        },
      };
    }
    case 'memberMilestoneChatEvent': {
      const details = message.snippet.memberMilestoneChatDetails ?? {};
      return {
        sourceType: 'youtube',
        sourceId: message.id,
        sourceEventType: 'youtube.membership_milestone',
        sourceUserId: authorChannelId,
        payload: {
          displayName,
          message: details.userComment ?? null,
          amountMinorUnits: null,
          currency: null,
          membershipLevelName: details.memberLevelName,
          membershipMonths: details.memberMonth,
        },
      };
    }
    case 'membershipGiftingEvent': {
      const details = message.snippet.membershipGiftingDetails ?? {};
      return {
        sourceType: 'youtube',
        sourceId: message.id,
        sourceEventType: 'youtube.membership_gift',
        sourceUserId: authorChannelId,
        payload: {
          displayName,
          message: null,
          amountMinorUnits: null,
          currency: null,
          membershipLevelName: details.memberLevelName,
          membershipMonths: details.giftMembershipsCount,
        },
      };
    }
    default:
      throw new UnsupportedYoutubeLiveEventError(message.snippet.type);
  }
}
