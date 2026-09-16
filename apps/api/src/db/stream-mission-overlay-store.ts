import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { OverlayStreamMission, StreamMissionOverlayStore } from '../domain/stream-mission-store.js';

// PRF-02 slice 5, overlay side of §6 module #9 (migration 0135).
//
// THIS FILE IS DELIBERATELY SEPARATE FROM db/stream-mission-store.ts, and
// deliberately named with "overlay" in it, because of how
// packages/db/explain-plans/scan-required-queries.mjs actually finds
// queries -- the scan was read before these files were named, not after:
//
//   RULE 1 (convention): every `app_private.list_overlay_*` call in
//   apps/api/src/db/*.ts or routes/*.ts must be in required-queries.json's
//   manifest. `app_private.list_overlay_stream_mission` below matches.
//
//   RULE 2 (file name): every `app_private.*` call -- ANY name -- inside a
//   file under apps/api/src/db/ whose basename contains "overlay" or
//   "master-canvas" must be manifested or exempted. This basename contains
//   "overlay", so this file is scanned in full. The one call below is
//   manifested; NO exemption was added by this slice.
//
//   RULE 3 (composition root, new in the 2026-09-16 blind-spot closure):
//   every `app_private.*` call inside the body of a factory that
//   apps/api/src/index.ts constructs with `derivedReadSql` must be
//   manifested or exempted. index.ts constructs
//   createSqlStreamMissionOverlayStore(derivedReadSql!), so rule 3
//   resolves this file through index.ts's own import statement,
//   brace-matches the exported factory below, and scans it. Same single
//   manifested call.
//
// All three rules cover this read on substance. None is dodged by naming.
//
// Mirrors db/challenge-overlay-store.ts and db/goal-overlay-store.ts
// exactly: sha256 fingerprint of the bearer token, matched against
// overlay_sessions' stored token_fingerprint INSIDE the security-definer
// function. Same overlay_sessions table, same scoping, no second auth
// mechanism and no second overlay session.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSqlStreamMissionOverlayStore(sql: Sql): StreamMissionOverlayStore {
  return {
    async getForOverlay(token, overlayId): Promise<OverlayStreamMission | null> {
      // §12.7 bounded: at most the CURRENT mission, never a history. The
      // bound is the function's own (`ended_at is null` plus migration
      // 0135's partial unique index), not a client-side slice of a larger
      // result set.
      const rows = await sql<{ mission_id: string; objective: string; started_at: Date }[]>`
        select mission_id, objective, started_at
          from app_private.list_overlay_stream_mission(${overlayId}::uuid, ${fingerprint(token)})
      `;
      const row = rows[0];
      if (!row) return null;
      // Three fields. No identity, and no end-shaped field -- the mission
      // is session-bounded, not clock-bounded (owner decision, §6 row 9).
      return {
        schemaVersion: 'v1',
        missionId: row.mission_id,
        objective: row.objective,
        startedAt: row.started_at.toISOString(),
      };
    },
  };
}
