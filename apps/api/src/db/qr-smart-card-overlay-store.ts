import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { OverlayQrSmartCard, QrSmartCardOverlayStore } from '../domain/qr-smart-card-store.js';

// PRF-02 slice 7, overlay side of §6 module #10 (migration 0144).
//
// THIS FILE IS DELIBERATELY SEPARATE FROM db/qr-smart-card-store.ts, and
// deliberately named with "overlay" in it, because of how
// packages/db/explain-plans/scan-required-queries.mjs actually finds
// queries -- see db/stream-mission-overlay-store.ts's own header for the
// full account of all three scan rules. Same three rules cover the one
// call below: rule 1 (the `list_overlay_*` name), rule 2 (this
// basename contains "overlay"), and rule 3 (apps/api/src/index.ts
// constructs createSqlQrSmartCardOverlayStore with derivedReadSql).
//
// Mirrors db/stream-mission-overlay-store.ts / db/moderator-status-
// overlay-store.ts exactly: sha256 fingerprint of the bearer token,
// matched against overlay_sessions' stored token_fingerprint INSIDE the
// security-definer function. Same overlay_sessions table, same scoping,
// no second auth mechanism and no second overlay session.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSqlQrSmartCardOverlayStore(sql: Sql): QrSmartCardOverlayStore {
  return {
    async getForOverlay(token, overlayId): Promise<OverlayQrSmartCard | null> {
      // The row is returned ONLY when the card's own is_enabled is true
      // (migration 0144's own WHERE clause, not a filter added here) --
      // a disabled card and a channel that never configured one both
      // answer with zero rows.
      const rows = await sql<{ destination: string; label: string }[]>`
        select destination, label
          from app_private.list_overlay_qr_smart_card(${overlayId}::uuid, ${fingerprint(token)})
      `;
      const row = rows[0];
      if (!row) return null;
      // Two fields. No is_enabled, no card id, no timestamp -- the row's
      // own presence already carries the toggle state (owner decision,
      // 2026-09-17: one toggle, and this is where it is enforced as a
      // property of the query rather than of the renderer).
      return { schemaVersion: 'v1', destination: row.destination, label: row.label };
    },
  };
}
