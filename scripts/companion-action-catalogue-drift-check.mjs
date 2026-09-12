#!/usr/bin/env node
// Compares the L24 Companion action catalogue (17 actions, 4 groups) across
// its five hand-maintained mirrors:
//   1. packages/db/migrations/0089_v1_l24_companion_action_catalogue.sql
//      (companion_commands_v1_action_check CHECK constraint +
//      app_private.companion_action_group() SQL function)
//   2. apps/api/src/routes/companion.ts (ACTION_GROUPS)
//   3. ../bharatstudio-companion-desktop/macos/Sources/BharatStudioCompanionMacOS/CompanionPolicy.swift
//      (CompanionControlAction enum raw values + its `group` switch)
//   4. ../bharatstudio-companion-desktop/windows/CompanionPolicy.cs
//      (CompanionControlAction enum + CompanionControlActionGrouping.Group switch)
//   5. ../bharatstudio-companion-mobile/src/api/CompanionApi.ts
//      (CompanionAction union + actionGroups record)
//
// Each source is parsed independently with source-specific regexes (no
// shared AST), producing a Map<action, group>. The five maps are then
// compared: same action set, same group per action. Any missing action,
// extra action, or group disagreement is a real drift and exits non-zero.
// A missing sibling repo degrades to a clear skip message, not a crash.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const workspaceRoot = path.resolve(repoRoot, '..');

const GROUPS = ['alerts', 'obs', 'mirror', 'stream'];

function fail(message) {
  throw new Error(message);
}

function stripSqlComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function pascalToSnake(identifier) {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/^_/, '')
    .toLowerCase();
}

// ---- 1. SQL migration -----------------------------------------------------

