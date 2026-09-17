import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeForSafetyMatching, runSafetyPipeline, type SafetyCorpusTermForMatching } from '../src/domain/safety-pipeline.js';
import { AhoCorasick } from '../src/domain/aho-corasick.js';

/*
 * SAF phase 1 (packages/db/migrations/0151_v1_saf_moderation_pipeline_spine.sql).
 * Pure, DB-free tests of the pipeline itself: L0 normalisation (SAF-02),
 * the original-is-never-destroyed guarantee (SAF-04), L1 Aho-Corasick
 * matching (SAF-05), per-surface decisions (SAF-09), and the SAF-01
 * "one pipeline" structural guard. The database-side halves of SAF-01
 * (corpus access revoked from bsa_app except through one function) and
 * SAF-04/SAF-09 (evidence table shape, check constraints) are proven
 * separately in packages/db/tests/saf_pipeline_spine.sql against a real
 * database -- this file does not duplicate that proof, it proves the
 * TypeScript layer those DB-side guarantees depend on.
 */

function term(overrides: Partial<SafetyCorpusTermForMatching> & Pick<SafetyCorpusTermForMatching, 'id' | 'term'>): SafetyCorpusTermForMatching {
  return {
    wholeWord: true,
    displayDecision: 'mask',
    ttsDecision: 'block',
    moderatorReviewDecision: 'hold',
    ...overrides,
  };
}

test('SAF-02/SAF-04: normalisation strips zero-width, RTL-override and combining marks, and folds NFKC -- without ever mutating the input', () => {
  const withZeroWidth = 'bad​word';
  const normalized = normalizeForSafetyMatching(withZeroWidth);
  assert.equal(normalized, 'badword');
  assert.equal(withZeroWidth, 'bad​word'); // input string is untouched -- JS strings are immutable, asserted anyway

  const withRtlOverride = 'text‮reversed';
  assert.equal(normalizeForSafetyMatching(withRtlOverride), 'textreversed');

  // Zalgo: a base letter with a flood of stacked combining marks collapses
  // to the base letter. These particular marks (overlay strokes/tildes)
  // have no precomposed Latin form, so NFKC leaves them as separate
  // combining characters -- exactly the shape \p{M} stripping exists for.
  const zalgo = 'e̴̵̶̷̸';
  assert.equal(normalizeForSafetyMatching(zalgo), 'e');

  // NFKC folds compatibility forms (e.g. fullwidth Latin) to their canonical form.
  assert.equal(normalizeForSafetyMatching('ａｂｃ'), 'abc'); // fullwidth "abc"
});

test('SAF-04: runSafetyPipeline always returns the exact original text, untouched, whether or not anything matched', () => {
  const original = 'Bad​word here';
  const corpus = [term({ id: 't1', term: 'badword' })];

  const matched = runSafetyPipeline({ text: original, corpusTerms: corpus });
  assert.equal(matched.matched, true);
  assert.equal(matched.original, original);
  if (matched.matched) assert.notEqual(matched.normalized, matched.original);

  const clean = runSafetyPipeline({ text: 'nothing to see here', corpusTerms: corpus });
  assert.equal(clean.matched, false);
  assert.equal(clean.original, 'nothing to see here');
});

test('SAF: an empty corpus matches nothing -- never everything', () => {
  const result = runSafetyPipeline({ text: 'absolutely anything at all, badword included', corpusTerms: [] });
  assert.equal(result.matched, false);

  // Also proven directly at the automaton level: an empty pattern list never matches, for any text.
  const automaton = new AhoCorasick([]);
  assert.deepEqual(automaton.findAll('anything'), []);
});

test('SAF-05: whole-word matching does not match inside a longer, unrelated word; substring matching does', () => {
  const wholeWordCorpus = [term({ id: 't1', term: 'assist', wholeWord: true })];
  const insideLongerWord = runSafetyPipeline({ text: 'please assistant me', corpusTerms: wholeWordCorpus });
  assert.equal(insideLongerWord.matched, false, '"assist" (whole-word) must not match inside "assistant"');

  const standalone = runSafetyPipeline({ text: 'please assist me', corpusTerms: wholeWordCorpus });
  assert.equal(standalone.matched, true);

  const substringCorpus = [term({ id: 't2', term: 'assist', wholeWord: false })];
  const substringMatch = runSafetyPipeline({ text: 'please assistant me', corpusTerms: substringCorpus });
  assert.equal(substringMatch.matched, true, 'a substring rule must match inside a longer word by design');
});

test('SAF-05: matches both a global-shaped and a per-creator-shaped term in one pass (multi-pattern Aho-Corasick, one automaton)', () => {
  const corpus = [
    term({ id: 'global-1', term: 'zzzglobalterm' }),
    term({ id: 'creator-1', term: 'zzzcreatorterm', displayDecision: 'block' }),
  ];
  const result = runSafetyPipeline({ text: 'zzzglobalterm and zzzcreatorterm both here', corpusTerms: corpus });
  assert.equal(result.matched, true);
  if (result.matched) {
    assert.deepEqual([...result.matchedTermIds].sort(), ['creator-1', 'global-1']);
  }
});

test('SAF-09: per-surface decisions are independent -- payment is ALWAYS allow, and display/tts/moderatorReview can differ from each other on the SAME text', () => {
  const corpus = [term({ id: 't1', term: 'badword', displayDecision: 'mask', ttsDecision: 'block', moderatorReviewDecision: 'hold' })];
  const result = runSafetyPipeline({ text: 'a badword right here', corpusTerms: corpus });
  assert.equal(result.matched, true);
  if (!result.matched) return;

  assert.equal(result.decisions.payment, 'allow', 'money is never affected by content, FULL-PRODUCT-DEFINITION.md S12.2.4');
  assert.equal(result.decisions.storedRecord, 'allow', 'an actioned message is always stored in full, S12.2.4');
  assert.equal(result.decisions.display, 'mask');
  assert.equal(result.decisions.tts, 'block');
  assert.equal(result.decisions.moderatorReview, 'hold');
  // The three configurable surfaces are NOT all equal -- proves this is
  // genuinely per-surface, not one verdict fanned out identically.
  assert.notEqual(result.decisions.display, result.decisions.tts);
});

