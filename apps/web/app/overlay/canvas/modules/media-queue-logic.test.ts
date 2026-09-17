import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentEntry,
  hasSomethingToShow,
  isMediaQueueEntry,
  isMediaQueueState,
  nextEntry,
  type MediaQueueEntry,
} from './media-queue-logic';

/*
 * §6 catalogue module #20 (Media / Meme Queue) — the pure logic's own
 * cases.
 *
 * The cases that carry a recorded product decision rather than a
 * mechanical requirement are the NEGATIVE ones, and each is asserted so
 * the decision cannot quietly rot into "it happens to work":
 *
 *   * a payload carrying a submitter/viewer/approval-shaped key is
 *     refused outright (owner decision 2026-09-17, MED-20: creator-only,
 *     viewers cannot submit).
 *   * a payload carrying MORE than two entries is refused outright
 *     (§12.7: current and next, never a queue depth).
 *   * a payload carrying two "current" or two "next" slots is refused.
 *   * a payload carrying a disallowed mime type (text/html,
 *     image/svg+xml) is refused (§9.1.1).
 *   * a payload carrying a non-https url is refused.
 */

const current: MediaQueueEntry = {
  schemaVersion: 'v1', queueSlot: 'current', title: 'First meme', mediaKind: 'image',
  mimeType: 'image/png', playbackUrl: 'https://cdn.example.com/a.png', thumbnailPlaybackUrl: null, durationMs: null,
};

const next: MediaQueueEntry = {
  schemaVersion: 'v1', queueSlot: 'next', title: 'Second clip', mediaKind: 'video',
  mimeType: 'video/mp4', playbackUrl: 'https://cdn.example.com/b.mp4', thumbnailPlaybackUrl: 'https://cdn.example.com/b-thumb.png', durationMs: 5000,
};

test('isMediaQueueEntry accepts a well-formed entry and rejects a malformed one', () => {
  assert.equal(isMediaQueueEntry(current), true);
  assert.equal(isMediaQueueEntry(next), true);
  assert.equal(isMediaQueueEntry({ ...current, queueSlot: 'later' }), false);
  assert.equal(isMediaQueueEntry({ ...current, title: '' }), false);
  assert.equal(isMediaQueueEntry({ ...current, title: 'x'.repeat(121) }), false);
  assert.equal(isMediaQueueEntry({ ...current, mediaKind: 'audio' }), false);
  assert.equal(isMediaQueueEntry({ ...current, mimeType: 'text/html' }), false, 'text/html must be refused (§9.1.1)');
  assert.equal(isMediaQueueEntry({ ...current, mimeType: 'image/svg+xml' }), false, 'image/svg+xml must be refused -- SVG can carry inline script');
  assert.equal(isMediaQueueEntry({ ...current, playbackUrl: 'http://cdn.example.com/a.png' }), false, 'a non-https playback url must be refused');
  assert.equal(isMediaQueueEntry({ ...current, thumbnailPlaybackUrl: 'http://cdn.example.com/thumb.png' }), false, 'a non-https thumbnail playback url must be refused');
  assert.equal(isMediaQueueEntry({ ...current, playbackUrl: null }), true, 'a null playbackUrl is a valid, honest "not resolvable yet" state (migration 0148)');
  assert.equal(isMediaQueueEntry({ ...current, durationMs: -1 }), false);
  assert.equal(isMediaQueueEntry(null), false);
  assert.equal(isMediaQueueEntry('not an object'), false);
});

test('isMediaQueueEntry rejects any submitter/viewer/approval-shaped key, even alongside otherwise-valid fields', () => {
  for (const poison of [
    { submitterId: 'x' }, { submittedBy: 'x' }, { viewerId: 'x' },
    { approved: true }, { approvalStatus: 'pending' }, { rejectionReason: 'no' },
  ]) {
    assert.equal(isMediaQueueEntry({ ...current, ...poison }), false, `expected rejection for ${JSON.stringify(poison)}`);
  }
});

test('isMediaQueueState accepts zero, one or two well-formed entries', () => {
  assert.equal(isMediaQueueState([]), true);
  assert.equal(isMediaQueueState([current]), true);
  assert.equal(isMediaQueueState([current, next]), true);
});

test('isMediaQueueState rejects more than two entries -- never a queue depth', () => {
  const third: MediaQueueEntry = { ...next, title: 'Should never render' };
  assert.equal(isMediaQueueState([current, next, third]), false);
});

test('isMediaQueueState rejects two entries claiming the same slot', () => {
  assert.equal(isMediaQueueState([current, { ...next, queueSlot: 'current' }]), false);
  assert.equal(isMediaQueueState([next, { ...current, queueSlot: 'next' }]), false);
});

test('isMediaQueueState rejects a non-array and an array containing a malformed entry', () => {
  assert.equal(isMediaQueueState({ current }), false);
  assert.equal(isMediaQueueState([{ ...current, mimeType: 'text/html' }]), false);
});

test('currentEntry / nextEntry select by slot regardless of array order', () => {
  assert.deepEqual(currentEntry([next, current]), current);
  assert.deepEqual(nextEntry([next, current]), next);
  assert.equal(currentEntry([]), null);
  assert.equal(nextEntry([current]), null, 'a single live item has no next entry to preload');
});

test('hasSomethingToShow is true only when a current entry exists AND its playbackUrl is resolved', () => {
  assert.equal(hasSomethingToShow([]), false);
  assert.equal(hasSomethingToShow([next]), false, 'a next-only snapshot never happens server-side, but the renderer must still show nothing for it');
  assert.equal(hasSomethingToShow([current]), true);
  assert.equal(hasSomethingToShow([current, next]), true);
  assert.equal(
    hasSomethingToShow([{ ...current, playbackUrl: null }]),
    false,
    'a null playbackUrl (migration 0148: mediaCdnBaseUrl unset) must render nothing, the same honest posture Sponsor Card and Soundboard already have',
  );
});
