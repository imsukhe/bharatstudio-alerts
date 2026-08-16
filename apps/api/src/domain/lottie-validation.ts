// Content-safety validation for an uploaded Lottie document — the storage
// layer (migration 0077's store_channel_lottie_asset) is the
// authorization/size boundary; this is the content-safety boundary. A
// Lottie JSON document is untrusted content that ends up rendered inside
// the overlay browser source, so it is walked structurally before it is
// ever stored.
//
// Legacy's own requirements spec for this feature demanded rejecting
// embedded expressions and external asset references; the implementation
// legacy actually shipped only checked JSON validity and a `v`/`layers`
// shape. This validator carries the stricter check the spec called for —
// see bharatstudio-requirements' "Lottie/custom branding storage mechanism
// addendum — 2026-08-16".

const MAX_WALK_DEPTH = 64;

export type LottieValidationResult = { ok: true } | { ok: false; reason: string };

function walk(value: unknown, depth: number): string | null {
  if (depth > MAX_WALK_DEPTH) return 'the document is nested too deeply';

  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = walk(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'expr' && typeof item === 'string' && item.trim().length > 0) {
        return 'embedded expressions are not allowed in an uploaded animation';
      }
      if ((key === 'u' || key === 'p') && typeof item === 'string' && item.trim().length > 0 && !item.startsWith('data:')) {
        return 'external asset references are not allowed — embed assets as data URIs or omit them';
      }
      const problem = walk(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }

  if (typeof value === 'string' && /javascript:|<script/i.test(value)) {
    return 'embedded script content is not allowed';
  }

  return null;
}

export function validateLottieDocument(value: unknown): LottieValidationResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'the uploaded document must be a JSON object' };
  }
  const record = value as Record<string, unknown>;
  if (record.v === undefined || (typeof record.v !== 'number' && typeof record.v !== 'string')) {
    return { ok: false, reason: 'the document is missing a valid Lottie version field ("v")' };
  }
  if (!Array.isArray(record.layers)) {
    return { ok: false, reason: 'the document is missing a "layers" array' };
  }
  const problem = walk(value, 0);
  if (problem) return { ok: false, reason: problem };
  return { ok: true };
}
