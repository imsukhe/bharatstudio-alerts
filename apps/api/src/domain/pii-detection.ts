// SAF-12 (packages/db/migrations/0154_v1_saf_url_ssml_pii_guards.sql):
// PII detection -- phone, UPI ID, email, address, card-like strings --
// extending the SAF phase 1 pipeline (migration 0151), not building a
// second one.
//
// STRUCTURAL PRIVACY GUARANTEE (S12.10: "detecting must never mean
// storing"). `PiiDetectionResult` carries CLASS NAMES ONLY -- there is
// no field anywhere on this type capable of holding the matched
// substring, so a caller cannot log or persist a detected value by
// accident: the type this function returns never has one to reach for.
// This mirrors packages/db/migrations/0154's own table shape for
// safety_pii_detections (no text/value column exists there either) --
// the same guarantee enforced at both layers, application and database.
//
// SAF-01: normalisation is called, never reimplemented -- every regex
// below runs against safety-pipeline.ts's ONE `normalizeForSafetyMatching`
// output (NFKC, zero-width/RTL-override stripped, case-folded), the
// same defence against zero-width-character evasion the corpus matcher
// itself relies on.
//
// FORMAT-LEVEL DETECTION, NOT A CLASSIFIER. Every pattern below is a
// documented, public STRUCTURAL standard (a numbering plan, a VPA
// shape, an email grammar, a card-number length range, a postal-code
// format) -- never an invented business threshold. "address" is
// narrowed to Indian PIN code presence only; full free-text street-
// address extraction needs a classifier (SAF-07/08 territory,
// explicitly out of scope for this task) -- narrowed here the same way
// migration 0151 narrowed SAF-02's fuller wording, documented rather
// than silently dropped (see that migration's own header).

import { normalizeForSafetyMatching } from './safety-pipeline.js';

export type PiiClass = 'phone' | 'upi_id' | 'email' | 'address_pin_code' | 'card_like';

export type PiiDetectionResult = {
  /** Deduplicated; order is not significant. NEVER the matched text -- see this file's own header. */
  classes: PiiClass[];
};

// India TRAI numbering plan: a 10-digit mobile number starting 6-9,
// optionally prefixed with the country code (+91/91) or a trunk 0.
const PHONE_RE = /(?:\+?91[-\s]?|0)?[6-9]\d{9}\b/u;

// NPCI UPI VPA shape: handle@psp-handle, where the PSP-handle segment
// has NO dot -- this is what tells a VPA apart from an email address,
// which requires a dotted TLD (see EMAIL_RE below). Checked only when
// EMAIL_RE does not already match the same text, so a real email is
// never double-classified as a UPI id.
const UPI_ID_RE = /\b[a-z0-9.\-_]{2,256}@[a-z]{2,64}\b(?!\.[a-z])/u;

// Standard email grammar (practical subset, not the full RFC 5322 ABNF
// -- the same practical-subset choice every other email validator in
// this codebase makes).
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/u;

// ISO/IEC 7812-1 PAN length range (13-19 digits), optionally grouped
// with spaces or dashes every few digits the way a card is normally
// written. A structural length bound from the standard, not a business
// number invented for this task.
const CARD_LIKE_RE = /\b(?:\d[ -]?){12,18}\d\b/u;

// India Post PIN code: exactly 6 digits, first digit 1-9. Narrow,
// documented proxy for "address" -- see this file's own header for why
// full address parsing is out of scope here.
const PIN_CODE_RE = /\b[1-9]\d{5}\b/u;

/**
 * SAF-12's entry point. Returns which PII CLASSES were found in `text`
 * -- never the matched value. A caller deciding what to do with a
 * detection (mask, hold, redact) works from `classes` alone; there is
 * structurally nothing else here to leak into a log line or a stored
 * row (packages/db/migrations/0154's `record_pii_detection` accepts
 * only `pii_classes`, matching this return shape exactly).
 */
export function detectPii(text: string): PiiDetectionResult {
  const normalized = normalizeForSafetyMatching(text);
  const classes = new Set<PiiClass>();

  const isEmail = EMAIL_RE.test(normalized);
  if (isEmail) classes.add('email');
  if (!isEmail && UPI_ID_RE.test(normalized)) classes.add('upi_id');
  if (PHONE_RE.test(normalized)) classes.add('phone');
  if (CARD_LIKE_RE.test(normalized)) classes.add('card_like');
  if (PIN_CODE_RE.test(normalized)) classes.add('address_pin_code');

  return { classes: [...classes] };
}