function parseSql(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const text = stripSqlComments(raw);

  const checkMatch = text.match(/companion_commands_v1_action_check\s*\n\s*check\s*\(action in \(([\s\S]*?)\)\)\s*not valid/);
  if (!checkMatch) fail(`${filePath}: could not locate companion_commands_v1_action_check CHECK body`);
  const checkActions = new Set([...checkMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

  const fnMatch = text.match(/companion_action_group\(target_action text\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/);
  if (!fnMatch) fail(`${filePath}: could not locate app_private.companion_action_group() body`);
  const fnBody = fnMatch[1];
  const groups = new Map();
  for (const arm of fnBody.matchAll(/when target_action in \(([^)]+)\) then '([a-z]+)'/g)) {
    const group = arm[2];
    if (!GROUPS.includes(group)) fail(`${filePath}: unknown group '${group}' in companion_action_group()`);
    for (const actionMatch of arm[1].matchAll(/'([a-z_]+)'/g)) {
      groups.set(actionMatch[1], group);
    }
  }

  // Cross-check within this single source: the CHECK constraint and the
  // group function must already agree before comparing across files.
  const checkOnly = [...checkActions].filter((a) => !groups.has(a));
  const fnOnly = [...groups.keys()].filter((a) => !checkActions.has(a));
  if (checkOnly.length || fnOnly.length) {
    fail(`${filePath}: CHECK constraint and companion_action_group() disagree on action set (CHECK-only: [${checkOnly}], function-only: [${fnOnly}])`);
  }

  return groups;
}

// ---- 2. apps/api/src/routes/companion.ts ----------------------------------

function parseCompanionRoute(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const block = text.match(/const ACTION_GROUPS: Record<string, CompanionActionGroup> = \{([\s\S]*?)\};/);
  if (!block) fail(`${filePath}: could not locate ACTION_GROUPS`);
  const groups = new Map();
  for (const line of block[1].matchAll(/(\w+):\s*'([a-z]+)',/g)) {
    const [, action, group] = line;
    if (!GROUPS.includes(group)) fail(`${filePath}: unknown group '${group}' for action '${action}'`);
    groups.set(action, group);
  }
  if (groups.size === 0) fail(`${filePath}: ACTION_GROUPS parsed empty`);
  return groups;
}

// ---- 3. macOS CompanionPolicy.swift ----------------------------------------

function parseSwift(filePath) {
  const text = readFileSync(filePath, 'utf8');

  const rawValues = new Map(); // identifier -> action string
  for (const m of text.matchAll(/case (\w+) = "([a-z_]+)"/g)) {
    rawValues.set(m[1], m[2]);
  }
  if (rawValues.size === 0) fail(`${filePath}: no enum raw values found`);

  const switchMatch = text.match(/public var group: Group \{\s*switch self \{([\s\S]*?)\n\s*\}\s*\n\s*\}/);
  if (!switchMatch) fail(`${filePath}: could not locate 'group' switch body`);
  const flattened = switchMatch[1].replace(/\n/g, ' ');

  const groups = new Map();
  for (const arm of flattened.matchAll(/case\s+((?:\.\w+\s*,?\s*)+):\s*return\s*\.(\w+)/g)) {
    const group = arm[2];
    if (!GROUPS.includes(group)) fail(`${filePath}: unknown group '${group}'`);
    for (const idMatch of arm[1].matchAll(/\.(\w+)/g)) {
      const identifier = idMatch[1];
      const action = rawValues.get(identifier);
      if (!action) fail(`${filePath}: 'group' switch references undeclared case .${identifier}`);
      groups.set(action, group);
    }
  }

  const rawOnly = [...rawValues.values()].filter((a) => !groups.has(a));
  if (rawOnly.length) fail(`${filePath}: enum cases with no 'group' switch arm: [${rawOnly}]`);

  return groups;
}

// ---- 4. Windows CompanionPolicy.cs -----------------------------------------

function parseCSharp(filePath) {
  const text = readFileSync(filePath, 'utf8');

  const enumMatch = text.match(/public enum CompanionControlAction\s*\{([\s\S]*?)\n\}/);
  if (!enumMatch) fail(`${filePath}: could not locate CompanionControlAction enum`);
  const members = [...enumMatch[1].matchAll(/^\s*(\w+),?\s*$/gm)]
    .map((m) => m[1])
    .filter((identifier) => identifier && !identifier.startsWith('//'));
  if (members.length === 0) fail(`${filePath}: CompanionControlAction enum parsed empty`);
  const actionsByIdentifier = new Map(members.map((identifier) => [identifier, pascalToSnake(identifier)]));

  const switchMatch = text.match(/public static CompanionActionGroup Group\(this CompanionControlAction action\) => action switch\s*\{([\s\S]*?)\n\s*\};/);
  if (!switchMatch) fail(`${filePath}: could not locate CompanionControlActionGrouping.Group switch`);
  const flattened = switchMatch[1].replace(/\n/g, ' ');

  const groups = new Map();
  for (const arm of flattened.matchAll(/((?:CompanionControlAction\.\w+\s*(?:or)?\s*)+)=>\s*CompanionActionGroup\.(\w+),/g)) {
    const group = arm[2].toLowerCase();
    if (!GROUPS.includes(group)) fail(`${filePath}: unknown group '${arm[2]}'`);
    for (const idMatch of arm[1].matchAll(/CompanionControlAction\.(\w+)/g)) {
      const identifier = idMatch[1];
      const action = actionsByIdentifier.get(identifier);
      if (!action) fail(`${filePath}: Group() switch references undeclared member ${identifier}`);
      groups.set(action, group);
    }
  }

  const memberOnly = [...actionsByIdentifier.values()].filter((a) => !groups.has(a));
  if (memberOnly.length) fail(`${filePath}: enum members with no Group() arm: [${memberOnly}]`);

  return groups;
}

// ---- 5. bharatstudio-companion-mobile CompanionApi.ts ----------------------

function parseMobileApi(filePath) {
  const text = readFileSync(filePath, 'utf8');

  const unionMatch = text.match(/export type CompanionAction =\s*([\s\S]*?);/);
  if (!unionMatch) fail(`${filePath}: could not locate CompanionAction union`);
  const actions = new Set([...unionMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  if (actions.size === 0) fail(`${filePath}: CompanionAction union parsed empty`);

  const recordMatch = text.match(/const actionGroups: Record<CompanionAction, CompanionActionGroup> = \{([\s\S]*?)\};/);
  if (!recordMatch) fail(`${filePath}: could not locate actionGroups record`);
  const groups = new Map();
  for (const line of recordMatch[1].matchAll(/(\w+):\s*'([a-z]+)',/g)) {
    const [, action, group] = line;
    if (!GROUPS.includes(group)) fail(`${filePath}: unknown group '${group}' for action '${action}'`);
    groups.set(action, group);
  }

  const unionOnly = [...actions].filter((a) => !groups.has(a));
  const groupOnly = [...groups.keys()].filter((a) => !actions.has(a));
  if (unionOnly.length || groupOnly.length) {
    fail(`${filePath}: CompanionAction union and actionGroups disagree (union-only: [${unionOnly}], record-only: [${groupOnly}])`);
  }

  return groups;
}

// ---- Sources ----------------------------------------------------------------

const sources = [
  {
    name: 'db migration 0089 (companion_commands CHECK + companion_action_group())',
    path: path.join(repoRoot, 'packages/db/migrations/0089_v1_l24_companion_action_catalogue.sql'),
    parse: parseSql,
    required: true,
  },
  {
    name: 'apps/api companion.ts (ACTION_GROUPS)',
    path: path.join(repoRoot, 'apps/api/src/routes/companion.ts'),
    parse: parseCompanionRoute,
    required: true,
  },
  {
    name: 'bharatstudio-companion-desktop macOS CompanionPolicy.swift',
    path: path.join(workspaceRoot, 'bharatstudio-companion-desktop/macos/Sources/BharatStudioCompanionMacOS/CompanionPolicy.swift'),
    parse: parseSwift,
    required: false,
  },
  {
    name: 'bharatstudio-companion-desktop Windows CompanionPolicy.cs',
    path: path.join(workspaceRoot, 'bharatstudio-companion-desktop/windows/CompanionPolicy.cs'),
    parse: parseCSharp,
    required: false,
  },
  {
    name: 'bharatstudio-companion-mobile CompanionApi.ts',
    path: path.join(workspaceRoot, 'bharatstudio-companion-mobile/src/api/CompanionApi.ts'),
    parse: parseMobileApi,
    required: false,
  },
];

let hadError = false;
const parsed = [];

for (const source of sources) {
  if (!existsSync(source.path)) {
    const line = `SKIPPED  ${source.name}\n         not found at ${source.path} — sibling repo is not checked out alongside bharatstudio-alerts`;
    console.log(line);
    if (source.required) {
      console.error(`ERROR: required source is missing: ${source.path}`);
      hadError = true;
    }
    continue;
  }
  try {
    const groups = source.parse(source.path);
    parsed.push({ name: source.name, path: source.path, groups });
    console.log(`OK       ${source.name} — ${groups.size} actions`);
  } catch (error) {
    console.error(`PARSE ERROR  ${source.name}\n         ${error.message}`);
    hadError = true;
  }
}

if (parsed.length < 2) {
  console.error('\nFewer than two sources parsed successfully; nothing to compare.');
  process.exit(1);
}

// ---- Compare -----------------------------------------------------------

const allActions = new Set();
for (const s of parsed) for (const a of s.groups.keys()) allActions.add(a);

const diffLines = [];
for (const action of [...allActions].sort()) {
  const byAction = parsed.map((s) => ({ name: s.name, group: s.groups.get(action) }));
  const present = byAction.filter((e) => e.group !== undefined);
  const missing = byAction.filter((e) => e.group === undefined);
  const distinctGroups = new Set(present.map((e) => e.group));

  if (missing.length > 0) {
    diffLines.push(`  '${action}': missing from ${missing.map((e) => e.name).join(', ')}`);
    hadError = true;
  }
  if (distinctGroups.size > 1) {
    const byGroup = GROUPS.filter((g) => present.some((e) => e.group === g))
      .map((g) => `${g} (${present.filter((e) => e.group === g).map((e) => e.name).join(', ')})`)
      .join(' vs ');
    diffLines.push(`  '${action}': group disagreement — ${byGroup}`);
    hadError = true;
  }
}

console.log(`\nTotal distinct action names seen across ${parsed.length} parsed source(s): ${allActions.size}`);
for (const s of parsed) console.log(`  ${s.groups.size} actions in ${s.name}`);

if (diffLines.length > 0) {
  console.log('\nDRIFT FOUND:');
  console.log(diffLines.join('\n'));
} else {
  console.log('\nNo drift: every parsed source has the same action set with the same group assignments.');
}

process.exit(hadError ? 1 : 0);
