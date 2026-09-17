/*
 * Pure, DOM-free helpers for the Lobby Status Card module (§6 #16) — same
 * pattern as ./moderator-status-logic.ts and ./reaction-cloud-logic.ts:
 * testable directly, no browser or useParams context needed.
 *
 * WHAT THIS CARD IS.
 *
 * It is the three aggregate numbers of a creator's currently open lobby
 * session: total seats, seats confirmed, and how many people are waiting.
 * §16 states the whole public surface in one sentence — the public overlay
 * shows "aggregate status only: '8/16 seats confirmed', queue count, next
 * round, and opted-in initials or avatars. Never player identifiers, never
 * Discord names, never codes or passwords."
 *
 * AND THE FOUR THINGS IT IS NOT.
 *
 *   1. It is NOT a room code or a password. §16 forbids both on the
 *      overlay in the same sentence, and neither exists anywhere in this
 *      slice's schema — there is no column for one, so there is nothing
 *      for this type to have a field for.
 *
 *   2. It is NOT a player list. There is no per-viewer row behind these
 *      numbers at all (owner decision, 2026-09-16): no waitlist table, no
 *      participant table, no seat-holder record. That is what makes
 *      "nothing correlates one visit to another" true by construction
 *      rather than by projection discipline.
 *
 *   3. It does NOT show opted-in initials or avatars. §16 permits them;
 *      the owner's decision puts them out of scope because they need an
 *      opt-in mechanism that does not exist in this schema. This module
 *      does not approximate one.
 *
 *   4. It is NOT a ready check, a seat token, a queue policy or an audit
 *      log. Those are the Lobby Engine (§16.1 steps 4–8, §16.2) and are
 *      Phase 3. The card renders from `confirmedSeatCount`; HOW a seat
 *      became confirmed never reaches the overlay.
 *
 * "NEXT ROUND" IS NOT RENDERED EITHER, AND THAT IS DELIBERATE. §16's
 * sentence lists it beside the seat and queue figures, but nothing in this
 * slice's schema produces it — there is no round, no sequence and no
 * schedule — so painting one would mean inventing a value the authority
 * names but the data does not have.
 *
 * AGGREGATES ONLY IS NOT THIS FILE'S DOING. The snapshot carries three
 * numbers because the QUERY returns three columns:
 * `app_private.list_overlay_lobby_status` (migration 0140) is declared
 * `returns table (seat_count integer, confirmed_seat_count integer,
 * queue_count integer)`, asserted in
 * `packages/db/tests/prf02_slice6_lobby_status.sql` against both the
 * declared result type and the live output. The guard below is a third
 * line — it rejects any payload carrying a key it does not expect, so a
 * server that somehow began returning a room code would render nothing
 * rather than render it.
 */

export type LobbyStatus = {
  schemaVersion: 'v1';
  seatCount: number;
  confirmedSeatCount: number;
  queueCount: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Exactly the four declared keys, three non-negative safe integers, at
 * least one seat, and never more seats confirmed than the lobby has.
 *
 * `exactKeys` is doing real work here rather than being defensive
 * boilerplate: it is what makes an unexpected extra field — a room code, a
 * password, a seat token, a player name, a Discord name, a viewer id, an
 * initials string, an avatar URL, a participant array — fail the guard
 * outright instead of being silently ignored and then, one careless
 * refactor later, rendered.
 *
 * The seat arithmetic is checked too. `0140`'s own check constraint means
 * the database cannot produce "9/8 seats confirmed", so a payload that
 * says so is evidence something upstream is wrong rather than a state to
 * paint — and a nonsense figure on a live broadcast is worse than an
 * absent card.
 */
export function isLobbyStatus(value: unknown): value is LobbyStatus {
  const row = record(value);
  if (!row || !exactKeys(row, ['schemaVersion', 'seatCount', 'confirmedSeatCount', 'queueCount'])) return false;
  if (row.schemaVersion !== 'v1') return false;
  if (!isCount(row.seatCount) || row.seatCount < 1) return false;
  if (!isCount(row.confirmedSeatCount) || !isCount(row.queueCount)) return false;
  return row.confirmedSeatCount <= row.seatCount;
}

/**
 * True when the card has something to say at all.
 *
 * A lobby that is open has something to say from the moment it opens, even
 * at 0/16 with nobody queued: "a lobby is open and it has sixteen seats"
 * is the information a viewer needs in order to join, and it is the
 * reason the card exists. That is the opposite of the Moderator Status
 * Card's rule, and deliberately so — there the zero state carries no
 * information, here it carries the invitation.
 *
 * `null` means the read did not answer: an unrecognised, expired, revoked
 * or foreign token, a channel with no open lobby, or a channel without the
 * §30.3 Creator+/Events Pack entitlement. All of those render nothing.
 */
export function hasSomethingToShow(status: LobbyStatus | null): boolean {
  return status !== null;
}

/**
 * The seat half of the label, in §16's own words and §16's own shape:
 * "8/16 seats confirmed".
 *
 * The noun is "seats" rather than "players" on purpose. A seat is a thing
 * the lobby has; a player is a person, and this card never counts people
 * by name, by initial or by avatar.
 */
export function formatSeatsLabel(status: LobbyStatus): string {
  return `${status.confirmedSeatCount}/${status.seatCount} seats confirmed`;
}

/**
 * The queue half. Singular at one, plural otherwise.
 *
 * Returns the empty string at zero rather than "0 in queue": an empty
 * queue is not news, and a permanent zero beside a live seat figure is
 * chrome. The seat half always carries the card, so there is never a state
 * where dropping this leaves nothing rendered.
 */
export function formatQueueLabel(status: LobbyStatus): string {
  if (status.queueCount === 0) return '';
  return status.queueCount === 1 ? '1 in queue' : `${status.queueCount} in queue`;
}

/**
 * The whole rendered line.
 *
 * SEATS COME FIRST because they are what §16 leads with and what a viewer
 * deciding whether to join reads first; the queue is the follow-up
 * question. The separator is a middot rather than a comma so neither half
 * reads as a subordinate clause of the other — the same separator the
 * Moderator Status Card uses, for the same reason.
 *
 * Returns the empty string when there is nothing to say, so the caller
 * writes one text node in every case rather than branching on which
 * element to clear.
 */
export function formatLobbyStatusLabel(status: LobbyStatus | null): string {
  if (!hasSomethingToShow(status)) return '';
  const lobby = status as LobbyStatus;
  const parts = [formatSeatsLabel(lobby)];
  const queue = formatQueueLabel(lobby);
  if (queue) parts.push(queue);
  return parts.join(' · ');
}

/**
 * How full the lobby is, as 0–1, for the fill bar.
 *
 * Clamped at both ends. `seatCount` is guaranteed at least 1 by the guard
 * above, so there is no divide-by-zero branch to write, and
 * `confirmedSeatCount <= seatCount` is likewise already guaranteed — the
 * clamp is belt to those braces rather than the thing making them true.
 */
export function lobbyFillRatio(status: LobbyStatus): number {
  const ratio = status.confirmedSeatCount / status.seatCount;
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return ratio >= 1 ? 1 : ratio;
}
