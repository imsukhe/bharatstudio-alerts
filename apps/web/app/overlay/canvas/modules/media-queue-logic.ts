/*
 * Pure, DOM-free helpers for the Media / Meme Queue module (§6 #20) —
 * same pattern as ./lobby-status-logic.ts and
 * ./giveaway-tournament-logic.ts: testable directly, no browser or
 * useParams context needed.
 *
 * WHAT THIS CARD IS.
 *
 * The creator's own queued media — images, GIFs and short video clips —
 * shown on the overlay in the order the creator queued them. The read
 * behind it (`app_private.list_overlay_media_queue`, migration 0146)
 * returns AT MOST TWO entries, labelled "current" and "next": current is
 * what the renderer shows, next is held purely so the renderer can
 * PRELOAD the following asset before it is needed — no queue-depth
 * number, no total count, and nothing deeper in the rotation is ever
 * fetched. §12.7's Overlay row authorises "current and next alert
 * state" in those exact words, and this reuses the identical bound
 * ./support-theater-module.ts:68-72 already established for this
 * codebase rather than inventing one of its own.
 *
 * AND THE THINGS IT IS NOT.
 *
 *   1. It is NOT a viewer-facing submission surface of any kind. The
 *      owner's 2026-09-17 decision (register row MED-20) is
 *      creator-only: the creator queues their own media, and viewers
 *      cannot submit. There is no field anywhere in this file for a
 *      submitter, a viewer id, an approval state or a rejection reason —
 *      not withheld, but absent, because the type this file guards has
 *      no slot for one.
 *
 *   2. It is NOT third-party code reaching the Canvas, AND it is not an
 *      arbitrary third-party ORIGIN either (§9.1.1, §19.1 — hostile
 *      review finding fixed by migration 0148). `playbackUrl` /
 *      `thumbnailPlaybackUrl` are resolved SERVER-SIDE from a
 *      content-key fragment against the API's own configured CDN base
 *      (apps/api/src/db/media-queue-overlay-store.ts) — never a caller-
 *      or database-supplied host. Every URL this file accepts must be
 *      `https://` or `null`, and the module that consumes this file's
 *      output only ever hands them to an `<img>` or `<video>` element's
 *      `src` — never to a script, an iframe or a stylesheet. `mimeType`
 *      is a closed allow-list (image/png, image/jpeg, image/webp,
 *      image/gif, video/mp4, video/webm); there is deliberately no
 *      `text/html`, no `image/svg+xml` (SVG can carry inline script) and
 *      no `application/*` of any kind.
 *
 *   3. It is NOT a queue-depth display. There is no field here for how
 *      many items are queued behind what is shown, because the server
 *      never returns one either (see the SQL function's own header).
 *
 * "AT MOST TWO, EVER" IS NOT THIS FILE'S DOING EITHER. The overlay read
 * is declared with a `LIMIT 2` inside the SQL function itself, asserted
 * in `packages/db/tests/prf02_slice7_media_queue.sql` (MED20.2/MED20.3)
 * against both the declared result shape and a live call. The guard
 * below is a THIRD, independent line: it rejects any array longer than
 * two entries, any entry carrying a key it does not expect, and any
 * payload carrying two "current" or two "next" slots — so a server that
 * somehow began returning more would render nothing extra rather than
 * render it.
 */

export const MEDIA_QUEUE_KINDS = ['image', 'gif', 'video'] as const;
export type MediaQueueKind = (typeof MEDIA_QUEUE_KINDS)[number];

/** §9.1.1 closed allow-list. No text/html, no image/svg+xml, no application/* of any kind. */
export const MEDIA_QUEUE_MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
] as const;
export type MediaQueueMimeType = (typeof MEDIA_QUEUE_MIME_TYPES)[number];

export type MediaQueueEntry = {
  schemaVersion: 'v1';
  queueSlot: 'current' | 'next';
  title: string;
  mediaKind: MediaQueueKind;
  mimeType: MediaQueueMimeType;
  /** Server-resolved against the configured CDN base; null whenever that
   *  base is unset (migration 0148) — see file header. */
  playbackUrl: string | null;
  thumbnailPlaybackUrl: string | null;
  durationMs: number | null;
};

/** The whole snapshot: zero, one or two entries, current first when both are present. */
export type MediaQueueState = MediaQueueEntry[];

