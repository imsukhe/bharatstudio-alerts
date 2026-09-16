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
//   RULE 3 -- COMPOSITION-ROOT SCAN, new in the 2026-09-16 blind-spot
//   closure. Rules 1 and 2 are both NAMING rules: rule 1 keys on the
//   function name (`list_overlay_*`), rule 2 on the file name
//   (`overlay` / `master-canvas`). A store file matching NEITHER, adding
//   an overlay-facing read under any other name, was invisible to both --
//   a green check blind to exactly what it was never told about, which is
//   the defect RT-12 exists to prevent. Rule 3 replaces the naming
//   question with a STRUCTURAL one the composition root already enforces
//   for its own reasons: RT-10/RT-11 (§19.0, §31.18.0) require every
//   widget/dashboard/analytics read to run on the bounded, statement-
//   timeout-bearing derived-read pool, and the ONLY handle to that pool
//   is `derivedReadSql`, created once in apps/api/src/index.ts
//   (db/derived-read-pool.ts). So: every store factory that
//   apps/api/src/index.ts constructs with `derivedReadSql`, and every
//   route registrar that apps/api/src/app.ts passes
//   `dependencies.derivedReadSql` to, is by construction a derived-read
//   surface -- and EVERY `app_private.<fn>(` call inside that factory's
//   or registrar's own body must be in the manifest or the exemption set.
//
//   Rule 3 does not read a single name. It starts at the two composition
//   -root files, finds each call whose argument list contains the
//   `derivedReadSql` token, resolves the callee through THAT FILE'S OWN
//   `import { … } from './…'` statements to a source file, brace-matches
//   the named export's body in that file, and scans only that body. A
//   rename therefore cannot defeat it: renaming the file rewrites the
//   import specifier rule 3 follows; renaming the factory rewrites both
//   the call site and the export rule 3 matches; moving it to a new
//   directory rewrites the specifier too. The only way out is to stop
//   passing `derivedReadSql` -- which means the read no longer runs on
//   RT-10's isolated pool or under RT-11's statement timeout, a visible
//   regression of two other accepted rows, not a quiet rename.
//
//   Body-scoped, not file-scoped, deliberately: interaction-sql-store.ts
//   and vote-payment-sql-store.ts are mixed-purpose modules that export a
//   derived-read overlay store alongside a dozen creator-facing writes
//   (create_interaction_definition, start_hype_mode, tag_vote_payment …)
//   that are not derived reads at all. Scoping to the exported
//   declaration the composition root actually wires keeps rule 3 exact
//   instead of sweeping in unrelated call sites that would then need
//   pro-forma exemptions -- and pro-forma exemptions are how an exemption
//   list stops being read. Every resolution step fails LOUD: an
//   unresolvable import, a missing export, or unbalanced braces exits
//   non-zero rather than scanning nothing and printing OK.
//
// WHAT THIS DOES NOT CATCH (stated here because a scan that does not say
// what it misses is worse than no scan -- see this task's own record):
//   - CLOSED as of 2026-09-16 by rule 3, and recorded here rather than
//     deleted so the history of what this scan could not see stays
//     readable: a genuinely overlay-facing function in a file whose name
//     matched neither "overlay" nor "master-canvas" and that also did not
//     follow the list_overlay_* convention used to be caught by NEITHER
//     rule 1 nor rule 2. A store file named, say, `alert-stream-store.ts`
//     slipped past both. Rule 3 catches it the moment it is wired to
//     `derivedReadSql` in index.ts, whatever it or its file is called.
//   - REMAINING, honestly: a derived read wired to the MAIN `sql` pool
//     instead of `derivedReadSql`, in a file matching neither naming
//     rule, is still invisible to all three rules. That is not a silent
//     hole in the same sense -- such a read is already a live RT-10/RT-11
//     violation (unbounded pool, no statement_timeout) that those rows'
//     own review catches -- but this scan does not detect it, and saying
//     so is the point of this list.
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

// Rule 3 starts at the two composition-root files and follows their own
// imports -- no path list, no naming rule. See the header block above.
const INDEX_TS = path.join(REPO_ROOT, 'apps', 'api', 'src', 'index.ts');
const APP_TS = path.join(REPO_ROOT, 'apps', 'api', 'src', 'app.ts');
const DERIVED_READ_TOKEN_RE = /\bderivedReadSql\b/g;
const NAMED_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g;

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

/** local-name -> { file, exportedName } for every relative named import in `text`. */
function parseNamedImports(text, fromFile) {
  const map = new Map();
  NAMED_IMPORT_RE.lastIndex = 0;
  let match;
  while ((match = NAMED_IMPORT_RE.exec(text)) !== null) {
    const specifier = match[2];
    if (!specifier.startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(fromFile), specifier.replace(/\.js$/, '.ts'));
    for (const clause of match[1].split(',')) {
      const cleaned = clause.trim().replace(/^type\s+/, '');
      if (cleaned.length === 0) continue;
      const parts = cleaned.split(/\s+as\s+/);
      const exportedName = parts[0].trim();
      const localName = (parts[1] ?? parts[0]).trim();
      if (exportedName.length > 0 && localName.length > 0) map.set(localName, { file: resolved, exportedName });
    }
  }
  return map;
}

/**
 * Identifier of the call whose argument list the token at `tokenIndex` sits
 * directly inside, found by walking backwards. Returns null when the token is
 * not a direct call argument -- a declaration (`const derivedReadSql = ...`), a
 * type field (`derivedReadSql?: Sql;`) or a bare shorthand property inside an
 * object literal (`{ ..., derivedReadSql, ... }`) -- so none of those is
 * mistaken for a wiring.
 */
