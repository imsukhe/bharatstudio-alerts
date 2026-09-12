// L22: content-safety and shape validation for a sticker-catalogue entry,
// used by the (future) sticker import/seed path before any row is written
// (migration 0110's import_sticker_catalogue_entry re-checks size/shape/
// tier server-side too, same defense-in-depth as 0077/0106).
//
// Deliberately reuses validateTemplateManifestEntry's shape (which itself
// wraps validateLottieDocument, apps/api/src/domain/lottie-validation.ts)
// rather than writing a third structural walker — the master plan's L20/
// L22 rule is explicit: "no second asset-scanning pipeline". A sticker
// asset is the same Lottie-shaped JSON (`v` + `layers`) document this
// codebase already knows how to validate and render safely; the walk that
// rejects embedded expressions (`expr`), non-`data:` external refs
// (`u`/`p`), and `javascript:`/`<script` content lives in exactly one
// place (lottie-validation.ts) and this file does not duplicate it.
//
// THE SAFETY POINT OF THIS TASK: every stored sticker asset passes through
// this same walk. There is no code path anywhere in this file, in
// migration 0110, or in routes/stickers.ts that accepts a viewer-supplied
// asset — a viewer only ever selects an id from an already-imported,
// already-validated catalogue entry.

import { validateTemplateManifestEntry, type TemplateManifestEntry } from './template-import-validation.js';
import { templateTiers as stickerTiers, type TemplateTier as StickerTier } from './template-catalogue.js';

export type { StickerTier };
export { stickerTiers };

export type StickerManifestEntry = TemplateManifestEntry;

export type StickerEntryValidationResult =
  | { ok: true; assetBytes: Buffer }
  | { ok: false; reason: string };

/**
 * Validates one sticker manifest entry end to end by delegating to the
 * template-manifest validator (same shape: externalKey, displayName,
 * category, minTier, renderDocument) — a sticker catalogue entry has the
 * identical safety requirements as a template catalogue entry, so this is
 * intentionally a thin, named wrapper rather than a parallel
 * implementation that could drift from it.
 */
export function validateStickerManifestEntry(entry: unknown): StickerEntryValidationResult {
  const result = validateTemplateManifestEntry(entry);
  if (!result.ok) return result;
  return { ok: true, assetBytes: result.renderBytes };
}
