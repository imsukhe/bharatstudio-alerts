/*
 * Pure, DOM-free helpers for the Sponsor Card module (§6 #11) -- same
 * pattern as ./giveaway-tournament-logic.ts and
 * ./moderator-status-logic.ts: testable directly, no browser or
 * useParams context needed.
 *
 * WHAT THIS CARD IS. A sponsor name and, optionally, a logo. THE CARD
 * RENDERS THE SPONSOR AND COUNTS NOTHING (owner decision, 2026-09-17,
 * recorded in bharatstudio-requirements/reviews/
 * 2026-09-17-remaining-eight-modules-and-youtube-v1-amendment.md Part 1
 * §3). §6's original row for this module -- "scheduled placement with an
 * exposure event log" -- is superseded: the exposure log is dropped
 * outright.
 *
 * WHAT THIS FILE STRUCTURALLY CANNOT PAINT. `SponsorCardSnapshot` has
 * exactly three fields: schemaVersion, sponsorName and, paired,
 * logoMimeType/logoStorageKey. There is no field here for an impression
 * count, an exposure count, a view count, a duration, a "shown at" or
 * "displayed at" timestamp, or any other measure of display -- not
 * because this module chooses not to populate one, but because the TYPE
 * has no slot for one, proven at compile time by
 * sponsor-card-logic.test.ts and sponsor-card-module.test.ts.
 *
 * NO THIRD PARTY, EVER (§9.1.1, PRF-13). `logoStorageKey` is a
 * tenant-scoped content-addressed asset reference (channelId + sha256,
 * §19.1) -- never a URL, never an href, never anything the renderer could
 * hand to an <iframe>, a <script> or an external stylesheet. There is no
 * url/href/src field anywhere in this file, and `isSponsorCardSnapshot`
 * below rejects a payload that tries to smuggle one in under any of these
 * three field names.
 *
 * ONE ROW, NOT A LIST. Unlike the Giveaway/Tournament card's six
 * aggregate values, a sponsor card is a single always-or-never state:
 * either the server currently has something to show (a real, validated
 * snapshot) or it has nothing (`null`), and there is no partial or
 * in-between state for this module to render.
 *
 * SCHEDULING IS SERVER-SIDE, AND THIS FILE NEVER RE-DERIVES IT. Whether
 * "now" falls inside the sponsor's scheduled window is decided entirely
 * by `app_private.list_overlay_sponsor_card` (migration 0145) before the
 * snapshot ever reaches the browser -- a row is returned only when the
 * card is currently supposed to be visible. This module has no schedule
 * field to read and performs no time-window arithmetic of its own; it
 * paints exactly what the last snapshot says, which is `null` the instant
 * the window closes and the overlay re-fetches.
 */

export type SponsorCardSnapshot = {
  schemaVersion: 'v1';
  sponsorName: string;
  logoMimeType: string | null;
  logoStorageKey: string | null;
};

const KEYS = ['schemaVersion', 'sponsorName', 'logoMimeType', 'logoStorageKey'] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

function isBoundedString(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= minLength && value.length <= maxLength;
}

/**
 * Exactly the four declared keys, a valid sponsor name, and the logo pair
 * either both null or both a bounded string. `exactKeys` rejects an
 * unexpected extra field outright -- an impression count, a schedule, an
 * id, a URL -- rather than silently ignoring it, so a server that somehow
 * began returning one fails this guard instead of one careless refactor
 * later rendering it.
 */
export function isSponsorCardSnapshot(value: unknown): value is SponsorCardSnapshot {
  const row = record(value);
  if (!row || !exactKeys(row, KEYS)) return false;
  if (row.schemaVersion !== 'v1') return false;
  if (!isBoundedString(row.sponsorName, 1, 120)) return false;

  const { logoMimeType, logoStorageKey } = row;
  if (logoMimeType === null && logoStorageKey === null) return true;
  if (logoMimeType === null || logoStorageKey === null) return false; // partial pair, not a state
  return isBoundedString(logoMimeType, 1, 120) && isBoundedString(logoStorageKey, 1, 200);
}

export function hasLogo(snapshot: SponsorCardSnapshot): boolean {
  return snapshot.logoMimeType !== null && snapshot.logoStorageKey !== null;
}