function enclosingCallee(text, tokenIndex) {
  let parens = 0;
  let braces = 0;
  for (let i = tokenIndex - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === ')') parens += 1;
    else if (ch === '(') {
      if (parens > 0) { parens -= 1; continue; }
      let end = i;
      while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
      let start = end;
      while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1])) start -= 1;
      const name = text.slice(start, end);
      return name.length > 0 ? name : null;
    } else if (ch === '}') braces += 1;
    else if (ch === '{') {
      if (braces === 0) return null;
      braces -= 1;
    } else if (ch === ';' && parens === 0 && braces === 0) return null;
  }
  return null;
}

/**
 * Brace-matched body of `export [async] function NAME(...) { ... }` or
 * `export const NAME = (...) => { ... }` in `filePath`. The parameter list is
 * paren-matched first so an inline object-type parameter is never mistaken for
 * the body. THROWS on every failure -- a rule whose resolution can fail
 * silently is the defect this whole file exists to prevent.
 */
function exportedDeclarationBody(filePath, exportedName) {
  const rel = path.relative(REPO_ROOT, filePath);
  if (!fs.existsSync(filePath)) throw new Error(`${rel} does not exist, so "${exportedName}" cannot be scanned`);
  const text = fs.readFileSync(filePath, 'utf8');
  const decl = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${exportedName}\\b`);
  const found = decl.exec(text);
  if (!found) throw new Error(`no "export ... ${exportedName}" declaration found in ${rel}`);
  let cursor = found.index + found[0].length;
  const parenIdx = text.indexOf('(', cursor);
  const firstBrace = text.indexOf('{', cursor);
  if (parenIdx !== -1 && (firstBrace === -1 || parenIdx < firstBrace)) {
    let parenDepth = 0;
    let i = parenIdx;
    for (; i < text.length; i += 1) {
      if (text[i] === '(') parenDepth += 1;
      else if (text[i] === ')') { parenDepth -= 1; if (parenDepth === 0) break; }
    }
    if (parenDepth !== 0) throw new Error(`unbalanced parameter list for ${exportedName} in ${rel}`);
    cursor = i + 1;
  }
  const open = text.indexOf('{', cursor);
  if (open === -1) throw new Error(`no body found for ${exportedName} in ${rel}`);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return { body: text.slice(open, i + 1), baseLine: text.slice(0, open).split('\n').length };
      }
    }
  }
  throw new Error(`unbalanced braces while reading ${exportedName} in ${rel}`);
}

function scanSnippet(relPath, snippet, baseLine, callRe, allowedNames, offenses, ruleLabel) {
  const lines = snippet.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    let match;
    callRe.lastIndex = 0;
    while ((match = callRe.exec(lines[i])) !== null) {
      const fnName = match[1];
      if (!allowedNames.has(fnName)) {
        offenses.push({ file: relPath, line: baseLine + i, fnName, rule: ruleLabel });
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

// Rule 3: composition-root derived-read scan. Follows index.ts's and
// app.ts's own `derivedReadSql` wiring and their own import statements to
// the exported declaration each one constructs, and scans that
// declaration's body. No function name and no file name is consulted
// anywhere in this rule.
const rule3Errors = [];
const rule3Wirings = [];
for (const rootFile of [INDEX_TS, APP_TS]) {
  const rootRel = path.relative(REPO_ROOT, rootFile);
  if (!fs.existsSync(rootFile)) {
    rule3Errors.push(`composition root ${rootRel} not found -- rule 3 cannot run, and a rule that cannot run must not report OK`);
    continue;
  }
  const rootText = fs.readFileSync(rootFile, 'utf8');
  const imports = parseNamedImports(rootText, rootFile);
  const callees = new Set();
  DERIVED_READ_TOKEN_RE.lastIndex = 0;
  let tokenMatch;
  while ((tokenMatch = DERIVED_READ_TOKEN_RE.exec(rootText)) !== null) {
    const callee = enclosingCallee(rootText, tokenMatch.index);
    if (callee) callees.add(callee);
  }
  for (const callee of [...callees].sort()) {
    const target = imports.get(callee);
    if (!target) {
      rule3Errors.push(`${rootRel} passes derivedReadSql to ${callee}(), which is not a relative named import of ${rootRel} -- rule 3 cannot resolve its source file, so it cannot be scanned`);
      continue;
    }
    rule3Wirings.push({ rootRel, callee, ...target });
  }
}

if (rule3Wirings.length === 0 && rule3Errors.length === 0) {
  rule3Errors.push('rule 3 found no derivedReadSql wiring at all in apps/api/src/index.ts or apps/api/src/app.ts -- either the RT-10/RT-11 derived-read pool was removed or this rule has stopped matching the composition root. Either way it is no longer checking anything, which must fail rather than print OK.');
}

for (const wiring of rule3Wirings) {
  try {
    const { body, baseLine } = exportedDeclarationBody(wiring.file, wiring.exportedName);
    scanSnippet(path.relative(REPO_ROOT, wiring.file), body, baseLine, RULE2_CALL_RE, rule2Allowed, offenses, `rule3-composition-root(${wiring.rootRel} -> ${wiring.callee})`);
  } catch (error) {
    rule3Errors.push(`${wiring.rootRel} wires derivedReadSql into ${wiring.callee}(): ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (rule3Errors.length > 0) {
  console.error('RT-12 required-queries scan: rule 3 (composition-root derived-read scan) could not complete:');
  for (const e of rule3Errors) console.error(`  - ${e}`);
  process.exit(1);
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

console.log(`OK: every app_private call found by rule 1 (convention scan), rule 2 (overlay-store-file scan) and rule 3 (composition-root derived-read scan, ${rule3Wirings.length} wired declaration(s) resolved and scanned) is present in required-queries.json (${manifestNames.size} manifest entries, ${exemptNames.size} exemptions)`);
process.exit(0);
