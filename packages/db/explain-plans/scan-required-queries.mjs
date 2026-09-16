#!/usr/bin/env node
// RT-12 blind-spot closure, half 2 of 2 (half 1 is check-plans.mjs, which
// verifies every MANIFEST entry has a current artefact). This script is
// the "make forgetting hard" half: it scans the API source tree for
// app_private calls that back an overlay-facing surface and FAILS THE
// BUILD if one of them is not in required-queries.json's manifest OR its
// exemption set -- so a new overlay route wired to an unlisted function
// fails the build, not merely ships without a plan artefact
// (bharatstudio-requirements/reviews/2026-09-16-prf-02-slice-2-scope-
// review.md, decision #2).
//
// TWO DETECTION RULES, not one. This is the fix for a real, found gap
// (bharatstudio-requirements/reviews/2026-09-16-rt-12-scan-convention-
// independence.md): rule 1 alone missed 7 of 12 app_private calls inside
// the dedicated overlay store files, including app_private.get_overlay_
// events -- the alert stream itself, the single hottest overlay read in
// the product -- because none of them happens to start with
// `list_overlay_`.
//
//   RULE 1 -- CONVENTION SCAN (unchanged from before this fix, kept as a
//   safety net for the wider codebase): every `app_private.list_overlay_*`
//   call anywhere in apps/api/src/db/*.ts or apps/api/src/routes/*.ts
//   (excluding *.test.ts) must be in the manifest. This still catches an
//   overlay-facing function that follows the naming convention even when
//   it lives in a mixed-purpose file (e.g. interaction-sql-store.ts, which
//   backs both creator-facing config routes and list_overlay_vote_tally /
//   list_overlay_hype_mode / list_overlay_leaderboard for the overlay).
//
//   RULE 2 -- CONVENTION-INDEPENDENT SCAN, new in this fix: within files
//   that ARE dedicated overlay-facing stores, EVERY app_private.<fn>(
//   call, any name, must be in the manifest or the exemption set. This is
//   what closes the actual gap: it does not care what the function is
//   named.
//
//   "Dedicated overlay-facing store file" is decided by filename, not by
//   a hand-typed path list, so an eighth overlay store keeps working
//   without editing this script: any file directly under apps/api/src/db/
//   whose basename (case-insensitive) contains "overlay" or
//   "master-canvas". At the time this rule was written that is exactly
//   the seven files this task's command named (challenge-overlay-store,
//   goal-overlay-store, master-canvas-sql-store, overlay-audio-store,
//   overlay-branding-store, overlay-store, overlay-wakeup) -- six by the
//   "overlay" match, master-canvas-sql-store.ts by the "master-canvas"
//   match (it exports both a channel-facing store and
//   createSqlMasterCanvasOverlayStore, the overlay-facing one; PRF-02's
//   Master Canvas runtime is what the overlay renders, so its store
//   belongs in this rule even though "overlay" is not in the filename).
//   Rule 2 is deliberately restricted to apps/api/src/db/ (not routes/):
//   every route file that calls app_private directly today does so
//   through a comment reference only or not at all for the overlay/
//   master-canvas routes (verified by grep at the time this was written);
//   the actual calls live in the store files.
//
// WHAT THIS DOES NOT CATCH (stated here because a scan that does not say
// what it misses is worse than no scan -- see this task's own record):
//   - A genuinely overlay-facing function that lives in a file whose name
//     matches neither "overlay" nor "master-canvas" and that also does
//     NOT follow the list_overlay_* convention would be caught by
//     NEITHER rule. This is the direct descendant of the gap this fix
//     closes, one level up: it is now a filename-convention dependency
//     instead of a function-naming-convention dependency. A store file
//     named, say, `alert-stream-store.ts` created for some future overlay
//     feature would need either "overlay"/"master-canvas" added to this
//     rule or its own filename to already match, or it slips through
//     exactly as get_overlay_events did before this fix.
//   - A function called only through a level of indirection this regex
//     cannot see (e.g. built as a string at runtime, or re-exported and
//     invoked from a file rule 2 does not scan). Every current call site
//     in this codebase is a literal `app_private.fn_name(` inside a
//     tagged SQL template in a file rule 1 or rule 2 covers, so this is a
//     theoretical gap today, not an observed one.
//   - Whether a found function is genuinely "widget-backing" versus an
//     auth lookup, a predicate, or a write that does not need a plan is a
//     human judgement this script does not make. That is exactly what
//     the exemption set in required-queries.json is for: an exemption
//     entry is a deliberate, reviewable claim with its own written
//     reason, checked into the same file the manifest lives in --
//     REQUIRED, not merely allowed, for every non-manifested call rule 2
//     finds. A call with neither a manifest entry nor an exemption entry
//     fails the build, naming the call site, same as before.
//
// Exit code 0 when every call rule 1 and rule 2 find is covered by the
// manifest or (for rule 2 only) the exemption set. Exit code 1, naming
// each offending call site, otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MANIFEST_PATH = path.join(__dirname, 'required-queries.json');
const DB_DIR = path.join(REPO_ROOT, 'apps', 'api', 'src', 'db');
const ROUTES_DIR = path.join(REPO_ROOT, 'apps', 'api', 'src', 'routes');

