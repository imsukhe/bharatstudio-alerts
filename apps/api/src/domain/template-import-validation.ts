// L20: content-safety and shape validation for a template-catalogue
// manifest entry, used by scripts/template-import/** before any row is
// written (migration 0106's import_template_catalogue_entry re-checks
// size/shape/tier server-side too, same defense-in-depth as 0077).
//
// Deliberately reuses validateLottieDocument (apps/api/src/domain/
// lottie-validation.ts) for the render document rather than writing a
// second structural walker — the master plan's L20 rule is explicit: "No
// second asset-scanning pipeline is built." The 600-design catalogue's
// render format is not yet decided (see scripts/template-import/README.md
// for what is still open there); this validator accepts the one
// schema-validated render shape the codebase already knows how to walk
// and render safely. A manifest entry whose render document cannot pass
// this — including the real catalogue's current index.html-based runtime
// packages — is rejected at import, per L20's "does not get a bespoke
// escape hatch" rule.

import { validateLottieDocument } from './lottie-validation.js';
import { templateTiers, type TemplateTier } from './template-catalogue.js';

const MAX_RENDER_BYTES = 2_000_000;
const EXTERNAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type TemplateManifestEntry = {
  externalKey: string;
  displayName: string;
  category: string;
  minTier: TemplateTier;
  renderDocument: unknown;
};

export type TemplateEntryValidationResult =
  | { ok: true; renderBytes: Buffer }
  | { ok: false; reason: string };

function isTemplateTier(value: unknown): value is TemplateTier {
  return typeof value === 'string' && (templateTiers as readonly string[]).includes(value);
}

/**
 * Validates one manifest entry end to end: shape of the entry itself,
 * then content-safety of its render document, then the serialized size
 * bound shared with the Lottie upload path (0077). Never throws — every
 * rejection reason is returned so the pipeline can name the exact
 * external_key and cause in its report.
 */
export function validateTemplateManifestEntry(entry: unknown): TemplateEntryValidationResult {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: 'entry must be a JSON object' };
  }
  const record = entry as Record<string, unknown>;

  if (typeof record.externalKey !== 'string' || !EXTERNAL_KEY_PATTERN.test(record.externalKey)) {
    return { ok: false, reason: 'externalKey must be 1-64 characters, alphanumeric plus "._-", starting with an alphanumeric' };
  }
  if (typeof record.displayName !== 'string' || record.displayName.trim().length === 0 || record.displayName.length > 120) {
    return { ok: false, reason: 'displayName must be 1-120 characters' };
  }
  if (typeof record.category !== 'string' || record.category.trim().length === 0 || record.category.length > 60) {
    return { ok: false, reason: 'category must be 1-60 characters' };
  }
  if (!isTemplateTier(record.minTier)) {
    return { ok: false, reason: `minTier must be one of: ${templateTiers.join(', ')}` };
  }

  const documentCheck = validateLottieDocument(record.renderDocument);
  if (!documentCheck.ok) {
    return { ok: false, reason: `renderDocument: ${documentCheck.reason}` };
  }

  let renderBytes: Buffer;
  try {
    renderBytes = Buffer.from(JSON.stringify(record.renderDocument), 'utf8');
  } catch {
    return { ok: false, reason: 'renderDocument could not be serialized' };
  }
  if (renderBytes.byteLength < 1 || renderBytes.byteLength > MAX_RENDER_BYTES) {
    return { ok: false, reason: `renderDocument must serialize to between 1 and ${MAX_RENDER_BYTES} bytes, got ${renderBytes.byteLength}` };
  }

  return { ok: true, renderBytes };
}
