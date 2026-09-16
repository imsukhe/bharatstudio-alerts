#!/usr/bin/env node
// PRF-03 / PRF-04 static discipline check over apps/web/app/overlay/canvas.
//
// What §19.4/§19.5 actually require here is NOT measurable in this repo:
// "no frame over 16ms" and "<150MB steady over 8 hours" need a real
// browser/OBS/device run (RT-07, Blocked) — the web test suite is JSDOM,
// and headless Chromium is a trend signal only (§37.4). A pass/fail frame
// or memory gate built here would recreate RT-06's original defect
// (a budget with no real measurement behind it), for frames instead of
// API latency.
//
// What IS honest and buildable now, per the scope review's decision:
// CODE-LEVEL DISCIPLINE, not a measurement claim.
//
//   PRF-03 — every module's render()/tick() path (the function the
//   Master Canvas rAF loop calls every frame, per
//   CanvasModuleDefinition.render in master-canvas-runtime.ts) may only
//   write the two composite-only CSS properties §19.5 permits:
//   `opacity` and `transform`. Any other CSS property written inside that
//   scope is a layout-triggering write in the one place it is most
//   expensive — every frame, for every active module. This needs no
//   number; §19.4/§19.5 name the permitted properties exactly.
//
//   PRF-04 — a per-module DOM-node ceiling. NO AUTHORITY STATES THIS
//   NUMBER. It is read from an environment variable this workflow never
//   sets (CI_PRF04_MODULE_NODE_CEILING); unset is the default, and this
//   check reports the count for visibility and never fails on it while
//   unset. See the REFERRED section of this task's records — this is an
//   owner decision still pending, not a value this script may invent.
//   The count itself is a STATIC PROXY (distinct `createElement` call
//   sites in the module's source), never a runtime node count — a ticker
//   module that recycles rows at runtime is invisible to a static count
//   by construction, and this script says so rather than implying
//   otherwise.
//
// This script proves code-shape discipline. It proves nothing about an
// actual rendered frame, an actual GC pause, or actual memory over an
// actual 8-hour stream — that is RT-07, and RT-07 is Blocked.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CANVAS_DIR = join(REPO_ROOT, 'apps/web/app/overlay/canvas');

const ALLOWED_RENDER_PATH_CSS_PROPS = new Set(['opacity', 'transform']);
// Lifecycle methods the rAF loop / module contract actually calls every
// frame or on every state change (CanvasModuleDefinition in
// master-canvas-runtime.ts: activate/deactivate/render). Only `render` is
// per-frame; `activate`/`deactivate` run once per module lifecycle and are
// intentionally NOT scanned — one-time setup styles (position, height,
// transformOrigin, transition, fontFamily, …) are declared there and are
// not the animation this rule is about (§19.5: "declaring [a layout
// property] is not animating it").
const PER_FRAME_METHOD_NAMES = new Set(['render']);

function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

// camelCase style property -> kebab-case CSS property name.
function toKebab(prop) {
  return prop.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// Finds every top-level (non-nested-function) occurrence of a method
// literally named one of PER_FRAME_METHOD_NAMES inside an object literal
// — e.g. `render() {` or `render(timestampMs) {` — and returns [start,
// end) line ranges (1-indexed, inclusive of the opening line) covering
// each such method body, tracked by brace depth from the opening `{` on
// the declaration line to its matching close. An interface signature
// (`render(timestampMs: number): void;`) has no `{` and is correctly
// never entered.
function findPerFrameMethodRanges(lines) {
  const ranges = [];
  const declPattern = /^\s*(render)\s*\([^)]*\)\s*(:\s*[\w<>[\]., ]+)?\s*\{/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(declPattern);
    if (!match) continue;
    if (!PER_FRAME_METHOD_NAMES.has(match[1])) continue;
    let depth = 0;
    let seenOpen = false;
    let end = i;
    for (let j = i; j < lines.length; j += 1) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth += 1; seenOpen = true; }
        else if (ch === '}') { depth -= 1; }
      }
      if (seenOpen && depth <= 0) { end = j; break; }
      end = j;
    }
    ranges.push([i, end]);
  }
  return ranges;
}

