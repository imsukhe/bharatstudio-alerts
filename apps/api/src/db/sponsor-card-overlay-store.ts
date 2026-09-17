import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { OverlaySponsorCard, SponsorCardOverlayStore } from '../domain/sponsor-card-store.js';

// PRF-02 slice 7, §6 catalogue module #11 (Sponsor Card) -- the overlay
// read half.
//
// Mirrors apps/api/src/db/stream-mission-overlay-store.ts,
// lobby-status-overlay-store.ts and giveaway-tournament-overlay-store.ts
// exactly: sha256 fingerprint of the bearer token, matched against
// overlay_sessions.token_fingerprint INSIDE the security-definer function
// (packages/db/migrations/0145). Same overlay_sessions table, same gate --
// no second auth mechanism, and no scoping decision made in TypeScript.
//
// RT-12: this file's name contains "overlay", so the required-queries
// scan's rule 2 covers every app_private call in it regardless of the
// function's name; the factory below is constructed with `derivedReadSql`
// in apps/api/src/index.ts, so rule 3 covers it structurally as well; and
// the function follows the list_overlay_* convention, so rule 1 covers it
// too.
//
// THREE FIELDS. THAT IS THE WHOLE SURFACE, AND NOTHING ABOUT DISPLAY IS
// ON IT. `app_private.list_overlay_sponsor_card` returns a row only when
// the card is currently supposed to be visible (enabled, and inside its
// schedule if it has one); every other case -- disabled, outside the
// window, wrong/expired/revoked/foreign token, no card at all -- is zero
// rows, collapsed here to `null`. There is no count, no impression, no
// exposure, no duration and no "last shown" anywhere on this path, and
// none exists in the schema behind it either.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type OverlayRow = {
  sponsor_name: string;
  logo_mime_type: string | null;
  logo_storage_key: string | null;
};

export function createSqlSponsorCardOverlayStore(sql: Sql): SponsorCardOverlayStore {
  return {
    async getForOverlay(token, overlayId): Promise<OverlaySponsorCard | null> {
      const rows = await sql<OverlayRow[]>`
        select sponsor_name, logo_mime_type, logo_storage_key
          from app_private.list_overlay_sponsor_card(${overlayId}::uuid, ${fingerprint(token)})
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        schemaVersion: 'v1',
        sponsorName: row.sponsor_name,
        logoMimeType: row.logo_mime_type,
        logoStorageKey: row.logo_storage_key,
      };
    },
  };
}
