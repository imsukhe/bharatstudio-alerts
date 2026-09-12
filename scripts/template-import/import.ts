#!/usr/bin/env -S node
// L20: template-catalogue import CLI.
//
// Usage (must be run from apps/api so tsx/postgres resolve — see below):
//   cd apps/api && npx tsx ../../scripts/template-import/import.ts <manifest.json>
//
// Env: DATABASE_URL_APP (or DATABASE_URL as a local fallback) must point
// at a database with migrations applied through at least 0106.
//
// MANIFEST FORMAT — the shape the real 600-design catalogue
// (contracts/template-catalogue.json) must be converted to before it can
// be imported:
//
//   {
//     "schemaVersion": "v1",
//     "entries": [
//       {
//         "externalKey": "BSA-001",          // stable identity — see 0106
//         "displayName": "Minimal Clean — Tip",
//         "category": "Minimal Clean",
//         "minTier": "free",                 // free | pro | creator | studio
//         "renderDocument": { "v": "1.0", "layers": [ /* Lottie-shaped, no expr/script/external refs */ ] }
//       }
//     ]
//   }
//
// See scripts/template-import/fixtures/synthetic-manifest.json for a
// complete synthetic example (four entries, one deliberately malformed
// for the rejection case — see fixtures/synthetic-manifest-malformed.json
// for a manifest that must fail as a whole).
//
// Every entry is validated in full (shape + Lottie-derived content-safety
// walk, see apps/api/src/domain/template-import-validation.ts) BEFORE any
// database write happens. If even one entry is malformed, the run prints
// every failure it found and exits 1 with zero writes — never a partial
// import. Only once every entry in the manifest passes does the whole
// batch get written, itself inside one transaction (see
// apps/api/src/db/template-import-runner.ts) so a late server-side
// rejection (defense in depth — migration 0106 re-validates too) rolls
// back the entire run rather than leaving some entries imported.

import { readFileSync } from 'node:fs';
import { validateTemplateManifestEntry, type TemplateManifestEntry } from '../../apps/api/src/domain/template-import-validation.js';
import { createImportConnection, importManifestEntries } from '../../apps/api/src/db/template-import-runner.js';

type ManifestFile = { schemaVersion: string; entries: unknown[] };

function loadManifest(path: string): ManifestFile {
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${(error as Error).message})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path}: manifest must be a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 'v1') {
    throw new Error(`${path}: unsupported schemaVersion "${String(record.schemaVersion)}" (expected "v1")`);
  }
  if (!Array.isArray(record.entries)) {
    throw new Error(`${path}: "entries" must be an array`);
  }
  return { schemaVersion: record.schemaVersion, entries: record.entries };
}

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error('usage: import.ts <manifest.json>');
    process.exitCode = 1;
    return;
  }

  const manifest = loadManifest(manifestPath);

  // Pass 1: validate every entry. Malformed => abort with zero writes.
  const validated: { entry: TemplateManifestEntry; renderBytes: Buffer }[] = [];
  const failures: string[] = [];
  const seenKeys = new Set<string>();

  manifest.entries.forEach((raw, index) => {
    const result = validateTemplateManifestEntry(raw);
    const externalKeyForLog = typeof (raw as Record<string, unknown> | null)?.['externalKey'] === 'string'
      ? (raw as Record<string, unknown>)['externalKey'] as string
      : `#${index}`;
    if (!result.ok) {
      failures.push(`${externalKeyForLog}: ${result.reason}`);
      return;
    }
    const entry = raw as TemplateManifestEntry;
    if (seenKeys.has(entry.externalKey)) {
      failures.push(`${entry.externalKey}: duplicate externalKey within this manifest`);
      return;
    }
    seenKeys.add(entry.externalKey);
    validated.push({ entry, renderBytes: result.renderBytes });
  });

  if (failures.length > 0) {
    console.error(`Manifest rejected — ${failures.length} malformed entr${failures.length === 1 ? 'y' : 'ies'}, 0 imported:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  const connectionString = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL_APP (or DATABASE_URL) is required');
    process.exitCode = 1;
    return;
  }

  const sql = createImportConnection(connectionString);
  try {
    const report = await importManifestEntries(sql, validated);
    const created = report.filter((r) => r.outcome === 'created').length;
    const updated = report.filter((r) => r.outcome === 'updated').length;
    const skipped = report.filter((r) => r.outcome === 'skipped').length;
    console.log(`Imported ${report.length} entries — created ${created}, updated ${updated}, skipped ${skipped}`);
    for (const line of report) console.log(`  ${line.outcome.padEnd(8)} ${line.externalKey} (${line.entryId})`);
  } catch (error) {
    console.error(`Import failed, transaction rolled back: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
