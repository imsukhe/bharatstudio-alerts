import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTemplateManifestEntry } from '../src/domain/template-import-validation.js';

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    externalKey: 'BSA-001',
    displayName: 'Minimal Clean Tip',
    category: 'Minimal Clean',
    minTier: 'free',
    renderDocument: { v: '1.0', layers: [{ ty: 4, nm: 'circle' }] },
    ...overrides,
  };
}

test('accepts a well-formed manifest entry and returns its serialized bytes', () => {
  const result = validateTemplateManifestEntry(validEntry());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.renderBytes.byteLength > 0);
  }
});

test('rejects a non-object entry', () => {
  const result = validateTemplateManifestEntry('not-an-object');
  assert.equal(result.ok, false);
});

test('rejects an externalKey with disallowed characters', () => {
  const result = validateTemplateManifestEntry(validEntry({ externalKey: 'BSA 001 <script>' }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /externalKey/);
});

test('rejects an unrecognised minTier', () => {
  const result = validateTemplateManifestEntry(validEntry({ minTier: 'enterprise' }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /minTier/);
});

test('rejects a renderDocument carrying an inline script — the real catalogue\'s index.html shape', () => {
  const result = validateTemplateManifestEntry(validEntry({
    renderDocument: { v: '1.0', layers: [{ ty: 4, nm: '<script>alert(1)</script>' }] },
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /script/);
});

test('rejects a renderDocument with an embedded Lottie expression', () => {
  const result = validateTemplateManifestEntry(validEntry({
    renderDocument: { v: '1.0', layers: [{ ty: 4, expr: 'window.location' }] },
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /expression/);
});

test('rejects a renderDocument with an external (non data:) asset reference', () => {
  const result = validateTemplateManifestEntry(validEntry({
    renderDocument: { v: '1.0', layers: [{ ty: 4, u: 'https://evil.example/payload.png' }] },
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /external asset/);
});

test('rejects a renderDocument missing the layers array', () => {
  const result = validateTemplateManifestEntry(validEntry({ renderDocument: { v: '1.0' } }));
  assert.equal(result.ok, false);
});

test('rejects an oversized renderDocument (over the 2,000,000-byte cap shared with 0077)', () => {
  const bigLayers = Array.from({ length: 200_000 }, (_, i) => ({ ty: 4, nm: `layer-${i}` }));
  const result = validateTemplateManifestEntry(validEntry({ renderDocument: { v: '1.0', layers: bigLayers } }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /between 1 and 2000000 bytes/);
});
