#!/usr/bin/env node
/**
 * Computes the SHA-256 hex digest of each active terms document's
 * canonical text, using the exact same serialization as
 * app/accept-terms/terms-content.ts's canonicalText(). Run this whenever
 * TERMS_OF_SERVICE or PRIVACY_NOTICE text changes, then paste the printed
 * hashes into both terms-content.ts (sha256Hex) and the seed migration
 * (packages/db/migrations/0068_v1_l02_seed_terms_documents.sql).
 *
 * Uses tsx to import the TS module directly — no build step needed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTIVE_DOCUMENTS, canonicalText } from '../app/accept-terms/terms-content';

const contentPath = fileURLToPath(new URL('../app/accept-terms/terms-content.ts', import.meta.url));
let source = readFileSync(contentPath, 'utf8');

const placeholders: Record<string, string> = {
  terms_of_service: 'sha256Hex: \'__TOS_PLACEHOLDER__\'',
  privacy_notice: 'sha256Hex: \'__PRIVACY_PLACEHOLDER__\'',
};

for (const doc of ACTIVE_DOCUMENTS) {
  const text = canonicalText(doc);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  if (hash.length !== 64 || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`unexpected hash shape for ${doc.documentKey}: ${hash}`);
  }
  console.log(`${doc.documentKey} (${doc.version}): ${hash}`);
  // Replace this document's current sha256Hex value (whatever it currently
  // is) with the freshly computed one, scoped to this document's object
  // literal by matching documentKey first.
  const keyMarker = `documentKey: '${doc.documentKey}'`;
  const keyIndex = source.indexOf(keyMarker);
  if (keyIndex === -1) throw new Error(`documentKey marker not found for ${doc.documentKey}`);
  const hashFieldRe = /sha256Hex: '[^']*'/;
  const afterKey = source.slice(keyIndex);
  const match = hashFieldRe.exec(afterKey);
  if (!match) throw new Error(`sha256Hex field not found after ${doc.documentKey}`);
  const absoluteIndex = keyIndex + match.index;
  source = source.slice(0, absoluteIndex) + `sha256Hex: '${hash}'` + source.slice(absoluteIndex + match[0].length);
}

writeFileSync(contentPath, source);
console.log('terms-content.ts updated in place.');
