import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { ModeratorStatus, ModeratorStatusOverlayStore } from '../domain/moderator-status-store.js';

// PRF-02 slice 5, §6 module #12 (Moderator Status Card, held half only).
//
// Mirrors apps/api/src/db/challenge-overlay-store.ts and
// goal-overlay-store.ts exactly: sha256 fingerprint of the bearer token,
// matched against overlay_sessions.token_fingerprint INSIDE the
// security-definer function (packages/db/migrations/0136). Same
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
// ZERO ROWS AND A ROW OF ZERO ARE DIFFERENT ANSWERS, and this file is
// where that distinction becomes the client's. The function returns no
// rows for a token it does not recognise (bad fingerprint, foreign
// channel, expired, revoked) and exactly one row -- possibly reading 0
// and false -- for a valid session. So `null` here means "not authorised
// / no answer" and `{ heldCount: 0, safeMode: false }` means
// "authorised, nothing is held, safe mode is off". The Canvas module
// renders those two the same (nothing) but they are not the same
// answer, and collapsing them in this layer would be a bug.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSqlModeratorStatusOverlayStore(sql: Sql): ModeratorStatusOverlayStore {
  return {
    async getForOverlay(token, overlayId): Promise<ModeratorStatus | null> {
      // Two columns selected, because two columns are all the function
      // returns. Widening this select is not possible without widening
      // migration 0138's own `returns table` signature, which
      // packages/db/tests/prf02_slice5_moderator_status.sql asserts
      // against directly (case S5.4, extended from slice 5's one-column
      // assertion to the new declared type rather than deleted).
      //
      // safe_mode is the creator's own per-channel switch (owner
      // decision, 2026-09-16). It is NOT alert_queues.is_paused, and
      // migration 0138 still never reads that column.
      const rows = await sql<{ held_count: string | number; safe_mode: boolean }[]>`
        select held_count, safe_mode
          from app_private.list_overlay_moderator_status(${overlayId}::uuid, ${fingerprint(token)})
      `;
      const row = rows[0];
      if (!row) return null;
      const heldCount = Number(row.held_count);
      if (!Number.isSafeInteger(heldCount) || heldCount < 0) return null;
      // Never coerced. A non-boolean here means the read did not answer
      // the question asked, and an invented "off" would be a claim about
      // moderation state.
      if (typeof row.safe_mode !== 'boolean') return null;
      return { schemaVersion: 'v1', heldCount, safeMode: row.safe_mode };
    },
  };
}
