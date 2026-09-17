/*
 * Pure, DOM-free helpers for the Safe Soundboard Alert module (§6 #6) —
 * same pattern as ./giveaway-tournament-logic.ts and
 * ./lobby-status-logic.ts: testable directly, no browser or useParams
 * context needed.
 *
 * THE NAME IS ABOUT THE BROADCAST, NOT THE CONTENT. "Safe Soundboard
 * Alert" describes playback being safe for a live broadcast — no
 * arbitrary code, no arbitrary URL, no arbitrary embed reaching the
 * Master Canvas (§9.1.1) — never that a clip's CONTENT has been vetted.
 * Nothing in this file, and nothing in any UI copy built on top of it,
 * may claim a clip is "safe", "approved", "checked", "reviewed",
 * "vetted" or "curated" (2026-09-17 decision).
 *
 * WHAT THIS CARD IS: a transient "now playing" caption for the single
 * most recent creator-triggered clip, shown while it plays and then
 * hidden. `app_private.list_overlay_soundboard_play` (migration 0143)
 * returns the most recent trigger, not a queue — this module treats a
 * repeated poll of the SAME playId as a no-op (see `isNewPlay`) rather
 * than replaying it, which is how "the queue is latest-supersedes, not a
 * never-drop FIFO" (0143's own header) becomes true on the client too.
 *
 * AGGREGATES-STYLE NARROWING, APPLIED TO A SINGLE RECORD. The read
 * returns seven columns; the API route narrows a second time
 * (`projectOverlaySoundboardPlay`); `isOverlaySoundboardPlay` here
 * rejects any payload carrying a key it does not expect OR an insecure
 * playbackUrl. Three independent narrowings, so the guarantee does not
 * rest on any one of them holding.
 *
 * NO COOLDOWN, NO QUEUE DEPTH LIMIT INVENTED HERE. No cooldown value is
 * decided anywhere in this repository (0143's header), so none is
 * enforced client-side either — a rapid run of triggers simply shows the
 * most recent one each poll, which is the accepted trade-off, stated
 * rather than hidden.
 */

export type OverlaySoundboardPlay = {
  schemaVersion: 'v1';
  playId: string;
  clipKind: 'catalogue' | 'upload';
  displayName: string;
  playbackUrl: string | null;
  mimeType: string;
  durationSeconds: number;
  triggeredAt: string;
};

const KEYS = [
  'schemaVersion', 'playId', 'clipKind', 'displayName', 'playbackUrl', 'mimeType', 'durationSeconds', 'triggeredAt',
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * `playbackUrl` must be https or null. Never any other scheme — this is
 * the client's own last-line refusal of anything the server projection
 * (`projectOverlaySoundboardPlay`) should already have stripped, so the
 * guarantee does not rest on one layer (§9.1.1).
 */
function isSafePlaybackUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function isOverlaySoundboardPlay(value: unknown): value is OverlaySoundboardPlay {
  const row = record(value);
  if (!row || !exactKeys(row, KEYS)) return false;
  if (row.schemaVersion !== 'v1') return false;
  if (!isNonEmptyString(row.playId, 64)) return false;
  if (row.clipKind !== 'catalogue' && row.clipKind !== 'upload') return false;
  if (!isNonEmptyString(row.displayName, 120)) return false;
  if (!isSafePlaybackUrl(row.playbackUrl)) return false;
  if (!isNonEmptyString(row.mimeType, 100) || !row.mimeType.startsWith('audio/')) return false;
  if (typeof row.durationSeconds !== 'number' || !Number.isSafeInteger(row.durationSeconds) || row.durationSeconds <= 0) return false;
  if (typeof row.triggeredAt !== 'string' || row.triggeredAt.length > 64 || Number.isNaN(Date.parse(row.triggeredAt))) return false;
  return true;
}

/** A fetched snapshot is a NEW trigger only when its playId differs from
 *  the last one this module already played — see file header. `null` for
 *  `lastPlayedId` means "nothing played yet in this activation". */
export function isNewPlay(play: OverlaySoundboardPlay | null, lastPlayedId: string | null): play is OverlaySoundboardPlay {
  return play !== null && play.playId !== lastPlayedId;
}

/** "🔊 Air Horn" — the whole caption. No clip length, no source, and no
 *  claim about the clip's content — only the creator-supplied label. */
export function formatNowPlayingLabel(play: OverlaySoundboardPlay): string {
  return `\u{1F50A} ${play.displayName}`;
}
