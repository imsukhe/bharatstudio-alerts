import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatNowPlayingLabel,
  isNewPlay,
  isOverlaySoundboardPlay,
  type OverlaySoundboardPlay,
} from './safe-soundboard-logic';

/*
 * §6 catalogue module #6 (Safe Soundboard Alert) — pure-helper cases.
 *
 * The case that carries a recorded product decision rather than a
 * mechanical requirement is the INSECURE-URL one: playbackUrl must be
 * https or null, never any other scheme, because it is the one field on
 * this whole path capable of naming an external resource reaching the
 * Master Canvas (§9.1.1). The other cases that matter are negative and
 * cover the module name's own meaning: nothing this file accepts can
 * claim a clip is safe, approved, checked, reviewed, vetted or curated,
 * because no such field exists in the type at all.
 */

const play: OverlaySoundboardPlay = {
  schemaVersion: 'v1',
  playId: '00000000-0000-4000-8000-000000005c91',
  clipKind: 'catalogue',
  displayName: 'Air Horn',
  playbackUrl: 'https://cdn.example.com/soundboard/catalogue/air-horn',
  mimeType: 'audio/mpeg',
  durationSeconds: 3,
  triggeredAt: '2026-09-17T10:00:00.000Z',
};

test('a well-formed play with an https playback URL is accepted', () => {
  assert.equal(isOverlaySoundboardPlay(play), true);
});

test('a null playbackUrl is accepted -- the CDN base is configured-but-unset in every environment today', () => {
  assert.equal(isOverlaySoundboardPlay({ ...play, playbackUrl: null }), true);
});

test('a non-https playback URL is rejected, whatever the scheme', () => {
  for (const scheme of ['http://cdn.example.com/x', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://x/y']) {
    assert.equal(isOverlaySoundboardPlay({ ...play, playbackUrl: scheme }), false, scheme);
  }
});

test('an extra key -- a rating, a moderation flag, a viewer id -- is rejected outright', () => {
  for (const extra of ['isApproved', 'moderationState', 'viewerId', 'contentRating']) {
    assert.equal(isOverlaySoundboardPlay({ ...play, [extra]: true }), false, extra);
  }
});

test('a missing key, a wrong schemaVersion, an unknown clipKind and a non-audio mimeType are all rejected', () => {
  const { displayName, ...missingDisplayName } = play;
  void displayName;
  assert.equal(isOverlaySoundboardPlay(missingDisplayName), false);
  assert.equal(isOverlaySoundboardPlay({ ...play, schemaVersion: 'v2' }), false);
  assert.equal(isOverlaySoundboardPlay({ ...play, clipKind: 'viewer_submitted' }), false);
  assert.equal(isOverlaySoundboardPlay({ ...play, mimeType: 'text/html' }), false);
});

test('null and non-object values are rejected', () => {
  assert.equal(isOverlaySoundboardPlay(null), false);
  assert.equal(isOverlaySoundboardPlay('safe'), false);
  assert.equal(isOverlaySoundboardPlay([play]), false);
});

test('isNewPlay: a fresh play, a repeat of the last-played id, and null both behave correctly', () => {
  assert.equal(isNewPlay(play, null), true);
  assert.equal(isNewPlay(play, play.playId), false);
  assert.equal(isNewPlay(play, 'some-other-id'), true);
  assert.equal(isNewPlay(null, play.playId), false);
});

test('formatNowPlayingLabel names only the creator-supplied clip label, never a claim about its content', () => {
  assert.equal(formatNowPlayingLabel(play), '\u{1F50A} Air Horn');
});