test('SAF-09: the most severe matched decision wins per surface when multiple terms match the same text', () => {
  const corpus = [
    term({ id: 't1', term: 'zzzmild', displayDecision: 'mask', ttsDecision: 'mask', moderatorReviewDecision: 'allow' }),
    term({ id: 't2', term: 'zzzsevere', displayDecision: 'block', ttsDecision: 'hold', moderatorReviewDecision: 'hold' }),
  ];
  const result = runSafetyPipeline({ text: 'zzzmild and zzzsevere together', corpusTerms: corpus });
  assert.equal(result.matched, true);
  if (!result.matched) return;
  assert.equal(result.decisions.display, 'block'); // block > mask
  assert.equal(result.decisions.tts, 'hold'); // hold > mask
  assert.equal(result.decisions.moderatorReview, 'hold'); // hold > allow
});

test('SAF: L1 confidence is always exactly 1 (exact match, never fuzzy) and the layer is always "l1"', () => {
  const result = runSafetyPipeline({ text: 'a badword here', corpusTerms: [term({ id: 't1', term: 'badword' })] });
  assert.equal(result.matched, true);
  if (result.matched) {
    assert.equal(result.confidence, 1);
    assert.equal(result.layer, 'l1');
  }
});

// -----------------------------------------------------------------------
// SAF-01: structural "one pipeline" guard. Scans apps/api/src for a
// second normalisation/matching implementation and fails the moment one
// appears -- this is the test the task asks for: "a structural test
// that fails if a second matching implementation appears."
// -----------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const ALLOWED_NORMALIZE_FILE = path.join(SRC_DIR, 'domain', 'safety-pipeline.ts');
const ALLOWED_AHO_CORASICK_FILE = path.join(SRC_DIR, 'domain', 'aho-corasick.ts');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Pre-existing, unrelated `.normalize(` call sites, verified by reading
// each one -- NOT a second safety-MATCHING implementation, so exempting
// them here is a written, reviewable claim (the same shape
// required-queries.json's own exemption set uses), not a silent carve-
// out. A new entry may only be added with the same kind of citation.
const NORMALIZE_EXEMPTIONS: Record<string, string> = {
  'tts/provider.ts': 'sanitizeTtsText (apps/api/src/tts/provider.ts:33-40), pre-existing before this migration. Its own comment: "This is deliberately a technical safety boundary rather than a content policy... Language moderation and account-level blocks need separately approved policy." It strips control characters/URLs/markup for provider transport safety and never reads a corpus or produces a match/decision -- it is FULL-PRODUCT-DEFINITION.md S12.2\'s own "current state, that is the entire filter" this migration exists to go beyond, not a competing implementation of it.',
};

test('SAF-01: no second L0-normalisation call site exists outside domain/safety-pipeline.ts (beyond the one written, cited, pre-existing exemption)', () => {
  const offenders: string[] = [];
  for (const file of listTsFiles(SRC_DIR)) {
    if (file === ALLOWED_NORMALIZE_FILE) continue;
    const relative = path.relative(SRC_DIR, file);
    if (NORMALIZE_EXEMPTIONS[relative]) continue;
    const text = fs.readFileSync(file, 'utf8');
    // `.normalize(` on a string is the shape of an NFKC-style
    // normalisation call. safety-pipeline.ts is the only file allowed
    // to contain one for SAFETY MATCHING purposes -- everything else
    // must call normalizeForSafetyMatching instead of reimplementing L0
    // itself, or carry a written exemption above like tts/provider.ts.
    if (/\.normalize\(/.test(text)) offenders.push(relative);
  }
  assert.deepEqual(offenders, [], `an UNEXEMPTED second .normalize( call site was found outside domain/safety-pipeline.ts: ${offenders.join(', ')} -- SAF-01 requires exactly one L0 normalisation implementation for safety matching, or a written exemption citing why it is not one`);
});

test('SAF-01: the identifier "AhoCorasick" appears nowhere in apps/api/src except the one automaton file and its one caller', () => {
  const offenders: string[] = [];
  for (const file of listTsFiles(SRC_DIR)) {
    if (file === ALLOWED_AHO_CORASICK_FILE || file === ALLOWED_NORMALIZE_FILE) continue;
    const text = fs.readFileSync(file, 'utf8');
    // A second implementation of the algorithm would, by definition,
    // have to call or name itself after it to plausibly claim to BE
    // Aho-Corasick -- catching the exact identifier everywhere else in
    // the source tree is a simple, zero-false-positive proxy for "no
    // second implementation exists" (unlike a loose word-fragment scan,
    // which false-positived on ordinary identifiers like
    // `importManifestEntries` containing the substring "trie"). What
    // this does NOT catch, stated rather than hidden: a genuinely
    // different multi-pattern matcher that does not use this name at
    // all. That is a real, acknowledged limit of any naming-based
    // static check, the same kind scan-required-queries.mjs's own
    // header documents for its own rules.
    if (/AhoCorasick/.test(text)) offenders.push(path.relative(SRC_DIR, file));
  }
  assert.deepEqual(offenders, [], `the identifier "AhoCorasick" was found outside domain/aho-corasick.ts and domain/safety-pipeline.ts: ${offenders.join(', ')} -- SAF-01/SAF-05 require exactly one first-party automaton implementation with exactly one caller`);
});
