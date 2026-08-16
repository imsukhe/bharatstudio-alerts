// Studio-tier Lottie/custom branding upload — v1 scope addendum item.
// Storage is bytea-in-Postgres (mirrors alert_tts_audio, 0067); see
// migration 0077 and bharatstudio-requirements' "Lottie/custom branding
// storage mechanism addendum — 2026-08-16" for the full design rationale.
// Upload slots are keyed by displayStyle (the existing bracket enum),
// never an alert-type entity this codebase doesn't have.

export type DisplayStyle = 'small_pill' | 'compact_card' | 'standard_card' | 'large_card' | 'banner' | 'celebration';

export const displayStyles: readonly DisplayStyle[] = ['small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration'];

export type LottieAssetSummary = {
  displayStyle: DisplayStyle;
  artifactId: string;
  byteSize: number;
  updatedAt: string;
};

export type StoreLottieAssetResult =
  | { outcome: 'stored'; artifactId: string }
  | { outcome: 'forbidden' }
  | { outcome: 'tier_required' }
  | { outcome: 'invalid' };

export interface BrandingStore {
  listAssets(userId: string, channelId: string): Promise<LottieAssetSummary[]>;
  storeAsset(userId: string, channelId: string, displayStyle: DisplayStyle, bytes: Buffer): Promise<StoreLottieAssetResult>;
  deleteAsset(userId: string, channelId: string, displayStyle: DisplayStyle): Promise<boolean>;
}

export type OverlayLottieAssetRef = { displayStyle: DisplayStyle; artifactId: string };
export type OverlayLottieAsset = { bytes: Buffer; mimeType: string };

export interface OverlayBrandingStore {
  listForOverlay(token: string, overlayId: string): Promise<OverlayLottieAssetRef[]>;
  getForOverlay(token: string, overlayId: string, artifactId: string): Promise<OverlayLottieAsset | null>;
}
