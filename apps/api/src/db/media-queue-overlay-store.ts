import { createHash } from 'node:crypto';
import type { MediaQueueOverlayStore, OverlayMediaQueueEntry } from '../domain/media-queue-store.js';
import type { Sql } from 'postgres';

// PRF-02 slice 7, §6 catalogue module #20 (Media / Meme Queue) -- the
// overlay read half.
//
// Mirrors apps/api/src/db/giveaway-tournament-overlay-store.ts,
// lobby-status-overlay-store.ts and stream-mission-overlay-store.ts
// exactly: sha256 fingerprint of the bearer token, matched against
// overlay_sessions.token_fingerprint INSIDE the security-definer function
// (packages/db/migrations/0146, url-hardened by migration 0148). Same
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
// CDN URL RESOLUTION HAPPENS HERE, NOT IN SQL -- migration 0148's fix for
// the "arbitrary remote origin" finding, mirroring
// db/safe-soundboard-overlay-store.ts's resolveSoundboardPlaybackUrl
// exactly. `gcsObjectKey` / `thumbnailGcsObjectKey` never leave this file
// as raw keys: each is resolved against the server's OWN configured CDN
// base (§19.1), `cdnBaseUrl` below, which is `config.mediaCdnBaseUrl` --
// the SAME config value the soundboard overlay store already reads; this
// file introduces no second one. That value is itself CONFIGURED BUT
// UNSET in every environment today, so `playbackUrl` /
// `thumbnailPlaybackUrl` are null for every entry until it is
// provisioned, and apps/web/app/overlay/canvas/modules/media-queue-
// module.ts renders nothing for an entry whose playbackUrl is null -- the
// same honest "cannot display until GCS/CDN exists" posture the
// soundboard card already has.
// ======================================================================
// AT MOST TWO ROWS. THAT IS THE WHOLE SURFACE.
// ======================================================================
// §12.7's Overlay row authorises "current and next alert state" in those
// exact words, and this module reuses the SAME bound
// apps/web/app/overlay/canvas/modules/support-theater-module.ts:68-72
// already established rather than inventing a queue-depth number of its
// own: app_private.list_overlay_media_queue returns AT MOST TWO rows,
// labelled 'current' and 'next', and no aggregate queue-depth count is
// ever returned. An overlay token cannot learn how many items are queued
// behind what it is shown.
//
// SELECT-ONLY. This file has exactly one method
// (MediaQueueOverlayStore.getForOverlay) and no write method exists on
// its interface. There is no submitter, no viewer identity and no item id
// on this path -- not withheld, but absent from the SQL function's own
// declared result type, asserted in
// packages/db/tests/prf02_slice7_media_queue.sql (MED20.2).
//
// THIS MODULE HAS NO PER-MODULE ENTITLEMENT GATE, UNLIKE THE GIVEAWAY /
// TOURNAMENT CARD. §30.3 names no Creator+/Events-Pack-style row for
// Media / Meme Queue; the only gate governing whether this module renders
// at all is 0131's existing module-wide "Master Canvas modules active"
// cap (Free 2 / Pro 5 / Creator 12 / Studio all), which already lists
// 'media_meme_queue' as one of its twenty catalogue keys. So this file
// calls no entitlement function, and none should be added without a
// corresponding §30.3 decision.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type OverlayRow = {
  queue_slot: string;
  title: string;
  media_kind: string;
  mime_type: string;
  gcs_object_key: string;
  thumbnail_gcs_object_key: string | null;
  duration_ms: number | null;
};

/**
 * `objectKey` is a database-validated, narrow-character-set fragment (see
 * migration 0148's check constraints, mirroring migration 0143's
 * soundboard columns exactly) -- it can never itself carry a scheme or a
 * host. `cdnBaseUrl`, when present, is validated https at config load
 * time (apps/api/src/config.ts). Concatenation is therefore always OUR
 * OWN origin, never a value either the database row or the caller
 * controls -- the §9.1.1 guarantee this function exists to keep. Mirrors
 * db/safe-soundboard-overlay-store.ts's resolveSoundboardPlaybackUrl.
 */
export function resolveMediaPlaybackUrl(cdnBaseUrl: string | undefined, objectKey: string | null): string | null {
  if (!cdnBaseUrl || !objectKey) return null;
  return `${cdnBaseUrl.replace(/\/+$/, '')}/${objectKey}`;
}

export function createSqlMediaQueueOverlayStore(sql: Sql, cdnBaseUrl: string | undefined): MediaQueueOverlayStore {
  return {
    async getForOverlay(token, overlayId): Promise<OverlayMediaQueueEntry[]> {
      const rows = await sql<OverlayRow[]>`
        select queue_slot, title, media_kind, mime_type, gcs_object_key, thumbnail_gcs_object_key, duration_ms
          from app_private.list_overlay_media_queue(${overlayId}::uuid, ${fingerprint(token)})
      `;
      // Zero rows is the answer for an unrecognised, expired, revoked or
      // foreign token AND for a channel with nothing live in rotation.
      // Both mean the same thing to the module -- paint nothing -- so
      // they are collapsed to an empty array here rather than given two
      // shapes the renderer would have to tell apart.
      return rows.map((row): OverlayMediaQueueEntry => ({
        schemaVersion: 'v1',
        queueSlot: row.queue_slot as OverlayMediaQueueEntry['queueSlot'],
        title: row.title,
        mediaKind: row.media_kind as OverlayMediaQueueEntry['mediaKind'],
        mimeType: row.mime_type,
        playbackUrl: resolveMediaPlaybackUrl(cdnBaseUrl, row.gcs_object_key),
        thumbnailPlaybackUrl: resolveMediaPlaybackUrl(cdnBaseUrl, row.thumbnail_gcs_object_key),
        durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      }));
    },
  };
}