const ENTRY_KEYS = [
  'schemaVersion', 'queueSlot', 'title', 'mediaKind', 'mimeType', 'playbackUrl', 'thumbnailPlaybackUrl', 'durationMs',
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

function isMediaKind(value: unknown): value is MediaQueueKind {
  return typeof value === 'string' && (MEDIA_QUEUE_KINDS as readonly string[]).includes(value);
}

function isMimeType(value: unknown): value is MediaQueueMimeType {
  return typeof value === 'string' && (MEDIA_QUEUE_MIME_TYPES as readonly string[]).includes(value);
}

function isHttpsUrl(value: unknown, maxLength = 2048): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength && value.startsWith('https://');
}

/**
 * `playbackUrl` must be https or null. Never any other scheme — this is
 * the client's own last-line refusal of anything the server projection
 * (`projectOverlayMediaQueue`) should already have stripped, so the
 * guarantee does not rest on one layer (§9.1.1), the identical posture
 * ./safe-soundboard-logic.ts's isSafePlaybackUrl takes for its own field.
 */
function isNullableHttpsUrl(value: unknown): value is string | null {
  return value === null || isHttpsUrl(value);
}

function isNullableDuration(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Exactly the eight declared keys on one entry, every value the correct
 * shape, and the title within the reused 1-120 bound
 * (0109_v1_l17_paid_challenges.sql:67).
 */
export function isMediaQueueEntry(value: unknown): value is MediaQueueEntry {
  const row = record(value);
  if (!row || !exactKeys(row, ENTRY_KEYS)) return false;
  if (row.schemaVersion !== 'v1') return false;
  if (row.queueSlot !== 'current' && row.queueSlot !== 'next') return false;
  if (typeof row.title !== 'string' || row.title.length < 1 || row.title.length > 120) return false;
  if (!isMediaKind(row.mediaKind)) return false;
  if (!isMimeType(row.mimeType)) return false;
  if (!isNullableHttpsUrl(row.playbackUrl)) return false;
  if (!isNullableHttpsUrl(row.thumbnailPlaybackUrl)) return false;
  if (!isNullableDuration(row.durationMs)) return false;
  return true;
}

/**
 * The whole snapshot guard. AT MOST TWO entries, at most one 'current'
 * and at most one 'next' — a payload violating either shape is rejected
 * outright rather than truncated, because a server sending three items
 * or two "current" slots is evidence something upstream is wrong, and a
 * silently-truncated wrong answer is worse than an empty one.
 */
export function isMediaQueueState(value: unknown): value is MediaQueueState {
  if (!Array.isArray(value)) return false;
  if (value.length > 2) return false;
  if (!value.every(isMediaQueueEntry)) return false;
  const entries = value as MediaQueueEntry[];
  const currentCount = entries.filter((entry) => entry.queueSlot === 'current').length;
  const nextCount = entries.filter((entry) => entry.queueSlot === 'next').length;
  if (currentCount > 1 || nextCount > 1) return false;
  return true;
}

/** The item the renderer shows, or null when nothing is live. */
export function currentEntry(state: MediaQueueState): MediaQueueEntry | null {
  return state.find((entry) => entry.queueSlot === 'current') ?? null;
}

/**
 * The item held purely for PRELOADING — never rendered visibly. Null
 * when the live rotation holds only one item.
 */
export function nextEntry(state: MediaQueueState): MediaQueueEntry | null {
  return state.find((entry) => entry.queueSlot === 'next') ?? null;
}

/**
 * True when the card has something to show at all.
 *
 * An empty array is what an unrecognised, expired, revoked or foreign
 * overlay token returns, and also what a channel with nothing live in
 * rotation returns (every item played, skipped or disabled). Both mean
 * "paint nothing", and the renderer treats them identically.
 *
 * ALSO false when the current entry's `playbackUrl` is null (migration
 * 0148) -- today's honest state whenever `mediaCdnBaseUrl` is unset
 * (every environment currently), the same "cannot display until GCS/CDN
 * exists" posture ./safe-soundboard-logic.ts's caption-without-audio case
 * documents for its own module. There is nothing else this card can show
 * for a media item with no resolved URL -- unlike the soundboard's
 * caption, an image/video card has no meaningful content-free state, so
 * this renders nothing rather than a broken `<img>`/`<video>` with no
 * `src`.
 */
export function hasSomethingToShow(state: MediaQueueState): boolean {
  const live = currentEntry(state);
  return live !== null && live.playbackUrl !== null;
}