function withinRanges(lineIndex, ranges) {
  return ranges.some(([start, end]) => lineIndex >= start && lineIndex <= end);
}

function checkFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const relPath = relative(REPO_ROOT, filePath);
  const perFrameRanges = findPerFrameMethodRanges(lines);

  const violations = [];
  const stylePropPattern = /\.style\.(\w+)\s*=/g;
  const styleBracketPattern = /\.style\[\s*['"]([\w-]+)['"]\s*\]\s*=/g;
  const setPropertyPattern = /\.style\.setProperty\(\s*['"]([\w-]+)['"]/g;

  lines.forEach((line, idx) => {
    if (!withinRanges(idx, perFrameRanges)) return;
    for (const pattern of [stylePropPattern, styleBracketPattern, setPropertyPattern]) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(line))) {
        const prop = toKebab(m[1]);
        if (!ALLOWED_RENDER_PATH_CSS_PROPS.has(prop) && prop !== 'opacity' && prop !== 'transform') {
          violations.push({ file: relPath, line: idx + 1, prop, text: line.trim() });
        }
      }
    }
  });

  const nodeSiteCount = (text.match(/\.createElement\(/g) ?? []).length;

  return { file: relPath, violations, nodeSiteCount, perFrameMethodCount: perFrameRanges.length };
}

const files = listSourceFiles(CANVAS_DIR);
if (files.length === 0) {
  console.error(`No source files found under ${relative(REPO_ROOT, CANVAS_DIR)} — the canvas module directory may have moved. Failing rather than reporting a silent, meaningless pass.`);
  process.exit(1);
}

console.log(`Scanning ${files.length} canvas source file(s) under ${relative(REPO_ROOT, CANVAS_DIR)}`);
console.log('---');

let totalViolations = 0;
const results = files.map(checkFile).sort((a, b) => a.file.localeCompare(b.file));

for (const result of results) {
  const frameNote = result.perFrameMethodCount > 0 ? `${result.perFrameMethodCount} per-frame render() scope(s) scanned` : 'no per-frame render() method found (nothing scanned — module may not implement the live contract)';
  console.log(`${result.file}: ${frameNote}; ${result.nodeSiteCount} static createElement() call site(s)`);
  for (const v of result.violations) {
    totalViolations += 1;
    console.error(`  FAIL PRF-03 ${v.file}:${v.line} — render()-path writes CSS property "${v.prop}" (only opacity/transform permitted): ${v.text}`);
  }
}

console.log('---');
console.log('PRF-04 — per-module DOM-node ceiling (static createElement() call-site proxy, wired but inert):');
const ceilingRaw = process.env.CI_PRF04_MODULE_NODE_CEILING;
if (ceilingRaw === undefined) {
  console.log('  CI_PRF04_MODULE_NODE_CEILING is unset (the default, and the only value this workflow ever sets). No authority states a number for this — see the OPS-CI-01 task record\'s REFERRED section. This check reports counts for visibility only and never fails on them while unset.');
  for (const result of results) console.log(`    ${result.file}: ${result.nodeSiteCount} static call site(s)`);
} else {
  const ceiling = Number(ceilingRaw);
  console.log(`  CI_PRF04_MODULE_NODE_CEILING=${ceilingRaw}. Comparing static call-site counts (a PROXY, not a runtime node count — a recycling ticker module is invisible to this by construction).`);
  for (const result of results) {
    if (Number.isFinite(ceiling) && result.nodeSiteCount > ceiling) {
      totalViolations += 1;
      console.error(`  FAIL PRF-04 ${result.file}: ${result.nodeSiteCount} static createElement() call sites > ceiling ${ceiling}`);
    } else {
      console.log(`    OK ${result.file}: ${result.nodeSiteCount} <= ${ceiling}`);
    }
  }
}

console.log('---');
console.log('honesty: this is a static, code-level discipline check over source text. It is not a measured frame time, not a measured memory curve, and not a measured runtime DOM node count. RT-07 (real browser/OBS/device evidence): Blocked. externalEvidence: not-claimed.');

if (totalViolations > 0) {
  console.error(`\n${totalViolations} violation(s) found.`);
  process.exit(1);
}
console.log('\nPRF-03/PRF-04 canvas static check: all checks passed against current code.');
