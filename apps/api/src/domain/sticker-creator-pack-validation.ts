// L22 gap-fill: content-safety validation for a creator-pack sticker
// upload, run before apps/api/src/db/sticker-creator-pack-store.ts ever
// calls app_private.import_creator_pack_sticker (migration 0119, which
// re-checks size/shape/tier/quota/attestation server-side anyway, same
// defense-in-depth as sticker-import-validation.ts).
//
// Routes through the shared apps/api/src/domain/asset-scan-pipeline.ts
// entry point rather than calling validateTemplateManifestEntry directly
// — the same structural walker sticker-import-validation.ts (platform
// catalogue) now calls, so both sticker paths share one pipeline. A
// creator-pack upload has no natural externalKey/minTier of its own (it
// is not identity-keyed like a catalogue import, and its tier eligibility
// comes from the uploading channel's live entitlement, not a per-asset
// field) — this file synthesizes fixed placeholder values for exactly
// those two fields so the shared validator's shape check passes; neither
// value is stored or read back anywhere (see the store).
//
// THE SAFETY POINT: there is no code path anywhere in this file, in
// migration 0119, or in routes/stickers.ts that accepts a viewer-supplied
// asset. Only an authenticated channel owner/admin can reach this
// validator's caller.

import { runAssetScan } from './asset-scan-pipeline.js';

export type CreatorPackUploadValidationResult =
  | { ok: true; assetBytes: Buffer }
  | { ok: false; reason: string };

export type CreatorPackUploadInput = {
  displayName: unknown;
  category: unknown;
  renderDocument: unknown;
};

/**
 * Validates one creator-pack upload's shape and content-safety. Shape
 * checks for displayName/category are duplicated here at the TypeScript
 * layer (matching migration 0119's own bounds: 1-120 / 1-60 characters)
 * purely to surface a precise client-facing reason before the more
 * expensive structural walk runs — the walk and the size bound are never
 * duplicated, only delegated to runAssetScan.
 */
export function validateCreatorPackUpload(input: CreatorPackUploadInput): CreatorPackUploadValidationResult {
  if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0 || input.displayName.length > 120) {
    return { ok: false, reason: 'displayName must be 1-120 characters' };
  }
  if (typeof input.category !== 'string' || input.category.trim().length === 0 || input.category.length > 60) {
    return { ok: false, reason: 'category must be 1-60 characters' };
  }

  const result = runAssetScan({
    // Placeholder values for the two fields a creator-pack upload has no
    // natural equivalent of — see file header. Never persisted.
    externalKey: 'creator-pack-upload',
    minTier: 'free',
    displayName: input.displayName,
    category: input.category,
    renderDocument: input.renderDocument,
  });
  if (!result.ok) return result;
  return { ok: true, assetBytes: result.assetBytes };
}
