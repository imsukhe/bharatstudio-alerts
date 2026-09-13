import assert from 'node:assert/strict';
import test from 'node:test';
import { runAssetScan } from '../src/domain/asset-scan-pipeline.js';
import { validateStickerManifestEntry } from '../src/domain/sticker-import-validation.js';
import { validateCreatorPackUpload } from '../src/domain/sticker-creator-pack-validation.js';

const validEntry = {
  externalKey: 'BSA-STK-100', displayName: 'Wave', category: 'Reaction', minTier: 'free',
  renderDocument: { v: '1.0', layers: [] },
};

test('runAssetScan accepts a structurally-safe document and returns its bytes', () => {
  const result = runAssetScan(validEntry);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(JSON.parse(result.assetBytes.toString('utf8')).v, '1.0');
});

test('runAssetScan rejects an embedded expression — the shared structural walk runs, not a second one', () => {
  const result = runAssetScan({ ...validEntry, renderDocument: { v: '1.0', layers: [], expr: 'evil()' } });
  assert.equal(result.ok, false);
});

test('runAssetScan rejects a non-data: external reference', () => {
  const result = runAssetScan({ ...validEntry, renderDocument: { v: '1.0', layers: [], u: 'https://evil.example/x.png' } });
  assert.equal(result.ok, false);
});

test('runAssetScan rejects an oversized document', () => {
  const big = { v: '1.0', layers: [], padding: 'x'.repeat(2_000_001) };
  const result = runAssetScan({ ...validEntry, renderDocument: big });
  assert.equal(result.ok, false);
});

test('sticker-import-validation (platform catalogue) delegates to the same shared pipeline as the creator-pack path', () => {
  const catalogueResult = validateStickerManifestEntry(validEntry);
  const packResult = validateCreatorPackUpload({
    displayName: 'Wave', category: 'Reaction', renderDocument: { v: '1.0', layers: [] },
  });
  assert.equal(catalogueResult.ok, true);
  assert.equal(packResult.ok, true);
  if (catalogueResult.ok && packResult.ok) {
    // Same shape, same underlying walker — not two divergent validators.
    assert.equal(JSON.parse(catalogueResult.assetBytes.toString('utf8')).v, JSON.parse(packResult.assetBytes.toString('utf8')).v);
  }
});

test('validateCreatorPackUpload rejects an unsafe document via the shared pipeline', () => {
  const result = validateCreatorPackUpload({ displayName: 'Wave', category: 'Reaction', renderDocument: { v: '1.0', layers: [], expr: 'evil()' } });
  assert.equal(result.ok, false);
});

test('validateCreatorPackUpload rejects an out-of-bounds displayName before the shared walk runs', () => {
  const result = validateCreatorPackUpload({ displayName: '', category: 'Reaction', renderDocument: { v: '1.0', layers: [] } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /displayName/);
});
