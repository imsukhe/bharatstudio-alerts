#!/usr/bin/env node
// RT-12 blind-spot closure, half 2 of 2 (half 1 is check-plans.mjs, which
// verifies every MANIFEST entry has a current artefact). This script is
// the "make forgetting hard" half: it scans the API source tree for every
// app_private.list_overlay_* call actually present in an overlay/widget-
// facing route or store file, and FAILS THE BUILD if one of them is not
// in required-queries.json's manifest -- so a new overlay route wired to
// an unlisted function fails the build, not merely ships without a plan
// artefact (bharatstudio-requirements/reviews/2026-09-16-prf-02-slice-2-
// scope-review.md, decision #2).
//
// DETECTION RULE: every overlay-facing widget-snapshot function in this
// codebase's migrations follows one naming convention without exception
// (verified at the time this script was written: 13/13) --
// `app_private.list_overlay_<name>`. Every migration that defines one
// says so directly ("same overlay_sessions/token-fingerprint scoping as
// list_overlay_X"). This script keys off that convention rather than
// tracing route-to-store call graphs (which would need a real TypeScript
// analyzer to do honestly) -- simpler, and exactly as strict as the
// codebase's own established pattern.
//
// WHAT THIS DOES NOT CATCH (stated here because a scan that does not say
// what it misses is worse than no scan -- see this task's own record):
//   - A widget-backing function that does NOT follow the list_overlay_*
//     convention would NOT be found by this scan. list_channel_master_
//     canvas_modules (creator-facing, no overlay_sessions gate) is exactly
//     this case, which is why it is in the manifest by explicit addition,
//     not because this scan would ever nominate it.
//   - A function called only through a level of indirection this regex
//     cannot see (e.g. built as a string at runtime) would not be found.
//     Every current call site in this codebase is a literal
//     `app_private.fn_name(` inside a tagged SQL template, so this is a
//     theoretical gap today, not an observed one.
//   - Whether a found function is genuinely "widget-backing" versus some
//     other kind of overlay read is a human judgement this script does
//     not make -- it treats every list_overlay_* call as in-scope, which
//     is deliberately over-inclusive (a false positive here just means
//     one more artefact to capture) rather than under-inclusive.
//
// Exit code 0 when every app_private.list_overlay_* call found in
// apps/api/src/db/*.ts and apps/api/src/routes/*.ts (excluding *.test.ts
// and dist/) has a manifest entry. Exit code 1, naming each offending
// call site, otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MANIFEST_PATH = path.join(__dirname, 'required-queries.json');
const SCAN_DIRS = [
  path.join(REPO_ROOT, 'apps', 'api', 'src', 'db'),
  path.join(REPO_ROOT, 'apps', 'api', 'src', 'routes'),
];

const CALL_RE = /app_private\.(list_overlay_[a-zA-Z0-9_]+)\(/g;

function readManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const names = new Set(parsed.queries.map((q) => q.function.replace(/^app_private\./, '')));
  return names;
}

function listSourceFiles(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(dir, f));
}

function scanFile(filePath, manifestNames, offenses) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    let match;
    CALL_RE.lastIndex = 0;
    while ((match = CALL_RE.exec(lines[i])) !== null) {
      const fnName = match[1];
      if (!manifestNames.has(fnName)) {
        offenses.push({ file: path.relative(REPO_ROOT, filePath), line: i + 1, fnName });
      }
    }
  }
}

const manifestNames = readManifest();
const offenses = [];

for (const dir of SCAN_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const file of listSourceFiles(dir)) {
    scanFile(file, manifestNames, offenses);
  }
}

if (offenses.length > 0) {
  console.error(`RT-12 required-queries scan: ${offenses.length} overlay-facing app_private call(s) missing from packages/db/explain-plans/required-queries.json:`);
  for (const offense of offenses) {
    console.error(`  - app_private.${offense.fnName} called at ${offense.file}:${offense.line} has no manifest entry -- add it to required-queries.json and capture an EXPLAIN artefact before this can pass`);
  }
  process.exit(1);
}

console.log(`OK: every app_private.list_overlay_* call in apps/api/src/db and apps/api/src/routes is present in required-queries.json (${manifestNames.size} manifest entries)`);
process.exit(0);
