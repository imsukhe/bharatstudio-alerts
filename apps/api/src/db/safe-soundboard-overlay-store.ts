import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type {
  OverlaySoundboardPlay,
  SafeSoundboardOverlayStore,
} from '../domain/safe-soundboard-store.js';

// PRF-02 slice 7, §6 catalogue module #6 (Safe Soundboard Alert) -- the
// overlay read half.
//
// Mirrors db/lobby-status-overlay-store.ts and db/giveaway-tournament-
// overlay-store.ts exactly: sha256 fingerprint of the bearer token,
// matched against overlay_sessions.token_fingerprint INSIDE the
// security-definer function (packages/db/migrations/0143). Constructed
// with `derivedReadSql` in apps/api/src/index.ts, which is what puts
// this file inside rule 3 of the RT-12 required-queries scan.
//
// SEVEN COLUMNS. THAT IS THE WHOLE SURFACE. play_id, clip_kind,
// display_name, gcs_object_key, mime_type, duration_seconds and
// triggered_at -- no viewer/supporter identifier exists anywhere in this
// schema for an eighth column to leak. play_id is an opaque event id for
// client-side de-duplication only.
//
// THE ENTITLEMENT IS NOT CHECKED IN THIS FILE, DELIBERATELY -- it lives
// inside app_private.list_overlay_soundboard_play (§30.3 Pro+ via
// app_private.soundboard_module_entitled), exactly as the giveaway/
// tournament and lobby-status overlay stores leave their own entitlement
// checks to SQL.
//
// CDN URL RESOLUTION HAPPENS HERE, NOT IN SQL. `gcsObjectKey` never
// leaves this file as a raw key: it is resolved against the server's OWN
// configured CDN base (§19.1), which is itself CONFIGURED BUT UNSET in
// every environment today (no CDN base URL has been decided or
// provisioned) -- so `playbackUrl` is `null` for every clip until that
// config value exists. First-party catalogue clips are schema-ready to
// play the instant it does; nothing about this file needs to change when
// it is set.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type OverlayRow = {
  play_id: string;
  clip_kind: string;
  display_name: string;
  gcs_object_key: string;
  mime_type: string;
  duration_seconds: number;
  triggered_at: Date;
};

/**
 * `objectKey` is a database-validated, narrow-character-set fragment
 * (see migration 0143's check constraints) -- it can never itself carry
 * a scheme or a host. `cdnBaseUrl`, when present, is validated https at
 * config load time (apps/api/src/config.ts). Concatenation is therefore
 * always OUR OWN origin, never a value either the database row or the
 * caller controls -- the §9.1.1 guarantee this function exists to keep.
 */
export function resolveSoundboardPlaybackUrl(cdnBaseUrl: string | undefined, objectKey: string): string | null {
  if (!cdnBaseUrl) return null;
  return `${cdnBaseUrl.replace(/\/+$/, '')}/${objectKey}`;
}

export function createSqlSafeSoundboardOverlayStore(sql: Sql, cdnBaseUrl: string | undefined): SafeSoundboardOverlayStore {
  return {
    async getForOverlay(token, overlayId): Promise<OverlaySoundboardPlay | null> {
      const rows = await sql<OverlayRow[]>`
        select play_id, clip_kind, display_name, gcs_object_key, mime_type, duration_seconds, triggered_at
          from app_private.list_overlay_soundboard_play(${overlayId}::uuid, ${fingerprint(token)})
      `;
      const row = rows[0];
      // Zero rows is the answer for an unrecognised/expired/revoked/
      // foreign token, for a channel that has triggered nothing, AND for
      // an unentitled (sub-Pro) channel -- all mean "paint nothing".
      if (!row) return null;
      return {
        schemaVersion: 'v1',
        playId: row.play_id,
        clipKind: row.clip_kind as OverlaySoundboardPlay['clipKind'],
        displayName: row.display_name,
        playbackUrl: resolveSoundboardPlaybackUrl(cdnBaseUrl, row.gcs_object_key),
        mimeType: row.mime_type,
        durationSeconds: Number(row.duration_seconds),
        triggeredAt: row.triggered_at.toISOString(),
      };
    },
  };
}
