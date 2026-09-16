#!/usr/bin/env node
// Guard against the API test harness validating under different rules than
// the API. See
// bharatstudio-requirements/reviews/2026-09-16-api-test-harness-validation-divergence.md.
//
// THE DEFECT THIS EXISTS TO PREVENT RECURRING
//
// `apps/api/src/app.ts` configures Fastify's AJV with
// `removeAdditional: false`. Fastify's own default is `removeAdditional: true`.
// Under `additionalProperties: false` — the shape nearly every body schema in
// this API uses — those two disagree on the single most common validation
// case there is:
//
//   bare `Fastify()`  : an undeclared body field is silently STRIPPED, 200
//   this application  : an undeclared body field is REJECTED, 400
//
// A route test built on a bare `Fastify()` therefore does not weakly prove the
// right thing; it confidently proves the wrong thing, and keeps doing so as
// the route changes underneath it. Twenty-nine files and fifty-four call sites
// were in that state before the 2026-09-16 sweep.
//
// WHAT THIS SCRIPT CHECKS (all static, over source text)
//
//   1. STRUCTURE — there is exactly ONE definition of the AJV options,
//      `apps/api/src/fastify-ajv-options.ts`, and both `src/app.ts` and
//      `test/create-test-fastify.ts` IMPORT it. A helper that copies the
//      options instead of importing them is the same defect with a longer
//      fuse, so a second occurrence of `removeAdditional` anywhere under
//      `apps/api/` fails here.
//   2. THE SWEEP HOLDS — no file under `apps/api/test/` may reach the Fastify
//      factory itself. Concretely: no default/namespace import of `fastify`,
//      no named `fastify`/`default` specifier, no `import('fastify')`, no
//      `require('fastify')`, and no `Fastify(`-shaped construction in code.
//      Type-only and other named imports (`FastifyInstance`, `FastifyReply`,
//      …) are untouched — they cannot build a server.
//   3. NOT VACUOUS — the helper is actually in use, and the test directory
//      actually exists and contains tests. A check that passes because it
//      found nothing to check is not a passing check.
//
// WHAT THIS DOES NOT PROVE
//
// This is a static source-text check, exactly like
// .github/scripts/canvas-static-check.mjs. It proves that the harness is
// constructed through one shared configuration. It is not a measurement of
// any deployed instance, proves nothing about what a production server has
// actually accepted or rejected, and is not release, provider or deployment
// evidence. Local code discipline only.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const API_DIR = join(REPO_ROOT, 'apps/api');
const TEST_DIR = join(API_DIR, 'test');
const OPTIONS_MODULE = join(API_DIR, 'src/fastify-ajv-options.ts');
const APP_MODULE = join(API_DIR, 'src/app.ts');
const HELPER_MODULE = join(TEST_DIR, 'create-test-fastify.ts');

const OPTIONS_EXPORT = 'fastifyAjvOptions';
const HELPER_EXPORT = 'createTestFastify';

const failures = [];
const fail = (message) => failures.push(message);

function listTypeScriptFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTypeScriptFiles(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out.sort();
}

const rel = (p) => relative(REPO_ROOT, p);

// Removes comments and string/template bodies so a violation cannot be
// matched inside prose or a URL, and prose cannot be mistaken for a
// violation. Regex literals are not modelled; none in this tree contains a
// construction call, and the import checks below run on RAW text precisely so
// that this simplification can never hide a violation on its own.
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. STRUCTURE: one definition, two importers.
// ---------------------------------------------------------------------------

if (!existsSync(OPTIONS_MODULE)) {
  fail(`${rel(OPTIONS_MODULE)} is missing. It is the single definition of this API's AJV options; without it the app and the test harness have nothing to share.`);
} else {
  const optionsSource = readFileSync(OPTIONS_MODULE, 'utf8');
  if (!new RegExp(`export\\s+(?:function|const)\\s+${OPTIONS_EXPORT}\\b`).test(optionsSource)) {
    fail(`${rel(OPTIONS_MODULE)} no longer exports \`${OPTIONS_EXPORT}\`.`);
  }
  if (!/removeAdditional/.test(optionsSource)) {
    fail(`${rel(OPTIONS_MODULE)} no longer mentions \`removeAdditional\`. That option is the whole reason this module exists — if it moved, move this check with it.`);
  }
}

for (const file of [APP_MODULE, HELPER_MODULE]) {
  if (!existsSync(file)) {
    fail(`${rel(file)} is missing — it must import \`${OPTIONS_EXPORT}\` from ${rel(OPTIONS_MODULE)}.`);
    continue;
  }
  const source = readFileSync(file, 'utf8');
  if (!new RegExp(`import\\s*\\{[^}]*\\b${OPTIONS_EXPORT}\\b[^}]*\\}\\s*from\\s*['"][^'"]*fastify-ajv-options\\.js['"]`).test(source)) {
    fail(`${rel(file)} does not import \`${OPTIONS_EXPORT}\` from ${rel(OPTIONS_MODULE)}. Copying the options instead of importing them is the defect this guard exists to prevent.`);
  }
  if (!new RegExp(`${OPTIONS_EXPORT}\\s*\\(`).test(stripCommentsAndStrings(source))) {
    fail(`${rel(file)} imports \`${OPTIONS_EXPORT}\` but never calls it.`);
  }
}

