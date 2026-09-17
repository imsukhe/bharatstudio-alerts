// PRF-02 slice 7, §6 catalogue module #10: QR Smart Card
// (packages/db/migrations/0144_v1_prf02_slice7_qr_smart_card.sql).
//
// THE WHOLE FEATURE, VERBATIM FROM THE OWNER DECISION (reviews/
// 2026-09-17-remaining-eight-modules-and-youtube-v1-amendment.md Part 1
// §2): "The creator sets one destination and one label. The card shows
// or hides on a single toggle. That is the entire feature." There is no
// scene concept, no destination allow-list, no link shortening and no
// scan/view/impression/exposure counter anywhere in this file -- not
// omitted by convention, absent because the type has no field for one.
//
// TWO CREATOR-AUTHORED TEXT FIELDS, EACH BOUNDED 1-120 CHARACTERS,
// REUSING THE ALREADY-DECIDED CHALLENGE-TITLE BOUND (migration 0109 line
// 67), the same number 0135's `objective` already reuses. Neither bound
// is a fresh choice made here.
//
// THE DESTINATION IS DATA, NEVER A FETCH TARGET (§9.1.1). It is rendered
// client-side as a first-party QR code
// (apps/web/app/overlay/canvas/modules/qr-smart-card-logic.ts) -- the
// Master Canvas runtime never issues a request to it, embeds it or
// navigates to it. This domain type carries it as a plain `string`, the
// same as `label`; nothing about its shape implies fetchability.

/** The bound shared by both creator-authored text fields. Identical to
 *  public.challenges.title's own `between 1 and 120` (migration 0109
 *  line 67) because it IS that decision, reused -- not a new number
 *  chosen here. */
export const QR_SMART_CARD_TEXT_MIN_LENGTH = 1;
export const QR_SMART_CARD_TEXT_MAX_LENGTH = 120;

/** Creator/dashboard-facing projection of the current card. */
export type QrSmartCard = {
  schemaVersion: 'v1';
  destination: string;
  label: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Overlay/browser-source projection. Two fields, and deliberately no
 *  `isEnabled`: the store never returns a row at all unless the card is
 *  enabled, so the row's mere presence IS the toggle's true state. */
export type OverlayQrSmartCard = {
  schemaVersion: 'v1';
  destination: string;
  label: string;
};

export type UpsertQrSmartCardResult =
  | { outcome: 'ok'; card: QrSmartCard }
  | { outcome: 'forbidden' }
  | { outcome: 'invalid' };

export type SetQrSmartCardEnabledResult =
  | { outcome: 'ok'; card: QrSmartCard }
  // Not-found and not-authorised are the same answer, deliberately --
  // and so is "no card has ever been configured for this channel" (see
  // migration 0144's header: toggling before a card exists is a
  // not-found, never an implicit create).
  | { outcome: 'not_found' };

export function isValidQrSmartCardText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= QR_SMART_CARD_TEXT_MIN_LENGTH
    && value.length <= QR_SMART_CARD_TEXT_MAX_LENGTH;
}

// Creator/dashboard-facing: authenticated by session, scoped to a
// channel the caller belongs to. Mirrors StreamMissionStore's shape.
// There is no delete method: a card is configured and toggled, and a
// disabled card stays a durable row (§12.6) -- migration 0144 never
// deletes one.
export interface QrSmartCardStore {
  getCurrent(userId: string, channelId: string): Promise<QrSmartCard | null>;
  upsert(userId: string, channelId: string, destination: string, label: string): Promise<UpsertQrSmartCardResult>;
  setEnabled(userId: string, channelId: string, enabled: boolean): Promise<SetQrSmartCardEnabledResult>;
}

// Overlay/browser-source-facing: authenticated by the overlay session
// bearer token, exactly like StreamMissionOverlayStore/
// ModeratorStatusOverlayStore.
export interface QrSmartCardOverlayStore {
  getForOverlay(token: string, overlayId: string): Promise<OverlayQrSmartCard | null>;
}

// The route's outbound narrowing for the overlay read -- a SECOND,
// independent projection sitting in front of the store's answer, not a
// pass-through that trusts it. Mirrors projectModeratorStatus's/
// projectOverlayLobbyStatus's own shape: a field of the wrong type is
// treated as no answer at all rather than rendered, and nothing is ever
// coerced.
export function projectOverlayQrSmartCard(card: OverlayQrSmartCard | null): OverlayQrSmartCard | null {
  if (!card) return null;
  const { destination, label } = card;
  if (!isValidQrSmartCardText(destination) || !isValidQrSmartCardText(label)) return null;
  return { schemaVersion: 'v1', destination, label };
}
