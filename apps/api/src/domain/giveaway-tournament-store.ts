// PRF-02 slice 6, §6 catalogue module #17 (Giveaway / Tournament Card) and
// the minimum §17 schema behind it
// (packages/db/migrations/0142_v1_prf02_giveaway_tournament.sql).
//
// AGGREGATE STATE ONLY, AND THE SHAPE IS WHERE THAT IS TRUE. §17.1's
// overlay list is "entry count, time remaining, winner announcement with
// consent, and a claim flow"; §17.2 adds a standings module. Two of those
// are buildable and the rest are not -- see below -- so
// `app_private.list_overlay_giveaway_tournament` returns exactly six
// aggregate values and `OverlayGiveawayTournament` has exactly six fields.
//
// There is nowhere in this file for a participant identifier, an in-game
// name, a Discord name, a viewer id, an anonymous identity, a session id,
// a postal address or a contact detail to live: not "we chose not to
// populate it", but "the field does not exist" -- and, one layer down,
// "the column does not exist either".
//
// ======================================================================
// THERE IS NO WINNER FIELD, AND THAT IS THE CORRECT CONCLUSION.
// ======================================================================
// §17.1 permits a winner announcement only WITH CONSENT, and no consent
// mechanism exists anywhere in this schema. A winner would also be a
// participant identifier on an aggregate-only path, and nothing here could
// produce one in the first place: the mechanic is not built (§17.1's
// decision of 2026-09-13, plus GIV-07, which stays Blocked), and "the
// creator records who won" is an invented product surface the owner's
// 2026-09-16 decision names outright. So the card shows no winner, there
// is no terminal tournament state to render, and this file has no field
// for either.
//
// ======================================================================
// NO CHANCE MECHANIC, AND NO PRIZE CUSTODY.
// ======================================================================
// No draw, seed, odds, weighting, shuffle or selection of any kind exists
// at any layer of this slice. And BharatStudio never holds, escrows, ships
// or guarantees a prize (§17.1) -- the creator is the promoter and is
// responsible for eligibility, taxes and delivery -- so there is no prize,
// custody, fulfilment, delivery, address or claim field here either.
//
// NEVER A PAID ENTRY. That holds by construction rather than by policy:
// there is no entry path in this slice at all. `entryCount` is a number
// the creator reports, exactly as module #16's seat and queue counts are,
// so there is nothing for a payment to gate.
//
// ======================================================================
// THE BRACKET IS PROGRESS, NOT A TREE, AND THE TREE IS NOT BUILT.
// ======================================================================
// A bracket tree is a diagram of who plays whom and is meaningless without
// participant labels, which §16 already ruled need an opt-in mechanism
// that does not exist. So this carries the round the tournament is in, how
// many rounds there are, and how many of the current round's matches are
// done -- true, complete, and needing no label at all. Single elimination
// only: §30.3 places double elimination, round robin and points tables at
// Studio, and this slice has one entitlement gate rather than two.
//
// THE BRACKET SHAPE IS NOT STORED ANYWHERE. `tournamentTotalRounds` and
// `tournamentMatchesInRound` are derived at read time from the referenced
// `lobby_sessions.seat_count` -- §17.2's "built on the Lobby Engine rather
// than beside it" as a fact about the schema.

