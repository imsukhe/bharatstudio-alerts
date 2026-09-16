import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type {
  ReactionCloudEntry,
  ReactionCloudOverlayStore,
  ReactionEntrySource,
} from '../domain/reaction-cloud-store.js';

// PRF-02 slice 6, §6 catalogue module #5 (Reaction Cloud) -- the overlay
// read half.
//
// Mirrors apps/api/src/db/moderator-status-overlay-store.ts and
// goal-overlay-store.ts exactly: sha256 fingerprint of the bearer token,
// matched against overlay_sessions.token_fingerprint INSIDE the
// security-definer function (packages/db/migrations/0139). Same
// overlay_sessions table, same gate -- no second auth mechanism, and no
// scoping decision made in TypeScript.
//
// RT-12: this file's name contains "overlay", so the required-queries
// scan's rule 2 covers every app_private call in it regardless of the
// function's name; the factory below is constructed with `derivedReadSql`
// in apps/api/src/index.ts, so rule 3 covers it structurally as well; and
// the function follows the list_overlay_* convention, so rule 1 covers it
// too. All three independently require the manifest entry in
// packages/db/explain-plans/required-queries.json.
//
// ======================================================================
// THE ONE LINE THAT MAKES SAMPLING SERVER-SIDE IS THE THIRD ARGUMENT.
// ======================================================================
// §19.5: reactions are "sampled and rate-limited server-side BEFORE they
// reach the canvas", and the cloud shows "a representative sample, never
// every event". `sampleMax` is passed INTO the SQL function, where it
// becomes the query's own LIMIT, applied after an aggregate that has
// already collapsed every event into one row per catalogue entry.
//
// This file therefore never sees, and could not drop, a reaction stream:
// by the time a row reaches this code it is already a count. There is
// deliberately no `.slice()`, no `.filter()` and no cap of any kind in
// the TypeScript below -- a cap here would be exactly the client-side
// sampling §19.5 forbids, and its absence is the proof that the real one
// happens in the database.
//
// THE CEILING IS "CONFIGURED BUT UNSET". `sampleMax` is `number |
// undefined`, and `undefined` is passed to PostgreSQL as NULL, where
// `LIMIT NULL` means no limit -- so unset imposes no ceiling beyond the
// query's own structural bound (at most one row per catalogue entry the
// channel can reach). That is the same shape apps/api/src/config.ts
// already uses for overlayMaxInstanceSubscribers,
// overlayMaxChannelSubscribers, derivedReadMaxConcurrent,
// derivedReadPoolMax and derivedReadStatementTimeoutMs. No default is
// invented here, and none may be: the value is the deployment's, or it is
// absent.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSqlReactionCloudOverlayStore(sql: Sql, sampleMax?: number): ReactionCloudOverlayStore {
  // Resolved once at construction so a later mutation of the config object
  // cannot change the ceiling under a live overlay mid-stream. `null` is
  // the configured-but-unset value the SQL function expects.
  const ceiling = typeof sampleMax === 'number' && Number.isSafeInteger(sampleMax) && sampleMax >= 1 ? sampleMax : null;

  return {
    async listForOverlay(token, overlayId): Promise<ReactionCloudEntry[]> {
      // Four columns selected, because four columns are all the function
      // returns. Widening this select is not possible without widening
      // migration 0139's own `returns table` signature, which
      // packages/db/tests/prf02_slice6_reaction_cloud.sql asserts against
      // directly -- twice.
      const rows = await sql<{ entry_source: string; entry_id: string; display_name: string; reaction_count: string | number }[]>`
        select entry_source, entry_id, display_name, reaction_count
          from app_private.list_overlay_reaction_cloud(${overlayId}::uuid, ${fingerprint(token)}, ${ceiling}::integer)
      `;
      const entries: ReactionCloudEntry[] = [];
      for (const row of rows) {
        const count = Number(row.reaction_count);
        if (!Number.isSafeInteger(count) || count <= 0) continue;
        if (row.entry_source !== 'catalogue' && row.entry_source !== 'creator_pack') continue;
        entries.push({
          entrySource: row.entry_source as ReactionEntrySource,
          entryId: row.entry_id,
          displayName: row.display_name,
          reactionCount: count,
        });
      }
      return entries;
    },
  };
}
