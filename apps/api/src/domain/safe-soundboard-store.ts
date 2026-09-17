// PRF-02 slice 7, §6 catalogue module #6 (Safe Soundboard Alert), and the
// minimum §18 schema behind it (packages/db/migrations/0143).
//
// THE NAME DESCRIBES THE PLAYBACK, NOT THE CONTENT. No type, field or
// error message in this file may claim a clip is "safe", "approved",
// "checked", "reviewed", "vetted" or "curated" -- see 0143's own header,
// and the 2026-09-17 decision it implements
// (bharatstudio-requirements/reviews/
// 2026-09-17-remaining-eight-modules-and-youtube-v1-amendment.md Part 1
// §1). A creator's own upload is usable the instant it is created; there
// is no `status`, `moderationState` or `reviewedAt` field anywhere here.
//
// TWO SOURCES: a first-party catalogue BharatStudio authors
// (`SoundboardCatalogueEntry`) and a creator's own uploads
// (`SoundboardUpload`). Both are METADATA ONLY (§19.1: GCS/CDN, Postgres
// never holds bytes) -- neither type carries a byte payload, and
// `gcsObjectKey` is a content-addressed key fragment the API server
// resolves against its OWN configured CDN base, never a caller-supplied
// URL (§9.1.1).
//
// DURATION/BYTE-SIZE CAPS ARE CONFIGURED BUT UNSET (no decided value
// exists anywhere in this repository). `UploadSoundboardClipInput`
// carries no cap of its own; the caps are read from server config and
// passed into the store as `maxDurationSeconds`/`maxByteSize`, both
// `number | undefined`. Unset means the upload path is INERT -- see
// `UploadSoundboardClipResult`'s `'caps_not_configured'` outcome -- never
// "unlimited".
//
// NO COOLDOWN, NO SUPPORTER-TRIGGER PATH. See 0143's header for both: no
// cooldown value is decided anywhere in this repository, and the
// 2026-09-17 decision authorises sourcing + the no-review-upload rule
// only, not a new payment-attached trigger surface (that is AUD-03,
// separately tracked and NOT built here).

export type SoundboardCatalogueEntry = {
  schemaVersion: 'v1';
  id: string;
  externalKey: string;
  displayName: string;
  category: string;
  minTier: 'free' | 'pro' | 'creator' | 'studio';
  byteSize: number;
  durationSeconds: number;
  /** Presence-based per-channel disable, resolved. True unless the
   *  creator has turned this entry off for their own channel. */
  enabled: boolean;
  updatedAt: string;
};

export type SoundboardUpload = {
  schemaVersion: 'v1';
  id: string;
  displayName: string;
  byteSize: number;
  durationSeconds: number;
  uploadedAt: string;
};

/**
 * Overlay/browser-source projection of the single most recent creator-
 * triggered play. §12.7-bounded: seven fields, no identity of any kind.
 * See 0143's `list_overlay_soundboard_play` -- this is its entire public
 * surface.
 *
 * `playId` is an opaque event id used ONLY so the overlay client can
 * de-duplicate a repeat poll of the same trigger; it is never a viewer,
 * supporter or session identifier, and none of those exist in this
 * schema for a future read to start returning.
 */
export type OverlaySoundboardPlay = {
  schemaVersion: 'v1';
  playId: string;
  clipKind: 'catalogue' | 'upload';
  displayName: string;
  /** Resolved by the API layer from `gcsObjectKey` + the configured CDN
   *  base (§19.1). Null when no CDN base is configured -- see
   *  db/safe-soundboard-overlay-store.ts -- which today is always,
   *  because none has been decided. */
  playbackUrl: string | null;
  mimeType: string;
  durationSeconds: number;
  triggeredAt: string;
};

export type ToggleSoundboardCatalogueResult =
  | { outcome: 'ok'; entries: SoundboardCatalogueEntry[] }
  | { outcome: 'forbidden' }
  | { outcome: 'invalid' };

export type UploadSoundboardClipInput = {
  displayName: string;
  contentSha256: string;
  mimeType: string;
  byteSize: number;
  durationSeconds: number;
  rightsAttested: boolean;
};

