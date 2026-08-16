import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ACTIVE_DOCUMENTS, canonicalText, PRIVACY_NOTICE, TERMS_OF_SERVICE } from './terms-content';

test('every active document exposes a valid 64-hex-char SHA-256 digest matching its canonical text', () => {
  for (const doc of ACTIVE_DOCUMENTS) {
    assert.match(doc.sha256Hex, /^[0-9a-f]{64}$/, `${doc.documentKey} sha256Hex is not a lowercase 64-hex digest`);
    const computed = createHash('sha256').update(canonicalText(doc), 'utf8').digest('hex');
    assert.equal(doc.sha256Hex, computed, `${doc.documentKey} sha256Hex is stale — rerun scripts/compute-terms-hash.ts`);
  }
});

test('canonicalText is deterministic and distinguishes different documents', () => {
  assert.equal(canonicalText(TERMS_OF_SERVICE), canonicalText(TERMS_OF_SERVICE));
  assert.notEqual(canonicalText(TERMS_OF_SERVICE), canonicalText(PRIVACY_NOTICE));
});

test('exactly two active documents are tracked, matching the seed migration', () => {
  assert.equal(ACTIVE_DOCUMENTS.length, 2);
  assert.deepEqual(ACTIVE_DOCUMENTS.map((d) => d.documentKey).sort(), ['privacy_notice', 'terms_of_service']);
  for (const doc of ACTIVE_DOCUMENTS) assert.equal(doc.version, 'v1.0');
});

test('every active document hash also appears in the DB seed migration (0068), so the two cannot silently drift', () => {
  const migrationPath = fileURLToPath(
    new URL('../../../../packages/db/migrations/0068_v1_l02_seed_terms_documents.sql', import.meta.url),
  );
  const migrationSql = readFileSync(migrationPath, 'utf8');
  for (const doc of ACTIVE_DOCUMENTS) {
    assert.ok(
      migrationSql.includes(doc.sha256Hex),
      `${doc.documentKey}'s hash ${doc.sha256Hex} is not present in 0068_v1_l02_seed_terms_documents.sql — the seed migration is stale relative to terms-content.ts`,
    );
  }
});
