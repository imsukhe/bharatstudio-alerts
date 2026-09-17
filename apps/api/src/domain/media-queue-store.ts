// PRF-02 slice 7, §6 catalogue module #20 (Media / Meme Queue) and the
// minimum schema behind it
// (packages/db/migrations/0146_v1_prf02_media_queue.sql,
// URL-hardened by packages/db/migrations/0148_v1_prf02_slice7_media_queue_url_hardening.sql).
//
// CREATOR-ONLY. VIEWERS CANNOT SUBMIT. This is the owner's decision of
// 2026-09-17 (bharatstudio-requirements/reviews/
// 2026-09-17-remaining-eight-modules-and-youtube-v1-amendment.md, Part 1
// §8; register row MED-20). There is no submission endpoint, no approval
// queue, no viewer-facing write surface of any kind, no moderation queue,
// no rejection reason and no submitter identity field anywhere in this
// file, and none of those types exist for a future edit to populate --
// see MediaQueueStore's shape below, which has exactly one write surface
// (the creator's own, session-authenticated one) and MediaQueueOverlayStore,
// which has exactly one READ method and no write method of any kind.
//
// STORAGE: §19.1, METADATA ONLY, AND NO ARBITRARY ORIGIN (§9.1.1, hostile
// review finding fixed by migration 0148). `gcsObjectKey` /
// `thumbnailGcsObjectKey` are content-KEY fragments -- never a URL, never
// a caller-chosen host -- restricted to migration 0143's exact character
// set (mirrored by this migration's own CHECK constraint), which cannot
// express a scheme or a host at all. There is no byte payload, no upload
// pipeline and no bytea anywhere in this type or the migration behind it
// (MED-21: the bytea path is legacy and this module never uses it).
// `OverlayMediaQueueEntry.playbackUrl` / `thumbnailPlaybackUrl` are the
// SEPARATE, server-RESOLVED projection -- built only in
// apps/api/src/db/media-queue-overlay-store.ts by concatenating the key
// onto the server's OWN configured CDN base (`config.mediaCdnBaseUrl`,
// the SAME value db/safe-soundboard-overlay-store.ts already reads), null
// whenever that base is unset (every environment today). No caller- or
// database-supplied host can ever reach either field.
//
// §9.1.1: `mimeType` is restricted to a closed allow-list at both this
// layer and the database's own CHECK constraint -- no text/html, no
// image/svg+xml (inline script), no application/* of any kind. Nothing in
// this type has a slot for a script, an iframe or a stylesheet. This was
// never the mechanism migration 0148 changed, and it still is not: this
// migration hardens WHICH ORIGIN can be contacted, not what an <img>/
// <video> src is permitted to decode.
//
// NEVER TIER-GATED (§12.6). Storing, viewing, editing and changing the
// status of a durable creator record is available at every tier; the only
// gate on any of these operations is the role gate
// (app_private.has_channel_role owner/admin), which lives in SQL. What a
// tier caps is whether the CANVAS renders the module at all, via 0131's
// existing module-wide cap -- 'media_meme_queue' was already one of that
// check constraint's twenty catalogue keys, and this file adds no second
// entitlement check.

