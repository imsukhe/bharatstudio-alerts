// L22 gap-fill: creator-approved sticker packs (migration 0119). Distinct
// from sticker-catalogue.ts (the BharatStudio-approved catalogue, 0110):
// every entry here is an asset the CHANNEL's own owner/admin uploaded and
// attested to, bounded by a per-tier count quota
// (app_private.creator_pack_tier_limit) — never something a viewer
// supplies. See migration 0119's header for the tier-quota ladder and the
// Studio review-workflow status field.

export type CreatorPackStatus = 'active' | 'pending_review';

export type CreatorPackStickerSummary = {
  id: string;
  displayName: string;
  category: string;
  byteSize: number;
  enabled: boolean;
  status: CreatorPackStatus;
  creatorAttested: boolean;
  updatedAt: string;
};

export type ImportCreatorPackStickerResult =
  | { outcome: 'created'; id: string; status: CreatorPackStatus }
  | { outcome: 'forbidden' }
  | { outcome: 'tier_not_eligible' }
  | { outcome: 'attestation_required' }
  | { outcome: 'limit_reached' }
  | { outcome: 'invalid'; reason: string };

export type SetCreatorPackStickerEnabledResult =
  | { outcome: 'ok'; enabled: boolean }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' };

export interface CreatorPackStore {
  /** Every pack entry this channel owns, any status — an owner can see a Studio upload still pending review. */
  listForChannel(userId: string, channelId: string): Promise<CreatorPackStickerSummary[]>;
  /**
   * Owner/admin only. assetBytes has already passed
   * sticker-creator-pack-validation.ts's content-safety walk before this
   * is ever called — this store re-validates size/shape/tier/quota/
   * attestation server-side anyway (migration 0119), same defense-in-depth
   * as the catalogue import path.
   */
  upload(userId: string, channelId: string, displayName: string, category: string, assetBytes: Buffer, creatorAttested: boolean): Promise<ImportCreatorPackStickerResult>;
  /** Owner/admin only. Toggling is a single update — effect is live on the next list/attach call. */
  setEnabled(userId: string, channelId: string, packStickerId: string, enabled: boolean): Promise<SetCreatorPackStickerEnabledResult>;
}

// Viewer-facing (unauthenticated) projection — no bytes, same shape as
// sticker-catalogue.ts's PublicStickerSummary.
export type PublicCreatorPackStickerSummary = {
  id: string;
  displayName: string;
  category: string;
};

export interface PublicCreatorPackStore {
  listEnabledForChannel(channelId: string): Promise<PublicCreatorPackStickerSummary[]>;
}

export type AttachCreatorPackStickerResult =
  | { outcome: 'attached'; selectionId: string }
  | { outcome: 'unknown_order' }
  | { outcome: 'order_not_paid' }
  | { outcome: 'unknown_pack_sticker' }
  | { outcome: 'not_available' }
  | { outcome: 'already_attached' };

export interface CreatorPackSelectionStore {
  /**
   * Attaches a creator-pack sticker a viewer selected to their own
   * already-paid tip order. Re-validated here against the channel's live
   * enabled/reviewed/tier-quota-eligible set — never trusted from the
   * client. Independent of sticker-catalogue.ts's StickerSelectionStore:
   * the two coexist without shadowing each other (see migration 0119's
   * header).
   */
  attach(channelId: string, orderId: string, packStickerId: string): Promise<AttachCreatorPackStickerResult>;
}
