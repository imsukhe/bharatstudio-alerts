// SAF phase 1 -- the moderation pipeline spine
// (packages/db/migrations/0151_v1_saf_moderation_pipeline_spine.sql).
//
// THE ONE PIPELINE (SAF-01). `runSafetyPipeline` below is the ONLY
// exported function anywhere in this codebase that normalises message
// text for safety matching or runs L1 matching against the corpus.
// apps/api/test/safety-pipeline.test.ts asserts this structurally: it
// scans every file under apps/api/src and fails if any file other than
// this one calls `.normalize(` on message-shaped text, and fails if any
// file other than apps/api/src/domain/aho-corasick.ts defines a second
// trie/failure-link construction. Tips, TTS input, chat, display names
// and every other surface FULL-PRODUCT-DEFINITION.md S12.2.1 names are
// meant to call this one function -- there is no second, surface-
// specific normalise-and-match path to drift out of sync with this one,
// structurally, not by convention.
//
// NOTHING IN THIS FILE IS WIRED INTO A LIVE PAYMENT, TTS, CHAT OR ALERT
// PATH. This is the pipeline, built and proven in isolation. Switching a
// live surface onto it is a separate task with its own record -- see
// the migration's own header for why that separation matters.
//
// SAF-02/SAF-04: `normalizeForSafetyMatching` NEVER mutates its input --
// JS strings are immutable, so there is no operation that could -- and
// always returns a NEW string, the "parallel matching form" S12.2.2
// requires. `runSafetyPipeline` always returns BOTH `original` (exactly
// the caller's input, untouched) and `normalized` as separate fields on
// its result, so a caller structurally cannot forward one without the
// other to persistence (see apps/api/src/db's future evidence-recording
// caller, and packages/db/migrations/0151's own SAF-04 section for the
// durable half of this guarantee).
//
// Scope, restated from the task record and the migration's own header:
// built here are NFKC normalisation, zero-width stripping (U+200B-D,
// U+FEFF), RTL/LTR-override stripping (U+202A-E, U+2066-9) and
// combining-mark stripping (Zalgo floods) -- exactly the task's own
// narrower SAF-02 text. Homoglyph folding, leet/separator folding and
// repeated-character collapse (present in the FULL register's fuller
// SAF-02 wording) are deliberately NOT built here -- they overlap
// SAF-03's phonetic-key territory and are deferred to whichever lane
// builds SAF-03/SAF-06, not silently dropped.

import { AhoCorasick } from './aho-corasick.js';

// -----------------------------------------------------------------------
// SAF-02/SAF-04 -- L0 normalisation.
// -----------------------------------------------------------------------

const ZERO_WIDTH_RE = /[​-‍﻿]/g;
const RTL_LTR_OVERRIDE_RE = /[‪-‮⁦-⁩]/g;
// Unicode general categories Mn (nonspacing mark), Mc (spacing
// combining mark) and Me (enclosing mark) -- combining marks stacked
// past what any legitimate diacritic needs are the "Zalgo" evasion
// S12.2.2 names. Stripped entirely from the MATCHING form only, never
// from the original.
const COMBINING_MARK_RE = /\p{M}/gu;

/**
 * SAF-02/SAF-04's L0 normalisation: NFKC, then strip zero-width
 * characters, RTL/LTR override characters and combining marks. Returns
 * a NEW string; `text` itself is never modified (strings are immutable
 * in JS, so this is a property of the language, not a discipline this
 * function has to maintain).
 *
 * Case-folding (lower-casing) is also applied here. This is NOT one of
 * S12.2.2's named SAF-02 bullets -- it is an engineering necessity for
 * L1 EXACT matching to be usable at all (an exact-match corpus that
 * only matched the literal case a term was typed in would miss nearly
 * everything), not a numeric limit, price, provider behaviour, legal
 * wording or retention window, so it does not fall under this task's
 * "never invent" constraint. Documented separately here so it is never
 * mistaken for a §31 SAF-02 sub-requirement in its own right.
 */
export function normalizeForSafetyMatching(text: string): string {
  return text
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(RTL_LTR_OVERRIDE_RE, '')
    .replace(COMBINING_MARK_RE, '')
    .toLowerCase();
}

// A character that counts as "inside a word" for SAF-05's whole-word
// check -- any Unicode letter or number. Evaluated on the NORMALISED
// text, after case-folding, so a whole-word check is script-agnostic
// (works identically for Devanagari, Latin, digits, etc.).
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function isWordChar(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  return WORD_CHAR_RE.test(text[index] as string); // bounds already checked above
}

// -----------------------------------------------------------------------
// SAF-05 -- corpus terms and matching.
// -----------------------------------------------------------------------

export type SafetyDecisionValue = 'allow' | 'mask' | 'hold' | 'block';
export type ModeratorReviewDecisionValue = 'allow' | 'hold';

/** A corpus term as read from app_private.get_safety_corpus_terms (packages/db/migrations/0151). `term` is the RAW, creator/staff-typed text -- normalised inside this pipeline via the same `normalizeForSafetyMatching` call used on message text (SAF-01: one normalisation implementation, applied identically to both sides of the match). */
export type SafetyCorpusTermForMatching = {
  id: string;
  term: string;
  wholeWord: boolean;
  displayDecision: SafetyDecisionValue;
  ttsDecision: SafetyDecisionValue;
  moderatorReviewDecision: ModeratorReviewDecisionValue;
};

type MatchedTerm = SafetyCorpusTermForMatching & { start: number; end: number };