/** Creator/dashboard-facing projection of one queued media item. */
export type MediaQueueItem = {
  schemaVersion: 'v1';
  mediaQueueItemId: string;
  title: string;
  mediaKind: 'image' | 'gif' | 'video';
  mimeType: string;
  gcsObjectKey: string;
  thumbnailGcsObjectKey: string | null;
  durationMs: number | null;
  status: 'queued' | 'played' | 'skipped';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Overlay/browser-source projection. AT MOST TWO of these are ever
 * returned by a single overlay read -- "current" and "next", reusing the
 * exact bound apps/web/app/overlay/canvas/modules/support-theater-
 * module.ts:68-72 already established for this codebase ("never a queue
 * depth, never a second item deeper in the queue"). There is deliberately
 * no item id, no submitter, no viewer identity and no channel-wide
 * queue-depth count anywhere in this type.
 *
 * `playbackUrl` / `thumbnailPlaybackUrl` are resolved by the API layer
 * from `gcsObjectKey` / `thumbnailGcsObjectKey` against the configured CDN
 * base (§19.1) -- see db/media-queue-overlay-store.ts. Null whenever that
 * base is not configured, which today is every environment (migration
 * 0148).
 */
export type OverlayMediaQueueEntry = {
  schemaVersion: 'v1';
  queueSlot: 'current' | 'next';
  title: string;
  mediaKind: 'image' | 'gif' | 'video';
  mimeType: string;
  playbackUrl: string | null;
  thumbnailPlaybackUrl: string | null;
  durationMs: number | null;
};

export const MEDIA_QUEUE_TITLE_MAX = 120;
/**
 * Migration 0143's exact gcs_object_key bound and character set, mirrored
 * rather than reinvented (migration 0148). A key fragment matching this
 * pattern cannot carry a scheme, a host or a `..` traversal segment.
 */
export const MEDIA_QUEUE_OBJECT_KEY_MAX = 255;
export const MEDIA_QUEUE_OBJECT_KEY_PATTERN = /^[A-Za-z0-9/_.-]{1,255}$/;
/** Resolved playback URL bound -- unchanged from the prior storage_url
 *  column's own bound, still reused for the server-resolved projection. */
export const MEDIA_QUEUE_PLAYBACK_URL_MAX = 2048;
/**
 * PostgreSQL `integer`'s own upper bound. A STORAGE bound, not a product
 * bound -- this module names no maximum duration and this codebase will
 * not invent one. See EnqueueMediaQueueItemInput's `maxDurationMs` for the
 * CONFIGURED-BUT-UNSET cap that actually governs duration in practice.
 */
export const MEDIA_QUEUE_DURATION_MAX_MS = 2147483647;

export const MEDIA_QUEUE_KINDS = ['image', 'gif', 'video'] as const;
/**
 * §9.1.1 closed allow-list. No text/html, no image/svg+xml (SVG can carry
 * inline script), no application/* of any kind.
 */
export const MEDIA_QUEUE_MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
] as const;

export type EnqueueMediaQueueItemInput = {
  title: string;
  mediaKind: (typeof MEDIA_QUEUE_KINDS)[number];
  mimeType: (typeof MEDIA_QUEUE_MIME_TYPES)[number];
  gcsObjectKey: string;
  thumbnailGcsObjectKey?: string | null;
  durationMs?: number | null;
  /**
   * CONFIGURED BUT UNSET. Threaded through from deployment configuration
   * (see apps/api/src/config.ts's mediaQueueMaxItemDurationMs), never
   * chosen by this codebase. Unset (undefined/null) means today's
   * behaviour: no additional ceiling beyond durationMs being non-negative.
   */
  maxDurationMs?: number | null;
  /**
   * CONFIGURED BUT UNSET. Threaded through from deployment configuration
   * (see apps/api/src/config.ts's mediaQueueMaxItemsPerChannel). Unset
   * means no ceiling on how many items may be queued at once.
   */
  maxQueueItems?: number | null;
};

export type EnqueueMediaQueueItemResult =
  | { outcome: 'ok'; item: MediaQueueItem }
  | { outcome: 'forbidden' }
  | { outcome: 'invalid' }
  | { outcome: 'limit_reached' };

export type UpdateMediaQueueItemResult =
  | { outcome: 'ok'; item: MediaQueueItem }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

export type SetMediaQueueItemStatusResult =
  | { outcome: 'ok'; item: MediaQueueItem }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

// Creator/dashboard-facing: authenticated by session, scoped to a channel
// the caller belongs to. Mirrors GiveawayTournamentStore's shape.
//
// THE ONLY WRITE SURFACE FOR THIS TABLE. There is no second store, no
// second route file and no second function anywhere that can insert a
// row into media_queue_items -- see migration 0146's own header for the
// structural proof.
export interface MediaQueueStore {
  listItems(userId: string, channelId: string, limit?: number): Promise<MediaQueueItem[]>;
  enqueueItem(userId: string, channelId: string, input: EnqueueMediaQueueItemInput): Promise<EnqueueMediaQueueItemResult>;
  updateItem(userId: string, channelId: string, itemId: string, title: string, enabled: boolean): Promise<UpdateMediaQueueItemResult>;
  setItemStatus(userId: string, channelId: string, itemId: string, status: MediaQueueItem['status']): Promise<SetMediaQueueItemStatusResult>;
}

// Overlay/browser-source-facing: authenticated by the overlay session
// bearer token, exactly like GiveawayTournamentOverlayStore /
// LobbyStatusOverlayStore. ONE METHOD. There is no write method on this
// interface and none may be added -- an overlay browser-source token can
// read the current/next projection and can never change it.
export interface MediaQueueOverlayStore {
  getForOverlay(token: string, overlayId: string): Promise<OverlayMediaQueueEntry[]>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isMediaKind(value: unknown): value is (typeof MEDIA_QUEUE_KINDS)[number] {
  return typeof value === 'string' && (MEDIA_QUEUE_KINDS as readonly string[]).includes(value);
}

function isMimeType(value: unknown): value is (typeof MEDIA_QUEUE_MIME_TYPES)[number] {
  return typeof value === 'string' && (MEDIA_QUEUE_MIME_TYPES as readonly string[]).includes(value);
}

function isHttpsUrl(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength && value.startsWith('https://');
}

function isNullableHttpsUrl(value: unknown, maxLength: number): value is string | null {
  return value === null || isHttpsUrl(value, maxLength);
}

function isNullableDuration(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MEDIA_QUEUE_DURATION_MAX_MS;
}

function isQueueSlot(value: unknown): value is 'current' | 'next' {
  return value === 'current' || value === 'next';
}

/**
 * The route's outbound narrowing for the overlay projection -- a SECOND,
 * independent projection sitting in front of whatever the store hands up,
 * not a pass-through that trusts it. Even if a store implementation were
 * changed to hand up an item id, a submitter or a queue-depth count, only
 * the seven declared fields survive this function, and any entry failing
 * validation is dropped rather than rendered.
 */
export function projectOverlayMediaQueue(value: unknown): OverlayMediaQueueEntry[] {
  if (!Array.isArray(value)) return [];
  const out: OverlayMediaQueueEntry[] = [];
  for (const raw of value) {
    const row = record(raw);
    if (!row) continue;
    if (row.schemaVersion !== 'v1') continue;
    if (!isQueueSlot(row.queueSlot)) continue;
    if (typeof row.title !== 'string' || row.title.length < 1 || row.title.length > MEDIA_QUEUE_TITLE_MAX) continue;
    if (!isMediaKind(row.mediaKind)) continue;
    if (!isMimeType(row.mimeType)) continue;
    // playbackUrl/thumbnailPlaybackUrl are the API's own server-resolved
    // origin (§19.1, migration 0148) -- re-validated https-or-null here a
    // SECOND, independent time, the same posture
    // projectOverlaySoundboardPlay takes for its own playbackUrl.
    if (!isNullableHttpsUrl(row.playbackUrl, MEDIA_QUEUE_PLAYBACK_URL_MAX)) continue;
    if (!isNullableHttpsUrl(row.thumbnailPlaybackUrl, MEDIA_QUEUE_PLAYBACK_URL_MAX)) continue;
    if (!isNullableDuration(row.durationMs)) continue;
    out.push({
      schemaVersion: 'v1',
      queueSlot: row.queueSlot,
      title: row.title,
      mediaKind: row.mediaKind,
      mimeType: row.mimeType,
      playbackUrl: row.playbackUrl as string | null,
      thumbnailPlaybackUrl: row.thumbnailPlaybackUrl as string | null,
      durationMs: row.durationMs as number | null,
    });
  }
  // §12.7 belt: at most one 'current' and at most one 'next', at most two
  // rows total, even if an upstream bug ever handed up more. The SQL
  // layer's own `limit 2` is the primary guarantee; this is the second,
  // independent one.
  const current = out.find((entry) => entry.queueSlot === 'current');
  const next = out.find((entry) => entry.queueSlot === 'next');
  return [current, next].filter((entry): entry is OverlayMediaQueueEntry => entry !== undefined);
}