export type UploadSoundboardClipResult =
  | { outcome: 'ok'; upload: SoundboardUpload }
  | { outcome: 'forbidden' }
  // See header: unset caps make the whole upload path inert, on purpose.
  | { outcome: 'caps_not_configured' }
  | { outcome: 'rights_not_attested' }
  | { outcome: 'cap_exceeded' }
  | { outcome: 'tier_limit_reached' }
  | { outcome: 'conflict' }
  | { outcome: 'invalid' };

export type TriggerSoundboardPlaySource =
  | { catalogueEntryId: string; uploadId?: undefined }
  | { catalogueEntryId?: undefined; uploadId: string };

export type TriggerSoundboardPlayResult =
  | { outcome: 'ok'; playId: string }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

// Creator/dashboard-facing: authenticated by session, scoped to a channel
// the caller belongs to. NEVER TIER-GATED (§12.6): storing, viewing,
// enabling/disabling and uploading a creator's own durable record is
// available at every tier -- what §30.3 gates is the CANVAS rendering the
// card, and that lives only in `SafeSoundboardOverlayStore`.
export interface SafeSoundboardStore {
  listCatalogue(userId: string, channelId: string): Promise<SoundboardCatalogueEntry[]>;
  setCatalogueEntryEnabled(
    userId: string,
    channelId: string,
    entryId: string,
    enabled: boolean,
  ): Promise<ToggleSoundboardCatalogueResult>;

  listUploads(userId: string, channelId: string): Promise<SoundboardUpload[]>;
  uploadClip(
    userId: string,
    channelId: string,
    input: UploadSoundboardClipInput,
    caps: { maxDurationSeconds?: number; maxByteSize?: number },
  ): Promise<UploadSoundboardClipResult>;

  triggerPlay(
    userId: string,
    channelId: string,
    source: TriggerSoundboardPlaySource,
  ): Promise<TriggerSoundboardPlayResult>;
}

// Overlay/browser-source-facing: authenticated by the overlay session
// bearer token, exactly like every other Master Canvas card's overlay
// store.
export interface SafeSoundboardOverlayStore {
  getForOverlay(token: string, overlayId: string): Promise<OverlaySoundboardPlay | null>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isNonEmptyString(value: unknown, maxLength = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The route's outbound narrowing for the overlay projection -- a SECOND,
 * independent projection in front of whatever the store hands up, exactly
 * as `projectOverlayGiveawayTournament` and `projectModeratorStatus` are
 * for their own modules. Even a store implementation changed to hand up a
 * viewer id or a raw URL to a third-party host gets none of it past this
 * function: `playbackUrl`, if present, is re-validated as coming from the
 * API's OWN origin shape (no scheme other than https, and never validated
 * against a caller-supplied allow-list -- see
 * db/safe-soundboard-overlay-store.ts for where it is actually built).
 */
export function projectOverlaySoundboardPlay(value: unknown): OverlaySoundboardPlay | null {
  const row = record(value);
  if (!row) return null;
  if (row.schemaVersion !== 'v1') return null;

  const { playId, clipKind, displayName, playbackUrl, mimeType, durationSeconds, triggeredAt } = row;

  if (!isNonEmptyString(playId, 64)) return null;
  if (clipKind !== 'catalogue' && clipKind !== 'upload') return null;
  if (!isNonEmptyString(displayName, 120)) return null;
  if (playbackUrl !== null) {
    if (typeof playbackUrl !== 'string' || playbackUrl.length > 2048) return null;
    try {
      if (new URL(playbackUrl).protocol !== 'https:') return null;
    } catch {
      return null;
    }
  }
  if (!isNonEmptyString(mimeType, 100) || !mimeType.startsWith('audio/')) return null;
  if (!isPositiveInt(durationSeconds)) return null;
  if (typeof triggeredAt !== 'string' || triggeredAt.length > 64 || Number.isNaN(Date.parse(triggeredAt))) return null;

  return {
    schemaVersion: 'v1',
    playId,
    clipKind,
    displayName,
    playbackUrl: playbackUrl as string | null,
    mimeType,
    durationSeconds,
    triggeredAt,
  };
}