// Rule 1 stays scoped to both db/ and routes/, as it always was.
const RULE1_SCAN_DIRS = [DB_DIR, ROUTES_DIR];
const RULE1_CALL_RE = /app_private\.(list_overlay_[a-zA-Z0-9_]+)\(/g;

// Rule 2 scans only apps/api/src/db/, and only the dedicated overlay-
// facing store files within it (see header comment for the filename rule
// and why routes/ is excluded).
const OVERLAY_FACING_FILENAME_RE = /overlay|master-canvas/i;
const RULE2_CALL_RE = /app_private\.([a-zA-Z0-9_]+)\(/g;

function readManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const manifestNames = new Set(parsed.queries.map((q) => q.function.replace(/^app_private\./, '')));
  const exemptions = Array.isArray(parsed.exemptions) ? parsed.exemptions : [];
  const exemptNames = new Set();
  const exemptionErrors = [];
  for (const entry of exemptions) {
    const fnName = typeof entry.function === 'string' ? entry.function.replace(/^app_private\./, '') : null;
    if (!fnName) {
      exemptionErrors.push(`exemptions entry missing "function": ${JSON.stringify(entry)}`);
      continue;
    }
    if (!entry.reason || typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      exemptionErrors.push(`exemptions entry for app_private.${fnName} has no "reason" -- every exemption must carry a written reason`);
      continue;
    }
    exemptNames.add(fnName);
  }
  return { manifestNames, exemptNames, exemptionErrors };
}

function listSourceFiles(dir, filenameFilter) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => (filenameFilter ? filenameFilter.test(f) : true))
    .map((f) => path.join(dir, f));
}

function scanFile(filePath, callRe, allowedNames, offenses, ruleLabel) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    let match;
    callRe.lastIndex = 0;
    while ((match = callRe.exec(lines[i])) !== null) {
      const fnName = match[1];
      if (!allowedNames.has(fnName)) {
        offenses.push({ file: path.relative(REPO_ROOT, filePath), line: i + 1, fnName, rule: ruleLabel });
      }
    }
  }
}

const { manifestNames, exemptNames, exemptionErrors } = readManifest();

if (exemptionErrors.length > 0) {
  console.error('RT-12 required-queries scan: required-queries.json exemptions are malformed:');
  for (const e of exemptionErrors) console.error(`  - ${e}`);
  process.exit(1);
}

const offenses = [];

// Rule 1: convention scan, manifest only (no exemptions -- a list_overlay_*
// name is definitionally a widget/overlay snapshot read by this codebase's
// own established convention, so there is nothing to exempt it for; if one
// ever needs an exemption, that is itself worth a second look).
for (const dir of RULE1_SCAN_DIRS) {
  for (const file of listSourceFiles(dir, null)) {
    scanFile(file, RULE1_CALL_RE, manifestNames, offenses, 'rule1-convention');
  }
}

// Rule 2: convention-independent scan of dedicated overlay-facing store
// files, manifest OR exemption.
const rule2Allowed = new Set([...manifestNames, ...exemptNames]);
for (const file of listSourceFiles(DB_DIR, OVERLAY_FACING_FILENAME_RE)) {
  scanFile(file, RULE2_CALL_RE, rule2Allowed, offenses, 'rule2-overlay-store');
}

// De-duplicate: the same call site can be found by both rules (a
// list_overlay_* call inside a dedicated overlay store file). Report it
// once.
const seen = new Set();
const uniqueOffenses = offenses.filter((o) => {
  const key = `${o.file}:${o.line}:${o.fnName}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

if (uniqueOffenses.length > 0) {
  console.error(`RT-12 required-queries scan: ${uniqueOffenses.length} overlay-facing app_private call(s) missing from packages/db/explain-plans/required-queries.json:`);
  for (const offense of uniqueOffenses) {
    console.error(`  - app_private.${offense.fnName} called at ${offense.file}:${offense.line} has no manifest entry (${offense.rule}) -- add it to required-queries.json's "queries" array with a captured EXPLAIN artefact, or to its "exemptions" array with a written reason, before this can pass`);
  }
  process.exit(1);
}

console.log(`OK: every app_private call found by the convention scan and the overlay-store-file scan is present in required-queries.json (${manifestNames.size} manifest entries, ${exemptNames.size} exemptions)`);
process.exit(0);
