import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeOverlayAudioUrl } from './alert-audio-url';

const apiOrigin = 'https://api.bharatstudio.example';
const artifactPath = '/v1/overlay-audio/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002';

test('relative overlay audio uses the configured API origin, never the browser-source origin', () => {
  // Deliberately no window/global browser origin: this pure boundary must not
  // accidentally bind audio routing to the OBS page host.
  assert.equal(
    safeOverlayAudioUrl(artifactPath, apiOrigin),
    `${apiOrigin}${artifactPath}`,
  );
  assert.equal(
    safeOverlayAudioUrl(`${apiOrigin}${artifactPath}`, `${apiOrigin}/`),
    `${apiOrigin}${artifactPath}`,
  );
});

test('overlay audio URL boundary rejects cross-origin, credentialed, malformed, and non-artifact inputs', () => {
  const rejected = [
    `https://overlay.bharatstudio.example${artifactPath}`,
    `https://attacker.example${artifactPath}`,
    `https://user:password@api.bharatstudio.example${artifactPath}`,
    '/v1/overlay-audio/only-one-segment',
    '/v1/overlay-audio/one/two/three',
    '/v1/overlay-lottie/one/two',
    '/v1/overlay-audio/one/%2Ftwo',
    `${artifactPath}?leak=1`,
    'not a URL',
  ];
  for (const value of rejected) assert.equal(safeOverlayAudioUrl(value, apiOrigin), undefined, value);
  assert.equal(safeOverlayAudioUrl(artifactPath, 'javascript:alert(1)'), undefined);
  assert.equal(safeOverlayAudioUrl(artifactPath, 'https://api.bharatstudio.example/unexpected-path'), undefined);
});
