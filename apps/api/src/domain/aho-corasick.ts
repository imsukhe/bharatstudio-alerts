// SAF-05 (packages/db/migrations/0151_v1_saf_moderation_pipeline_spine.sql):
// a first-party Aho-Corasick automaton. No third-party dependency was
// added for this -- the task's own instruction -- so this file is the
// entire implementation: trie construction, failure-link computation,
// and multi-pattern matching in a single pass over the text.
//
// THIS IS THE ONLY AHO-CORASICK-SHAPED MATCHER IN THIS CODEBASE (SAF-01).
// apps/api/test/safety-pipeline.test.ts scans apps/api/src for a second
// implementation (a second trie/failure-link construction) and fails the
// build if one appears. Nothing outside safety-pipeline.ts may construct
// an AhoCorasick instance directly -- see that file's own header for why
// the entry point is deliberately singular.
//
// Generic and reusable by design (operates on arbitrary string patterns,
// knows nothing about safety, corpora or decisions) so this file never
// needs to change when SAF-03/SAF-06 (phonetic keys, fuzzy matching)
// land later -- those are new callers of a still-generic automaton, not
// edits to it.

export type AhoCorasickPattern = {
  id: string;
  pattern: string;
};

export type AhoCorasickMatch = {
  id: string;
  /** Start offset (inclusive) in the searched text, UTF-16 code units. */
  start: number;
  /** End offset (exclusive) in the searched text, UTF-16 code units. */
  end: number;
};

type TrieNode = {
  children: Map<string, number>;
  fail: number;
  /** Pattern ids that end exactly at this node, INCLUDING every id inherited through the failure chain (so a shorter pattern that is a suffix of a longer one is never missed). */
  output: string[];
};

const ROOT = 0;

/**
 * A first-party, multi-pattern Aho-Corasick automaton. Construction is
 * O(sum of pattern lengths); each `findAll` call is O(text length +
 * number of matches) after that -- the whole point of L1 over a
 * corpus-sized pattern set being "microseconds, no provider" (SAF-05's
 * own cost note in FULL-PRODUCT-DEFINITION.md S12.2.3).
 *
 * Empty pattern list is a fully supported, tested case: `findAll` then
 * always returns `[]` for any input -- the mechanism an empty corpus
 * relies on to mean "matches nothing" (see safety-pipeline.ts and its
 * test file).
 */
export class AhoCorasick {
  private readonly nodes: TrieNode[] = [{ children: new Map(), fail: ROOT, output: [] }];
  private readonly patternLengths = new Map<string, number>();

  constructor(patterns: readonly AhoCorasickPattern[]) {
    for (const { id, pattern } of patterns) {
      if (pattern.length === 0) continue; // an empty pattern would match everywhere; never accepted
      this.insert(id, pattern);
    }
    this.buildFailureLinks();
  }

  // Every index passed here is either ROOT (0, always present -- the
  // constructor seeds it) or a value this class itself returned from
  // `this.nodes.push(...); this.nodes.length - 1`, so it is always a
  // valid index. One non-null assertion, centrally, rather than one at
  // every call site.
  private at(index: number): TrieNode {
    return this.nodes[index] as TrieNode;
  }

  private insert(id: string, pattern: string): void {
    let node = ROOT;
    let length = 0;
    for (const ch of pattern) {
      length += 1;
      let next = this.at(node).children.get(ch);
      if (next === undefined) {
        this.nodes.push({ children: new Map(), fail: ROOT, output: [] });
        next = this.nodes.length - 1;
        this.at(node).children.set(ch, next);
      }
      node = next;
    }
    this.at(node).output.push(id);
    this.patternLengths.set(id, length);
  }

  private buildFailureLinks(): void {
    const queue: number[] = [];
    for (const child of this.at(ROOT).children.values()) {
      this.at(child).fail = ROOT;
      queue.push(child);
    }
    let head = 0;
    while (head < queue.length) {
      const current = queue[head] as number;
      head += 1;
      for (const [ch, child] of this.at(current).children) {
        let fail = this.at(current).fail;
        while (fail !== ROOT && !this.at(fail).children.has(ch)) {
          fail = this.at(fail).fail;
        }
        const viaFail = this.at(fail).children.get(ch);
        const childFail = viaFail !== undefined && viaFail !== child ? viaFail : ROOT;
        this.at(child).fail = childFail;
        if (childFail !== ROOT) {
          this.at(child).output = [...this.at(child).output, ...this.at(childFail).output];
        }
        queue.push(child);
      }
    }
  }

  /** Every match of every pattern in `text`, in left-to-right, start-offset order. Overlapping matches are all returned -- filtering (e.g. whole-word) is the caller's job (see safety-pipeline.ts). */
  findAll(text: string): AhoCorasickMatch[] {
    const matches: AhoCorasickMatch[] = [];
    if (this.at(ROOT).children.size === 0) return matches; // empty corpus: nothing can ever match

    // Iterate by Unicode code point, not raw UTF-16 code unit, so a
    // surrogate pair is never split mid-character; offsets[i] is the
    // UTF-16 offset of code point i, with a trailing sentinel for the
    // end of the text.
    const chars = Array.from(text);
    const offsets: number[] = [];
    let cursor = 0;
    for (const ch of chars) {
      offsets.push(cursor);
      cursor += ch.length;
    }
    offsets.push(cursor);

    let node = ROOT;
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i] as string;
      while (node !== ROOT && !this.at(node).children.has(ch)) {
        node = this.at(node).fail;
      }
      const next = this.at(node).children.get(ch);
      node = next !== undefined ? next : ROOT;
      for (const id of this.at(node).output) {
        const length = this.patternLengths.get(id) ?? 0;
        const startCodePoint = i - length + 1;
        matches.push({ id, start: offsets[startCodePoint] as number, end: offsets[i + 1] as number });
      }
    }
    return matches.sort((a, b) => a.start - b.start || a.end - b.end);
  }
}