/** Creator/dashboard-facing projection of the CURRENT giveaway. */
export type Giveaway = {
  schemaVersion: 'v1';
  giveawayId: string;
  entryCount: number;
  /** §17.1's entry window. `entryOpensAt` is recorded when the creator
   *  opened it; `entryClosesAt` is the instant the creator supplied. */
  entryOpensAt: string;
  entryClosesAt: string;
  /** When the creator closed it. Always null for a giveaway returned as
   *  current. Never a scheduled close, and never a result. */
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Creator/dashboard-facing projection of the CURRENT tournament. */
export type Tournament = {
  schemaVersion: 'v1';
  tournamentId: string;
  /** §17.2's dependency, surfaced so the creator's own tooling can see
   *  which lobby the bracket is running on. Never on the overlay
   *  projection. */
  lobbySessionId: string;
  /** The referenced lobby's seat count, read rather than stored. */
  fieldSize: number;
  currentRound: number;
  totalRounds: number;
  completedMatchesInRound: number;
  matchesInRound: number;
  startedAt: string;
  concludedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Overlay/browser-source projection. Six aggregate values, §12.7-bounded,
 * and no identity of any kind. This is the entire public surface of §17 in
 * this slice.
 *
 * Either half may be absent; the absent half is null rather than
 * fabricated.
 */
export type OverlayGiveawayTournament = {
  schemaVersion: 'v1';
  entryCount: number | null;
  entryClosesAt: string | null;
  tournamentCurrentRound: number | null;
  tournamentTotalRounds: number | null;
  tournamentCompletedMatchesInRound: number | null;
  tournamentMatchesInRound: number | null;
};

export type OpenGiveawayResult =
  | { outcome: 'ok'; giveaway: Giveaway }
  // A giveaway is already open for this channel. Deliberately NOT a silent
  // supersede -- see 0142's header.
  | { outcome: 'conflict' }
  | { outcome: 'forbidden' }
  | { outcome: 'invalid' };

export type UpdateGiveawayResult =
  | { outcome: 'ok'; giveaway: Giveaway }
  // Not-found and not-authorised are the same answer, deliberately.
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

export type CloseGiveawayResult =
  | { outcome: 'ok' }
  | { outcome: 'not_found' };

export type StartTournamentResult =
  | { outcome: 'ok'; tournament: Tournament }
  | { outcome: 'conflict' }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

export type SetTournamentProgressResult =
  | { outcome: 'ok'; tournament: Tournament }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

export type ConcludeTournamentResult =
  | { outcome: 'ok' }
  | { outcome: 'not_found' };

/**
 * PostgreSQL `integer`'s own upper bound. A STORAGE bound, not a product
 * bound: §17 names no maximum entry count and this codebase will not
 * invent one. It exists so a value outside the column's range is a 400 at
 * the schema layer rather than a 500 from a failed cast.
 */
export const GIVEAWAY_COUNT_MAX = 2147483647;

/**
 * §30.3's `Tournaments — single elim, up to 8` gives the ceiling; `log2(8)`
 * gives the round count. Neither number was chosen here.
 */
export const TOURNAMENT_MAX_ROUNDS = 3;
/** `8 / 2` — the largest any round can be at the maximum field of 8. */
export const TOURNAMENT_MAX_MATCHES_IN_ROUND = 4;

// Creator/dashboard-facing: authenticated by session, scoped to a channel
// the caller belongs to. Mirrors LobbySessionStore's shape.
//
// NEVER TIER-GATED (§12.6). Storing, viewing and changing a durable
// creator record is available at every tier; the §30.3 entitlement gates
// only whether the CANVAS renders the card, and it lives in the overlay
// read alone -- as `app_private.events_pack_entitled`, which migration
// 0140 already ships and this slice CALLS rather than reimplements.
export interface GiveawayTournamentStore {
  getCurrentGiveaway(userId: string, channelId: string): Promise<Giveaway | null>;
  openGiveaway(userId: string, channelId: string, entryClosesAt: string): Promise<OpenGiveawayResult>;
  updateGiveawayEntryCount(
    userId: string,
    channelId: string,
    giveawayId: string,
    entryCount: number,
  ): Promise<UpdateGiveawayResult>;
  closeGiveaway(userId: string, channelId: string, giveawayId: string): Promise<CloseGiveawayResult>;

  getCurrentTournament(userId: string, channelId: string): Promise<Tournament | null>;
  startTournament(userId: string, channelId: string, lobbySessionId: string): Promise<StartTournamentResult>;
  setTournamentProgress(
    userId: string,
    channelId: string,
    tournamentId: string,
    currentRound: number,
    completedMatchesInRound: number,
  ): Promise<SetTournamentProgressResult>;
  concludeTournament(userId: string, channelId: string, tournamentId: string): Promise<ConcludeTournamentResult>;
}

// Overlay/browser-source-facing: authenticated by the overlay session
// bearer token, exactly like LobbyStatusOverlayStore /
// StreamMissionOverlayStore.
export interface GiveawayTournamentOverlayStore {
  getForOverlay(token: string, overlayId: string): Promise<OverlayGiveawayTournament | null>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isNullableCount(value: unknown, max = GIVEAWAY_COUNT_MAX): value is number | null {
  if (value === null) return true;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function isNullableInstant(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

/**
 * The route's outbound narrowing. This is a SECOND, independent projection
 * sitting in front of the store's answer, not a pass-through that trusts
 * it: even if a store implementation were changed to hand up a participant
 * name, a viewer id or a winner, only the six declared aggregate values
 * survive this function.
 *
 * It also refuses a payload that is internally inconsistent -- a bracket
 * whose round is past its own last round, more matches complete than the
 * round holds, a fractional count, a half-present tournament. `0142`'s own
 * constraints mean the database cannot produce one, so a value that fails
 * here is evidence something upstream is wrong rather than a state to
 * render, and a nonsense figure on a live broadcast is worse than an
 * absent card.
 *
 * A row where BOTH halves are absent is also rejected: the database never
 * returns one (the read requires at least one live half), and an all-null
 * card is indistinguishable from no card, so it is simpler for the
 * renderer to receive null.
 */
export function projectOverlayGiveawayTournament(value: unknown): OverlayGiveawayTournament | null {
  const row = record(value);
  if (!row) return null;
  if (row.schemaVersion !== 'v1') return null;

  const {
    entryCount, entryClosesAt,
    tournamentCurrentRound, tournamentTotalRounds,
    tournamentCompletedMatchesInRound, tournamentMatchesInRound,
  } = row;

  if (!isNullableCount(entryCount) || !isNullableInstant(entryClosesAt)) return null;
  // The giveaway half is all-or-nothing: an entry count without a window,
  // or a window without a count, is a partial row rather than a state.
  if ((entryCount === null) !== (entryClosesAt === null)) return null;

  if (!isNullableCount(tournamentCurrentRound, TOURNAMENT_MAX_ROUNDS)) return null;
  if (!isNullableCount(tournamentTotalRounds, TOURNAMENT_MAX_ROUNDS)) return null;
  if (!isNullableCount(tournamentCompletedMatchesInRound, TOURNAMENT_MAX_MATCHES_IN_ROUND)) return null;
  if (!isNullableCount(tournamentMatchesInRound, TOURNAMENT_MAX_MATCHES_IN_ROUND)) return null;

  const tournamentFields = [
    tournamentCurrentRound, tournamentTotalRounds,
    tournamentCompletedMatchesInRound, tournamentMatchesInRound,
  ];
  const presentTournamentFields = tournamentFields.filter((field) => field !== null).length;
  if (presentTournamentFields !== 0 && presentTournamentFields !== tournamentFields.length) return null;

  const hasTournament = presentTournamentFields === tournamentFields.length;
  if (hasTournament) {
    const round = tournamentCurrentRound as number;
    const total = tournamentTotalRounds as number;
    const done = tournamentCompletedMatchesInRound as number;
    const held = tournamentMatchesInRound as number;
    if (round < 1 || total < 1 || held < 1) return null;
    if (round > total) return null;
    if (done > held) return null;
  }

  if (entryCount === null && !hasTournament) return null;

  return {
    schemaVersion: 'v1',
    entryCount: entryCount as number | null,
    entryClosesAt: entryClosesAt as string | null,
    tournamentCurrentRound: tournamentCurrentRound as number | null,
    tournamentTotalRounds: tournamentTotalRounds as number | null,
    tournamentCompletedMatchesInRound: tournamentCompletedMatchesInRound as number | null,
    tournamentMatchesInRound: tournamentMatchesInRound as number | null,
  };
}