function findMatchedTerms(normalizedText: string, corpusTerms: readonly SafetyCorpusTermForMatching[]): MatchedTerm[] {
  if (corpusTerms.length === 0) return []; // SAF: corpus empty by default => matches nothing, never everything

  const byId = new Map(corpusTerms.map((t) => [t.id, t] as const));
  const automaton = new AhoCorasick(
    corpusTerms.map((t) => ({ id: t.id, pattern: normalizeForSafetyMatching(t.term) })),
  );

  const rawMatches = automaton.findAll(normalizedText);
  const matched: MatchedTerm[] = [];
  for (const m of rawMatches) {
    const term = byId.get(m.id);
    if (!term) continue;
    if (term.wholeWord) {
      // SAF-05: whole-word and substring rules are kept separate. A
      // whole-word term only counts when neither the character before
      // its start nor the character at its end is itself a word
      // character -- "assist" must not match a substring inside a
      // longer, unrelated word.
      const boundaryBefore = !isWordChar(normalizedText, m.start - 1);
      const boundaryAfter = !isWordChar(normalizedText, m.end);
      if (!boundaryBefore || !boundaryAfter) continue;
    }
    matched.push({ ...term, start: m.start, end: m.end });
  }
  return matched;
}

// -----------------------------------------------------------------------
// SAF-09 -- per-surface decisions.
// -----------------------------------------------------------------------

const SEVERITY_ORDER: Record<SafetyDecisionValue, number> = { allow: 0, mask: 1, hold: 2, block: 3 };
const MODERATOR_SEVERITY_ORDER: Record<ModeratorReviewDecisionValue, number> = { allow: 0, hold: 1 };

function mostSevere(values: readonly SafetyDecisionValue[]): SafetyDecisionValue {
  return values.reduce((worst, v) => (SEVERITY_ORDER[v] > SEVERITY_ORDER[worst] ? v : worst), 'allow' as SafetyDecisionValue);
}

function mostSevereModerator(values: readonly ModeratorReviewDecisionValue[]): ModeratorReviewDecisionValue {
  return values.reduce((worst, v) => (MODERATOR_SEVERITY_ORDER[v] > MODERATOR_SEVERITY_ORDER[worst] ? v : worst), 'allow' as ModeratorReviewDecisionValue);
}

/**
 * SAF-09: one decision PER SURFACE, never one verdict reinterpreted five
 * ways. `payment` and `storedRecord` are structural constants -- see
 * this type's own fields -- never derived from a match, matching
 * S12.2.4's table exactly ("Payment: Never affected by content... Stored
 * record: Always stored in full").
 */
export type SafetyPerSurfaceDecision = {
  /** FULL-PRODUCT-DEFINITION.md §12.2.4: "Never affected by content. A message is never a reason to reject money." Always 'allow', regardless of any match -- never read from a corpus term. */
  payment: 'allow';
  display: SafetyDecisionValue;
  tts: SafetyDecisionValue;
  /** §12.2.4: "Always stored in full -- it is a durable record." Always 'allow' on a row that exists at all -- see packages/db/migrations/0151's check constraint for the database-enforced half of this. */
  storedRecord: 'allow';
  moderatorReview: ModeratorReviewDecisionValue;
};

export type SafetyPipelineNoMatchResult = {
  matched: false;
  /** Exactly the caller's input, untouched (SAF-04). */
  original: string;
};

export type SafetyPipelineMatchResult = {
  matched: true;
  /** Exactly the caller's input, untouched (SAF-04) -- present on every result, matched or not. */
  original: string;
  /** The parallel matching form L0 produced (SAF-02/SAF-04). Never the same object/reference as `original`, and never written back over it. */
  normalized: string;
  /** L1 is exact/whole-word matching, never fuzzy -- confidence is always 1 for a match this pipeline produces (see the migration's own note on why this is not an invented number). */
  confidence: 1;
  layer: 'l1';
  matchedTermIds: string[];
  decisions: SafetyPerSurfaceDecision;
};

export type SafetyPipelineResult = SafetyPipelineNoMatchResult | SafetyPipelineMatchResult;

export type RunSafetyPipelineInput = {
  text: string;
  corpusTerms: readonly SafetyCorpusTermForMatching[];
};

/**
 * SAF-01's single entry point. Every surface (tips, TTS, chat, display
 * names, and everything else FULL-PRODUCT-DEFINITION.md §12.2.1 names)
 * is meant to call this one function with its own text and the corpus
 * resolved for the relevant channel (app_private.get_safety_corpus_terms,
 * migration 0151) -- there is no per-surface variant.
 *
 * A clean message (no corpus term matches) returns `{ matched: false,
 * original }` -- deliberately WITHOUT a normalised form or a decisions
 * object, so a caller cannot accidentally persist evidence for a message
 * that was never actioned (see the migration's own retention section:
 * raw unactioned text is never written anywhere).
 */
export function runSafetyPipeline(input: RunSafetyPipelineInput): SafetyPipelineResult {
  const original = input.text;
  const normalized = normalizeForSafetyMatching(original);
  const matches = findMatchedTerms(normalized, input.corpusTerms);

  if (matches.length === 0) {
    return { matched: false, original };
  }

  const decisions: SafetyPerSurfaceDecision = {
    payment: 'allow',
    display: mostSevere(matches.map((m) => m.displayDecision)),
    tts: mostSevere(matches.map((m) => m.ttsDecision)),
    storedRecord: 'allow',
    moderatorReview: mostSevereModerator(matches.map((m) => m.moderatorReviewDecision)),
  };

  return {
    matched: true,
    original,
    normalized,
    confidence: 1,
    layer: 'l1',
    matchedTermIds: [...new Set(matches.map((m) => m.id))],
    decisions,
  };
}
