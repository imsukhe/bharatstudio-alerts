// PRF-02 slice 6, §6 catalogue module #16 (Lobby Status) and the minimum
// §16 Lobby schema behind it
// (packages/db/migrations/0140_v1_prf02_lobby_status.sql).
//
// AGGREGATES ONLY, AND THE SHAPE IS WHERE THAT IS TRUE. §16: the public
// overlay shows "aggregate status only: '8/16 seats confirmed', queue
// count ... Never player identifiers, never Discord names, never codes or
// passwords." The owner's 2026-09-16 decision 4 requires that to be a
// property of the read rather than of the renderer, so
// `app_private.list_overlay_lobby_status` returns exactly three integer
// columns and `OverlayLobbyStatus` below has exactly three number fields.
//
// There is nowhere in this file for a room code, a password, a seat token,
// a player identifier, an in-game name, a Discord name, a viewer id, an
// anonymous identity or a session id to live: not "we chose not to
// populate it", but "the field does not exist" -- and, one layer down,
// "the column does not exist either".
//
// NO LOBBY ID ON THE OVERLAY PROJECTION. It carries no information the
// card paints, and "a session id" is on the prohibited list. The CREATOR
// projection does carry one, because the creator's own write path is
// addressed rather than ambient -- a stale dashboard tab must not be able
// to write counts onto a lobby opened after it loaded.
//
// WHAT IS NOT HERE, AND IS NOT AN OMISSION. No ready check, no seat token,
// no room-code reveal, no no-show promotion, no selection policy, no audit
// log, no feedback or report option, and no temporary-lobby-data deletion.
// Those are the Lobby Engine (§16.1 steps 4-8, §16.2) and are Phase 3. The
// rule applied: if the card can render without it, it is out of scope.
//
// NO DURATION, TIMER, EXPIRY OR DEADLINE FIELD EXISTS HERE, exactly as
// none exists in the schema. `closedAt` is a RECORD of when the creator
// closed the lobby, never a schedule.

/** Creator/dashboard-facing projection of the CURRENT lobby session. */
export type LobbySession = {
  schemaVersion: 'v1';
  lobbyId: string;
  seatCount: number;
  confirmedSeatCount: number;
  queueCount: number;
  openedAt: string;
  /** When the creator closed it. Always null for a lobby returned as
   *  current -- present on the type because the store's row shape carries
   *  it, never a scheduled close. */
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Overlay/browser-source projection. Three numbers, §12.7-bounded, and no
 * identity of any kind. This is the entire public surface of §16.
 */
export type OverlayLobbyStatus = {
  schemaVersion: 'v1';
  seatCount: number;
  confirmedSeatCount: number;
  queueCount: number;
};

export type OpenLobbySessionResult =
  | { outcome: 'ok'; lobby: LobbySession }
  // A lobby is already open for this channel. Deliberately NOT a silent
  // supersede -- see 0140's header.
  | { outcome: 'conflict' }
  | { outcome: 'forbidden' }
  | { outcome: 'invalid' };

export type UpdateLobbySessionResult =
  | { outcome: 'ok'; lobby: LobbySession }
  // Not-found and not-authorised are the same answer, deliberately.
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

export type CloseLobbySessionResult =
  | { outcome: 'ok' }
  | { outcome: 'not_found' };

/**
 * PostgreSQL `integer`'s own upper bound. This is a STORAGE bound, not a
 * product bound: §16 names no maximum seat count and this codebase will
 * not invent one. It exists so a value outside the column's range is a 400
 * at the schema layer rather than a 500 from a failed cast.
 */
export const LOBBY_COUNT_MAX = 2147483647;
/** Arithmetic, not policy: a lobby with no seats cannot render a seat
 *  status. The same bound `0140`'s `seat_count >= 1` check enforces. */
export const LOBBY_SEAT_COUNT_MIN = 1;

// Creator/dashboard-facing: authenticated by session, scoped to a channel
// the caller belongs to. Mirrors StreamMissionStore's shape.
//
// NEVER TIER-GATED (§12.6). Storing, viewing and changing a durable
// creator record is available at every tier; the §30.3 Lobby Engine
// entitlement gates only whether the CANVAS renders the card, and it lives
// in the overlay read alone.
export interface LobbySessionStore {
  getCurrent(userId: string, channelId: string): Promise<LobbySession | null>;
  open(userId: string, channelId: string, seatCount: number): Promise<OpenLobbySessionResult>;
  updateCounts(
    userId: string,
    channelId: string,
    lobbyId: string,
    confirmedSeatCount: number,
    queueCount: number,
  ): Promise<UpdateLobbySessionResult>;
  close(userId: string, channelId: string, lobbyId: string): Promise<CloseLobbySessionResult>;
}

// Overlay/browser-source-facing: authenticated by the overlay session
// bearer token, exactly like StreamMissionOverlayStore /
// ModeratorStatusOverlayStore.
export interface LobbyStatusOverlayStore {
  getForOverlay(token: string, overlayId: string): Promise<OverlayLobbyStatus | null>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= LOBBY_COUNT_MAX;
}

/**
 * The route's outbound narrowing. This is a SECOND, independent projection
 * sitting in front of the store's answer, not a pass-through that trusts
 * it: even if a store implementation were changed to hand up a room code,
 * a player name or a viewer id, only the three declared numbers survive
 * this function.
 *
 * It also refuses a status that is internally inconsistent -- more seats
 * confirmed than exist, a seat count below one, a fractional or negative
 * count. A nonsense figure on a broadcast overlay is worse than an absent
 * card, and `0140`'s own check constraint means the database cannot
 * produce one, so a value that fails here is evidence something upstream
 * is wrong rather than a state to render.
 */
export function projectOverlayLobbyStatus(status: unknown): OverlayLobbyStatus | null {
  const row = record(status);
  if (!row) return null;
  if (row.schemaVersion !== 'v1') return null;
  const { seatCount, confirmedSeatCount, queueCount } = row;
  if (!isCount(seatCount) || seatCount < LOBBY_SEAT_COUNT_MIN) return null;
  if (!isCount(confirmedSeatCount) || !isCount(queueCount)) return null;
  if (confirmedSeatCount > seatCount) return null;
  return { schemaVersion: 'v1', seatCount, confirmedSeatCount, queueCount };
}
