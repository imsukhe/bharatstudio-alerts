import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStickerManifestEntry } from '../src/domain/sticker-import-validation.js';

// Mirrors l20-template-import-validation.test.ts's cases exactly, because
// validateStickerManifestEntry is a thin wrapper over
// validateTemplateManifestEntry (which itself wraps validateLottieDocument)
// — reused, not re-implemented. See the module's own header comment.

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    externalKey: 'BSA-STK-001',
    displayName: 'Confetti Pop',
    category: 'Celebration',
    minTier: 'free',
    renderDocument: { v: '1.0', layers: [{ ty: 4, nm: 'confetti' }] },
    ...overrides,
  };
}

test('accepts a well-formed sticker manifest entry and returns its serialized bytes', () => {
  const result = validateStickerManifestEntry(validEntry());
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.assetBytes.byteLength > 0);
});

test('rejects a non-object entry', () => {
  const result = validateStickerManifestEntry('not-an-object');
  assert.equal(result.ok, false);
});

test('rejects an unrecognised minTier', () => {
  const result = validateStickerManifestEntry(validEntry({ minTier: 'enterprise' }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /minTier/);
});

test('rejects an asset carrying an inline script', () => {
  const result = validateStickerManifestEntry(validEntry({
    renderDocument: { v: '1.0', layers: [{ ty: 4, nm: '<script>alert(1)</script>' }] },
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /script/);
});

test('rejects an asset with an embedded expression', () => {
  const result = validateStickerManifestEntry(validEntry({
    renderDocument: { v: '1.0', layers: [{ ty: 4, expr: 'window.location' }] },
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /expression/);
});

test('rejects an asset with an external (non data:) reference', () => {
  const result = validateStickerManifestEntry(validEntry({
    renderDocument: { v: '1.0', layers: [{ ty: 4, u: 'https://evil.example/payload.png' }] },
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /external asset/);
});

test('rejects an oversized asset (over the 2,000,000-byte cap shared with 0077/0106)', () => {
  const bigLayers = Array.from({ length: 200_000 }, (_, i) => ({ ty: 4, nm: `layer-${i}` }));
  const result = validateStickerManifestEntry(validEntry({ renderDocument: { v: '1.0', layers: bigLayers } }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /between 1 and 2000000 bytes/);
});
