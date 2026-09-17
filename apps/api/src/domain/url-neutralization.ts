// SAF-10 (packages/db/migrations/0154_v1_saf_url_ssml_pii_guards.sql):
// URL neutralisation with per-creator allow and deny domains, extending
// the SAF phase 1 pipeline (migration 0151) rather than building a
// second one.
//
// BASELINE REUSED, NOT INVENTED: apps/api/src/tts/provider.ts's
// `sanitizeTtsText` already replaces every URL-shaped token in TTS input
// with a placeholder, UNCONDITIONALLY (provider.ts:28 URL_TOKEN,
// provider.ts:36 the `.replace(URL_TOKEN, ' shared link ')` call) -- a
// pre-existing, decided behaviour. This module extends that same
// "neutralise by default" baseline to surfaces other than TTS (the
// migration's own header: DISPLAY had zero URL handling before this)
// and makes it creator-configurable: a domain on the ALLOW list is
// exempt (passed through untouched), a domain on the DENY list is
// always neutralised (deny wins over allow -- see this file's own
// precedence test and the migration's unique-index note for why that
// is a structural fact, not a runtime tie-break), and an unlisted
// domain gets the baseline "neutralise" behaviour, matching the
// already-decided TTS posture.
//
// This module does NOT replace or duplicate apps/api/src/tts/
// provider.ts's own URL handling -- that stays exactly as it is,
// untouched by this task's own "do not duplicate or contradict it"
// instruction for the TTS-side guard (SAF-11). This is a NEW,
// independent transform for surfaces (display, chat) that had none.
//
// SAF-01: normalisation is called, never reimplemented. Detecting a
// URL's HOST is run through safety-pipeline.ts's ONE
// `normalizeForSafetyMatching` implementation (scoped to just the host
// substring of each token, never the whole message, so the returned
// text keeps the rest of the creator's message exactly as typed --
// normalising the WHOLE message would lowercase an otherwise-untouched
// message, which is not what "neutralise the URL" means).

import { normalizeForSafetyMatching } from './safety-pipeline.js';

export type UrlDomainRuleValue = 'allow' | 'deny';

export type UrlDomainRuleForMatching = {
  /** Lowercase host, e.g. "youtube.com" -- packages/db/migrations/0154's own domain CHECK constraint already enforces this shape at rest. */
  domain: string;
  rule: UrlDomainRuleValue;
};

export type UrlNeutralizationResult = {
  /** The message with every neutralised URL token replaced by a placeholder. Everything else -- casing, spacing, the rest of the message -- is exactly as given. */
  text: string;
  /** How many URL tokens were neutralised. 0 for a message with no URLs, or where every URL found was allow-listed. */
  neutralizedCount: number;
  /** Hosts that were actually neutralised, for audit -- never the raw URL, path or query string, which can carry a tracking id or other detail beyond "there was a link to this domain". */
  neutralizedHosts: string[];
};

const URL_TOKEN = /(?:https?:\/\/|www\.)[^\s<>{}[\]]+/giu;
const NEUTRALIZED_PLACEHOLDER = ' link removed ';

function extractHost(token: string): string | null {
  const withScheme = /^https?:\/\//iu.test(token) ? token : `https://${token}`;
  try {
    return new URL(withScheme).hostname;
  } catch {
    return null;
  }
}

/**
 * SAF-10's transform. `rules` is this channel's own compiled allow/deny
 * list (app_private.get_url_domain_rules, migration 0154) -- empty is
 * fully supported: every URL found then gets the baseline "neutralise"
 * behaviour, and NEVER means "deny/neutralise nothing at all" for a URL
 * whose host happens to not be configured -- see this file's own header
 * for why "neutralise by default" is the reused, already-decided
 * baseline, not an invented one. What IS proven empty here, matching
 * 0151's corpus precedent exactly: an empty DENY set never forces
 * MORE neutralisation than the baseline already does, and an empty
 * ALLOW set never exempts anything that was not explicitly configured.
 */
export function neutralizeUrls(text: string, rules: readonly UrlDomainRuleForMatching[]): UrlNeutralizationResult {
  const byDomain = new Map<string, UrlDomainRuleValue>();
  for (const r of rules) byDomain.set(r.domain.toLowerCase(), r.rule);

  const neutralizedHosts: string[] = [];
  const replaced = text.replace(URL_TOKEN, (token) => {
    const rawHost = extractHost(token);
    const host = rawHost ? normalizeForSafetyMatching(rawHost) : null;
    const decision = host ? byDomain.get(host) : undefined;

    if (decision === 'allow') return token; // creator's own domain -- passed through untouched

    // Default (unlisted) and 'deny' are both neutralised. Deny wins over
    // allow structurally (packages/db/migrations/0154's unique index
    // makes a domain holding both impossible to store in the first
    // place), so there is nothing further to branch on here.
    if (host) neutralizedHosts.push(host);
    return NEUTRALIZED_PLACEHOLDER;
  });

  return { text: replaced, neutralizedCount: neutralizedHosts.length, neutralizedHosts };
}
