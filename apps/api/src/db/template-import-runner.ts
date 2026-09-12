// L20: the DB-writing half of the template-catalogue import pipeline.
// Lives under apps/api/src/db (owned, prefixed template-) rather than in
// scripts/template-import/** itself so that the `postgres` client
// dependency resolves the normal pnpm-workspace way — scripts/ is not a
// workspace package and cannot import a bare "postgres" specifier
// directly. scripts/template-import/import.ts imports this file by
// relative path and supplies its own postgres connection.
//
// Every entry has already passed validateTemplateManifestEntry (content
// safety + shape) before it reaches here; this runner's only job is the
// per-entry upsert call to migration 0106's import_template_catalogue_entry
// and turning its (outcome, entry_id) result into a report line. One
// malformed entry never reaches this function at all — see importManifest
// in the script, which validates every entry before writing any of them.

import postgres, { type Sql, type TransactionSql } from 'postgres';
import type { TemplateManifestEntry } from '../domain/template-import-validation.js';

// The `postgres` bare import must live in a file inside apps/api's own
// node_modules ancestry to resolve — scripts/template-import/import.ts is
// outside the pnpm workspace and cannot import it directly, so it gets a
// connection through this factory instead of constructing one itself.
export function createImportConnection(connectionString: string): Sql {
  return postgres(connectionString, { max: 1 });
}

export type TemplateImportOutcome = 'created' | 'updated' | 'skipped';

export type TemplateImportReportLine = {
  externalKey: string;
  outcome: TemplateImportOutcome;
  entryId: string;
};

export async function importValidatedTemplateEntry(
  sql: Sql | TransactionSql,
  entry: TemplateManifestEntry,
  renderBytes: Buffer,
): Promise<TemplateImportReportLine> {
  const rows = await sql<{ outcome: TemplateImportOutcome; entry_id: string }[]>`
    select outcome, entry_id
      from app_private.import_template_catalogue_entry(
        ${entry.externalKey},
        ${entry.displayName},
        ${entry.category},
        ${entry.minTier},
        ${renderBytes}
      )
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`import_template_catalogue_entry returned no row for ${entry.externalKey}`);
  }
  return { externalKey: entry.externalKey, outcome: row.outcome, entryId: row.entry_id };
}

/**
 * Imports every already-validated entry inside one transaction: if the
 * database rejects any entry (e.g. a tier value that passed client-side
 * validation but was renamed since, or any other server-side
 * re-validation failure in migration 0106), the whole run rolls back —
 * no batch ever half-lands. Every entry in `entries` must already have
 * passed validateTemplateManifestEntry; that check runs before this
 * function is ever called (see scripts/template-import/import.ts).
 */
export async function importManifestEntries(
  sql: Sql,
  entries: ReadonlyArray<{ entry: TemplateManifestEntry; renderBytes: Buffer }>,
): Promise<TemplateImportReportLine[]> {
  return sql.begin(async (tx) => {
    const report: TemplateImportReportLine[] = [];
    for (const { entry, renderBytes } of entries) {
      report.push(await importValidatedTemplateEntry(tx, entry, renderBytes));
    }
    return report;
  });
}
