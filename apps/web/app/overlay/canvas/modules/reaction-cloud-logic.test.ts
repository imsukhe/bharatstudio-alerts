import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatReactionLabel,
  hasReactions,
  isReactionCloud,
  isReactionCloudEntry,
  layoutReactionCloud,
  type ReactionCloudEntry,
} from './reaction-cloud-logic';

/*
 * PRF-02 slice 6 / PRF-06, §6 catalogue module #5 (Reaction Cloud) — the
 * pure half. No DOM, no browser, no runtime.
 */

const clap: ReactionCloudEntry = { entrySource: 'catalogue', entryId: 'e1', displayName: 'Clap', reactionCount: 12 };
const pack: ReactionCloudEntry = { entrySource: 'creator_pack', entryId: 'e2', displayName: 'Pack Star', reactionCount: 3 };

// --- the guard is the client's third narrowing -----------------------------

test('accepts exactly the four declared keys', () => {
  assert.equal(isReactionCloudEntry(clap), true);
  assert.equal(isReactionCloudEntry(pack), true);
});

test('rejects an entry carrying ANY identifying field, rather than ignoring it', () => {
  // This is the case the guard exists for. §6 #5's non-identifying rule is
  // enforced by the query; this is the last line, so a server that somehow
  // began returning one of these must render NOTHING rather than render it.
  for (const extra of [
    { viewerId: '00000000-0000-4000-8000-0000000000a1' },
    { viewerIdentityId: '00000000-0000-4000-8000-0000000000a2' },
    { anonymousIdentityId: 'anon-hash' },
    { sessionId: 'sess-1' },
    { overlaySessionId: 'ov-1' },
    { ipAddress: '203.0.113.7' },
    { createdAt: '2026-09-16T10:00:00.000Z' },
    { lastReactionAt: '2026-09-16T10:00:00.000Z' },
    { supporterName: 'Riya' },
    { message: 'a private supporter message' },
    { amountPaise: 300000 },
    // No asset ever travels on this path: a reaction is a send of an entry
    // that is ALREADY in the curated catalogue.
    { assetBytes: 'e30=' },
    { assetUrl: 'https://cdn.example.invalid/sticker.json' },
    { renderDocument: { v: '5.7.4' } },
  ]) {
    assert.equal(isReactionCloudEntry({ ...clap, ...extra }), false, `${Object.keys(extra)[0]} must fail the guard`);
  }
});

test('rejects a missing key, an unknown entry source, and a count that is not a positive integer', () => {
  assert.equal(isReactionCloudEntry({ entrySource: 'catalogue', entryId: 'e1', displayName: 'Clap' }), false);
  assert.equal(isReactionCloudEntry({ ...clap, entrySource: 'viewer_upload' }), false);
  assert.equal(isReactionCloudEntry({ ...clap, entrySource: 'emoji' }), false);
  assert.equal(isReactionCloudEntry({ ...clap, entryId: '' }), false);
  assert.equal(isReactionCloudEntry({ ...clap, displayName: '' }), false);
  for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '12']) {
    assert.equal(isReactionCloudEntry({ ...clap, reactionCount: count }), false, `count ${String(count)} must fail`);
  }
  assert.equal(isReactionCloudEntry(null), false);
  assert.equal(isReactionCloudEntry([clap]), false);
});

test('one bad entry invalidates the whole snapshot rather than being dropped quietly', () => {
  // A cloud quietly missing a glyph is indistinguishable from a correct
  // one on a broadcast surface, so there would be no way to notice the
  // server had started returning something unexpected.
  assert.equal(isReactionCloud([clap, pack]), true);
  assert.equal(isReactionCloud([]), true);
  assert.equal(isReactionCloud([clap, { ...pack, viewerId: 'v1' }]), false);
  assert.equal(isReactionCloud(null), false);
  assert.equal(isReactionCloud({ entries: [clap] }), false);
});

test('hasReactions distinguishes an empty cloud from a missing one only in type, not in outcome', () => {
  assert.equal(hasReactions([clap]), true);
  assert.equal(hasReactions([]), false);
  assert.equal(hasReactions(null), false);
});

// --- the label -------------------------------------------------------------

test('the label is the catalogue entry name and its count, never a person', () => {
  assert.equal(formatReactionLabel(clap), 'Clap ×12');
  assert.equal(formatReactionLabel(pack), 'Pack Star ×3');
});

// --- layout ----------------------------------------------------------------

test('layout is deterministic: same input, same output, every time', () => {
  const first = layoutReactionCloud([clap, pack]);
  const second = layoutReactionCloud([clap, pack]);
  assert.deepEqual(first, second);
});

test('layout scales by share of the busiest entry, with the busiest at 1', () => {
  const placements = layoutReactionCloud([clap, pack]);
  assert.equal(placements[0]!.scale, 1);
  assert.ok(placements[1]!.scale < 1, 'a quieter entry is drawn smaller');
  assert.ok(placements[1]!.scale > 0, 'a quieter entry is still drawn');
});

test('a single entry sits exactly where flow put it', () => {
  const [only] = layoutReactionCloud([clap]);
  assert.equal(only!.offsetXPercent, 0);
  assert.equal(only!.offsetYPercent, 0);
  assert.equal(only!.scale, 1);
});

test('layout never caps, drops or thins — sampling is server-side (§19.5)', () => {
  // Forty entries in, forty placements out. If this ever fails because a
  // cap was added here, the cap is in the wrong place: the ceiling is
  // REACTION_CLOUD_SAMPLE_MAX, applied inside migration 0139's SQL LIMIT.
  const many: ReactionCloudEntry[] = Array.from({ length: 40 }, (_, index) => ({
    entrySource: 'catalogue' as const,
    entryId: `e${index}`,
    displayName: `Entry ${index}`,
    reactionCount: 40 - index,
  }));
  assert.equal(layoutReactionCloud(many).length, 40);
});

test('layout of an empty cloud is empty', () => {
  assert.deepEqual(layoutReactionCloud([]), []);
});

test('every placement carries the entry id it came from, in order', () => {
  const placements = layoutReactionCloud([clap, pack]);
  assert.deepEqual(placements.map((placement) => placement.entryId), ['e1', 'e2']);
});
