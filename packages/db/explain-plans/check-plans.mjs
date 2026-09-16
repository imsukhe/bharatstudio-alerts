#!/usr/bin/env node
// RT-12 plan-refresh change detector.
//
// For each <widget>.explain.md artifact in this directory, re-extracts the
// CURRENT text of the function body it documents out of the actual
// migration file in packages/db/migrations/, recomputes its sha256 hash
// with the exact same extraction method used when the artifact's
// `query_hash` was captured, and compares. A mismatch means the function's
// SQL changed since its EXPLAIN was last captured and the plan needs
// re-verification (re-run the capture, update the artifact).
//
// No live database connection is used or needed — this is a static text
// check only. It proves the artifact is still describing the function as
// it exists today; it says nothing about the query's actual runtime plan.
//
// Exit code 0 + "OK: 10/10 plans current" when every artifact's recorded
// query_hash matches the migration file's current function body.
// Exit code 1, printing each mismatched widget by name, otherwise.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

// Same extraction method used to compute query_hash when each artifact was
// written: the text from the `create or replace function <fn>(` line
// through the terminating `$$;` line, inclusive, exactly as it appears in
// the migration file (original newlines/whitespace preserved), hashed with
// sha256 over the UTF-8 bytes. Keep this in lockstep with how the artifacts
// were generated — if this changes, every artifact's query_hash must be
// recomputed and rewritten to match, or the check will always fail.
function extractFunctionBlock(fileText, fnName) {
  const lines = fileText.split('\n');
  const startRe = new RegExp('^create or replace function ' + fnName.replace(/\./g, '\\.') + '\\(');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) {
    return null;
  }
  let endIdx = -1;
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].trim() === '$$;') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return null;
  }
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const artifactFiles = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.explain.md'))
  .sort();

if (artifactFiles.length === 0) {
  console.error('No .explain.md artifacts found in packages/db/explain-plans/.');
  process.exit(1);
}

const mismatches = [];
const errors = [];
let checked = 0;

for (const artifactFile of artifactFiles) {
  const widget = artifactFile.replace(/\.explain\.md$/, '');
  const artifactText = fs.readFileSync(path.join(__dirname, artifactFile), 'utf8');

  const fileLineMatch = artifactText.match(/Defined at: `packages\/db\/migrations\/([^:`]+):(\d+)`/);
  const fnNameMatch = artifactText.match(/Function: `(app_private\.[a-zA-Z0-9_]+)\(/);
  const hashMatch = artifactText.match(/query_hash: `([0-9a-f]{64})`/);

  if (!fileLineMatch || !fnNameMatch || !hashMatch) {
    errors.push(`${widget}: could not parse Defined-at / Function / query_hash lines out of ${artifactFile}`);
    continue;
  }

  const migrationFile = fileLineMatch[1];
  const fnName = fnNameMatch[1];
  const recordedHash = hashMatch[1];

  const migrationPath = path.join(MIGRATIONS_DIR, migrationFile);
  if (!fs.existsSync(migrationPath)) {
    errors.push(`${widget}: migration file not found: packages/db/migrations/${migrationFile}`);
    continue;
  }

  const migrationText = fs.readFileSync(migrationPath, 'utf8');
  const block = extractFunctionBlock(migrationText, fnName);
  if (block === null) {
    errors.push(`${widget}: could not locate current body of ${fnName} in packages/db/migrations/${migrationFile}`);
    continue;
  }

  const currentHash = sha256(block);
  checked += 1;
  if (currentHash !== recordedHash) {
    mismatches.push({ widget, fnName, migrationFile, recordedHash, currentHash });
  }
}

if (errors.length > 0) {
  console.error('RT-12 plan-refresh check: parse/lookup errors:');
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
}

if (mismatches.length > 0) {
  console.error(`RT-12 plan-refresh check: ${mismatches.length} widget(s) out of date:`);
  for (const m of mismatches) {
    console.error(
      `  - ${m.widget}: ${m.fnName} in packages/db/migrations/${m.migrationFile} changed ` +
        `(recorded ${m.recordedHash.slice(0, 12)}... != current ${m.currentHash.slice(0, 12)}...) ` +
        `— re-run the EXPLAIN capture and update packages/db/explain-plans/${m.widget}.explain.md`
    );
  }
}

if (mismatches.length > 0 || errors.length > 0) {
  process.exit(1);
}

console.log(`OK: ${checked}/${artifactFiles.length} plans current`);
process.exit(0);
