import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { CanvasLayout, CanvasLayoutOverlayStore, OverlayCanvasLayout } from '../domain/canvas-layout-store.js';

// PRF-02 slice 7, overlay side of §6 module #14 (migration 0147).
//
// THIS FILE IS DELIBERATELY SEPARATE FROM db/canvas-layout-store.ts, and
// deliberately named with "overlay" in it, for the same reason
// db/qr-smart-card-overlay-store.ts's own header records --
// packages/db/explain-plans/scan-required-queries.mjs's rule 2 (this
// basename contains "overlay") and rule 3 (apps/api/src/index.ts
// constructs createSqlCanvasLayoutOverlayStore with derivedReadSql) both
// need this call in its own dedicated overlay-store file to be found.
//
// Mirrors db/qr-smart-card-overlay-store.ts exactly: sha256 fingerprint
// of the bearer token, matched against overlay_sessions' stored
// token_fingerprint INSIDE the security-definer function. Same
// overlay_sessions table, same scoping, no second auth mechanism and no
// second overlay session.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSqlCanvasLayoutOverlayStore(sql: Sql): CanvasLayoutOverlayStore {
  return {
    async getForOverlay(token, overlayId): Promise<OverlayCanvasLayout | null> {
      // A valid overlay session ALWAYS returns exactly one row here --
      // the Pro+ render gate (§30.3) is evaluated INSIDE
      // app_private.list_overlay_canvas_layout (migration 0147), so an
      // unentitled channel's row still comes back with
      // layout = 'horizontal'. Zero rows means an invalid SESSION
      // (revoked/expired/wrong fingerprint/foreign), never an
      // entitlement outcome -- unlike every other module's overlay read
      // in this codebase, there is no "nothing to paint" state for a
      // layout short of the session itself being invalid.
      const rows = await sql<{ layout: CanvasLayout }[]>`
        select layout
          from app_private.list_overlay_canvas_layout(${overlayId}::uuid, ${fingerprint(token)})
      `;
      const row = rows[0];
      if (!row) return null;
      return { schemaVersion: 'v1', layout: row.layout };
    },
  };
}
