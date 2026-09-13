// Shared asset-scanning entry point for L20/L22 (see
// bharatstudio-requirements/tasks/L20-alert-studio-depth.md, which records
// "asset quotas, malware scanning" as NOT built anywhere in this codebase,
// and L22-stickers-and-safe-media.md, which requires reusing L20's
// asset-scanning/storage pipeline rather than standing up a second one for
// stickers).
//
// WHAT THIS FILE IS: one named module both a template-catalogue-shaped
// upload and a sticker-catalogue/creator-pack-shaped upload can call,
// making "the shared scanning path" a real, addressable thing instead of
// each caller inlining its own validator call. It does not re-implement
// the structural walk — it delegates to the one walker that already
// exists (validateTemplateManifestEntry, which itself wraps
// validateLottieDocument in lottie-validation.ts) via
// runStructuralAssetScan below, and it defines the extension point a real
// malware/content scan would plug into (runMalwareScan) rather than
// leaving that as an undocumented gap.
//
// WHAT THIS FILE IS NOT: a malware scanner. See runMalwareScan's own
// comment for precisely why that stage is not implemented here and what
// it needs — this task's ownership boundary (apps/api/src/domain/ and
// apps/api/src/db/ files prefixed sticker- or asset-scan-, plus the
// sticker route/panel files) does not include network egress, a
// third-party AV vendor credential, or the ops/infra work a byte-scanning
// integration requires, and none of the sticker files this task owns
// justify introducing that dependency unilaterally.
//
// CALLERS TODAY: apps/api/src/domain/sticker-creator-pack-validation.ts
// (new, this task) calls runAssetScan for creator-pack uploads.
// apps/api/src/domain/sticker-import-validation.ts (owned by this lane)
// has been updated to call it too, so both sticker paths already share
// one pipeline. apps/api/src/domain/template-import-validation.ts (L20,
// out of this lane's ownership) does not call it yet — it still calls
// validateTemplateManifestEntry directly, which is exactly the function
// this module also delegates to, so no behavior differs and no second
// walker exists either way. Migrating that one call site is a one-line,
// zero-behavior-change follow-up for the L20 lane to make, not a gap in
// what this module provides.

import { validateTemplateManifestEntry } from './template-import-validation.js';

export type AssetScanResult =
  | { ok: true; assetBytes: Buffer }
  | { ok: false; reason: string };

/**
 * Stage 1 — structural content-safety walk. Delegates to the one
 * structural walker this codebase has (see file header); never
 * duplicates it. Accepts unknown, exactly like validateTemplateManifestEntry
 * itself, and requires the same manifest-entry shape (externalKey,
 * displayName, category, minTier, renderDocument) — a caller whose asset
 * has no natural externalKey/minTier of its own (a creator-pack upload)
 * synthesizes placeholder values for those two fields purely to satisfy
 * the shared validator's shape; they carry no meaning beyond that call
 * and are never persisted (see sticker-creator-pack-validation.ts).
 */
function runStructuralAssetScan(entry: unknown): AssetScanResult {
  const result = validateTemplateManifestEntry(entry);
  if (!result.ok) return result;
  return { ok: true, assetBytes: result.renderBytes };
}

/**
 * Stage 2 — malware/content scanning of the asset bytes themselves (an
 * antivirus/AV-style scan of the serialized payload, independent of its
 * JSON structure). NOT IMPLEMENTED. Precisely why it cannot be built from
 * this task's file ownership, and what it needs:
 *
 * - It requires a scanning backend (a vendor API such as ClamAV/an AV
 *   cloud API, or a self-hosted scanning service) that does not exist
 *   anywhere in this repository today — grepping for "clamav", "malware",
 *   "virus", "scan" outside this file and its callers turns up nothing.
 * - Standing one up needs: an infra/ops decision (which vendor, self-host
 *   vs. managed), network egress from the API process (currently a
 *   closed, DB-only backend per its own architecture), a secret/credential
 *   (API key or service endpoint) provisioned outside application code,
 *   and a decision on synchronous-reject-at-upload vs.
 *   async-scan-then-quarantine semantics (this pipeline's callers assume
 *   synchronous accept/reject, so async scanning would also need a
 *   status/quarantine column on every table that stores scanned bytes).
 * - None of that is a domain/db file this task owns (sticker-*, asset-
 *   scan-*, the stickers dashboard) — it is an infra/ops decision plus
 *   likely a new shared config/secrets surface, which is out of bounds
 *   for this lane's ownership boundary.
 *
 * Until that lands, this stage is a documented no-op: it always returns
 * ok so callers get the same behavior malware scanning would have if the
 * asset already passed (this codebase's Lottie/JSON assets carry no
 * executable payload once the structural walk above has rejected
 * expressions, external refs and inline script — see lottie-validation.ts
 * — so a JSON-only asset has no code path to actually execute anything
 * even without an AV pass; that containment, not this stub, is the real
 * safety property today).
 */
function runMalwareScan(_assetBytes: Buffer): AssetScanResult {
  return { ok: true, assetBytes: _assetBytes };
}

/**
 * The one shared scan entry point. Runs the structural walk first (cheap,
 * synchronous, already proven) and only then the malware-scan extension
 * point, so a structurally-unsafe asset never reaches stage 2 at all.
 */
/**
 * TRAP FOR WHOEVER MAKES STAGE 2 REAL — read this before implementing
 * runMalwareScan.
 *
 * Not every asset path goes through runAssetScan today. Sticker imports
 * (platform catalogue and creator packs) do. The L20 template import at
 * scripts/template-import/import.ts:85 does NOT — it calls
 * validateTemplateManifestEntry directly, because it needs the typed entry
 * back and runAssetScan returns only { ok, assetBytes }.
 *
 * That is harmless right now precisely because stage 2 is a no-op: both
 * paths reach the same single structural walker, so there is no divergence
 * to worry about and nothing is skipped.
 *
 * The moment runMalwareScan does real work, that stops being true, and it
 * fails in the quiet direction: template imports would silently skip malware
 * scanning while sticker imports get it, with no error and no test failure to
 * say so. A catalogue import is the higher-volume, more automated path of the
 * two, so it is the worse one to leave unscanned.
 *
 * Migrating that call site is the first step of making stage 2 real, not a
 * follow-up to it. Either widen AssetScanResult to carry the validated entry,
 * or give import.ts a scan call alongside its existing validation — but do not
 * leave it as-is and assume coverage.
 */
export function runAssetScan(entry: unknown): AssetScanResult {
  const structural = runStructuralAssetScan(entry);
  if (!structural.ok) return structural;
  return runMalwareScan(structural.assetBytes);
}