// A second occurrence of the option name anywhere under apps/api/ is a copy.
const apiSources = [
  ...listTypeScriptFiles(join(API_DIR, 'src')),
  ...(existsSync(TEST_DIR) ? listTypeScriptFiles(TEST_DIR) : []),
];
for (const file of apiSources) {
  if (file === OPTIONS_MODULE) continue;
  if (/removeAdditional/.test(stripCommentsAndStrings(readFileSync(file, 'utf8')))) {
    fail(`${rel(file)} restates \`removeAdditional\`. There must be exactly one definition — ${rel(OPTIONS_MODULE)} — and every other site must import it.`);
  }
}

// ---------------------------------------------------------------------------
// 2. THE SWEEP HOLDS: no test file may reach the Fastify factory.
// ---------------------------------------------------------------------------

if (!existsSync(TEST_DIR)) {
  fail(`${rel(TEST_DIR)} does not exist. Failing rather than reporting a silent, meaningless pass.`);
}

const testFiles = existsSync(TEST_DIR) ? listTypeScriptFiles(TEST_DIR) : [];
const scanned = testFiles.filter((f) => f !== HELPER_MODULE);

if (testFiles.length === 0) {
  fail(`No TypeScript files found under ${rel(TEST_DIR)}. The API test directory may have moved; failing rather than passing vacuously.`);
}

// Matches an import statement whose module specifier is exactly 'fastify'.
const FASTIFY_IMPORT = /import\s+((?:type\s+)?(?:\*\s+as\s+[\w$]+|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?))\s*from\s*['"]fastify['"]/g;
const DYNAMIC_FASTIFY = /(?:\bimport\s*\(|\brequire\s*\()\s*['"]fastify['"]\s*\)/;

let helperUsers = 0;

for (const file of scanned) {
  const raw = readFileSync(file, 'utf8');
  const code = stripCommentsAndStrings(raw);
  const lineOf = (index) => raw.slice(0, index).split('\n').length;

  if (new RegExp(`\\b${HELPER_EXPORT}\\b`).test(code)) helperUsers += 1;

  FASTIFY_IMPORT.lastIndex = 0;
  let match;
  while ((match = FASTIFY_IMPORT.exec(raw)) !== null) {
    const clause = match[1].trim();
    const line = lineOf(match.index);
    if (/^type\b/.test(clause)) continue; // `import type { … } from 'fastify'`
    if (/^\*\s+as\b/.test(clause)) {
      fail(`${rel(file)}:${line} — namespace import of 'fastify'. It exposes the server factory; use \`${HELPER_EXPORT}\` from ./create-test-fastify.js instead.`);
      continue;
    }
    if (!clause.startsWith('{')) {
      fail(`${rel(file)}:${line} — default import of 'fastify' (the server factory). A bare \`Fastify()\` validates with AJV's \`removeAdditional: true\` default, silently stripping body fields this API rejects with 400. Use \`${HELPER_EXPORT}\` from ./create-test-fastify.js.`);
      continue;
    }
    const specifiers = clause.replace(/^\{|\}$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const specifier of specifiers) {
      const name = specifier.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name === 'fastify' || name === 'default') {
        fail(`${rel(file)}:${line} — named import \`${name}\` from 'fastify' is the server factory under another name. Use \`${HELPER_EXPORT}\` from ./create-test-fastify.js.`);
      }
    }
  }

  const dynamic = DYNAMIC_FASTIFY.exec(raw);
  if (dynamic) {
    fail(`${rel(file)}:${lineOf(dynamic.index)} — dynamic import/require of 'fastify'. Use \`${HELPER_EXPORT}\` from ./create-test-fastify.js.`);
  }

  // Belt and braces: any `Fastify(`/`fastify(` construction in real code,
  // however the binding was obtained.
  const construction = /(?<![.\w$])[Ff]astify\s*\(/.exec(code);
  if (construction) {
    fail(`${rel(file)}:${lineOf(construction.index)} — constructs a Fastify instance directly. Every Fastify instance under ${rel(TEST_DIR)} must come from \`${HELPER_EXPORT}\` (test/create-test-fastify.ts), which imports the app's own AJV options.`);
  }
}

// ---------------------------------------------------------------------------
// 3. NOT VACUOUS.
// ---------------------------------------------------------------------------

if (helperUsers === 0) {
  fail(`No file under ${rel(TEST_DIR)} imports or calls \`${HELPER_EXPORT}\`. Either the helper was renamed or the suite stopped building Fastify instances; either way this check would be passing without checking anything.`);
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

console.log(`Scanning ${scanned.length} test file(s) under ${rel(TEST_DIR)} (excluding the helper itself)`);
console.log(`Single AJV definition: ${rel(OPTIONS_MODULE)}`);
console.log(`Importers: ${rel(APP_MODULE)}, ${rel(HELPER_MODULE)}`);
console.log(`Test files referencing ${HELPER_EXPORT}: ${helperUsers}`);
console.log('---');

if (failures.length > 0) {
  for (const message of failures) console.error(`  FAIL ${message}`);
  console.error(`\n${failures.length} violation(s) found. See bharatstudio-requirements/reviews/2026-09-16-api-test-harness-validation-divergence.md.`);
  process.exit(1);
}

console.log('honesty: static source-text check over apps/api only. It proves the harness and the app share one AJV configuration in this checkout. It is not a measurement of any deployed instance and is not release, provider or deployment evidence.');
console.log('\nAPI test harness check: all checks passed against current code.');
