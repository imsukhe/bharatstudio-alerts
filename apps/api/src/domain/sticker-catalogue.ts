// L22: curated sticker catalogue (migration 0110). Read-only for creators
// except for the enable/disable toggle — there is no creator-authored or
// viewer-uploaded sticker anywhere in this module; every id a creator
// toggles or a viewer selects must already exist in
// public.sticker_catalogue_entries, imported the same way the L20
// template catalogue is (see sticker-import-validation.ts).

export type StickerTier = 'free' | 'pro' | 'creator' | 'studio';

export type StickerSummary = {
  id: string;
  externalKey: string;
  displayName: string;
  category: string;
  minTier: StickerTier;
  byteSize: number;
  enabled: boolean;
  updatedAt: string;
};

export type SetStickerEnabledResult =
  | { outcome: 'ok'; enabled: boolean }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' };

export interface StickerCatalogueStore {
  /** Every catalogue entry available at the channel's current tier, with this channel's enabled state. */
  listForChannel(userId: string, channelId: string): Promise<StickerSummary[]>;
  /** Owner/admin only. Toggling is a single insert/delete — effect is live on the next list/attach call. */
  setEnabled(userId: string, channelId: string, stickerId: string, enabled: boolean): Promise<SetStickerEnabledResult>;
}

// Viewer-facing (unauthenticated) projection — no bytes, no internal
// availability metadata beyond what a viewer needs to pick a sticker.
export type PublicStickerSummary = {
  id: string;
  displayName: string;
  category: string;
};

export interface PublicStickerCatalogueStore {
  listEnabledForChannel(channelId: string): Promise<PublicStickerSummary[]>;
}

export type AttachStickerResult =
  | { outcome: 'attached'; selectionId: string }
  | { outcome: 'unknown_order' }
  | { outcome: 'order_not_paid' }
  | { outcome: 'unknown_sticker' }
  | { outcome: 'not_available' }
  | { outcome: 'already_attached' };

export interface StickerSelectionStore {
  /**
   * Attaches a sticker a viewer selected to their own already-paid tip
   * order. The selection is re-validated here against the channel's live
   * enabled/tier-eligible set — never trusted from the client. An unknown
   * or disabled sticker id is rejected (outcome !== 'attached'), never
   * silently dropped.
   */
  attach(channelId: string, orderId: string, stickerId: string): Promise<AttachStickerResult>;
}
