/*
 * Pure, DOM-free helpers for the Giveaway / Tournament Card module
 * (§6 #17) — same pattern as ./lobby-status-logic.ts and
 * ./moderator-status-logic.ts: testable directly, no browser or useParams
 * context needed.
 *
 * WHAT THIS CARD IS.
 *
 * Two aggregate lines. The giveaway line is how many entries a creator has
 * reported and how long the published entry window has left. The
 * tournament line is which round the bracket is in, how many rounds there
 * are, and how many of the current round's matches are done. §17.1's
 * overlay list is "entry count, time remaining, winner announcement with
 * consent, and a claim flow"; §17.2 adds a standings module.
 *
 * AND THE FIVE THINGS IT IS NOT.
 *
 *   1. It is NOT a winner announcement, and it never can be in this
 *      slice. §17.1 permits one only WITH CONSENT, and no consent
 *      mechanism exists anywhere in this schema. A winner is also a
 *      participant identifier on an aggregate-only path. And nothing
 *      could produce one: the mechanic is not built (§17.1's decision of
 *      2026-09-13, plus GIV-07, which stays Blocked), and "the creator
 *      records who won" is an invented surface the owner's 2026-09-16
 *      decision names outright. There is no winner field in this type, no
 *      element for one in the renderer, and no column behind one.
 *
 *   2. It is NOT a claim flow. §17.1 requires a claim flow never expose an
 *      address on stream. The safest version of that rule is the one
 *      taken here: no claim surface exists at all.
 *
 *   3. It is NOT a prize. BharatStudio never holds, escrows, ships or
 *      guarantees one (§17.1) — the creator is the promoter and is
 *      responsible for eligibility, taxes and delivery — so nothing here
 *      describes, values, tracks or promises an item.
 *
 *   4. It is NOT an entrant list. There is no per-entrant row behind the
 *      entry count at all: no entrant table, no participant table. That
 *      is what makes "nothing correlates one visit to another" true by
 *      construction rather than by projection discipline. There is no
 *      entry path either, so there is nothing a payment could gate —
 *      §17.1's "never a paid-only entry" holds by construction.
 *
 *   5. It is NOT a bracket TREE. A tree is a diagram of who plays whom and
 *      is meaningless without participant labels, which §16 already ruled
 *      need an opt-in mechanism that does not exist. The tree is not
 *      built and no display-name concept was invented to make it
 *      buildable. Bracket PROGRESS is what ships, and it needs no label.
 *
 * SINGLE ELIMINATION ONLY. §30.3 places double elimination, round robin
 * and points tables at Studio while single elimination up to 8 is
 * Creator+; this slice has one entitlement gate rather than two, so it
 * ships the Creator+ form. The whole bracket shape is arithmetic on the
 * field size, so nothing had to be chosen.
 *
 * AGGREGATES ONLY IS NOT THIS FILE'S DOING. The snapshot carries six
 * values because the QUERY returns six columns:
 * `app_private.list_overlay_giveaway_tournament` (migration 0142) is
 * declared with exactly those, asserted in
 * `packages/db/tests/prf02_slice6_giveaway_tournament.sql` against both
 * the declared result type and the live output. The guard below is a third
 * line — it rejects any payload carrying a key it does not expect, so a
 * server that somehow began returning a winner would render nothing rather
 * than render it.
 *
 * THE COUNTDOWN IS COMPUTED FROM THE VIEWER'S CLOCK, AND THAT COST IS
 * STATED RATHER THAN HIDDEN. The read returns the window's close INSTANT,
 * not a seconds-remaining figure, because a smooth countdown off a
 * seconds figure would need either a per-second server read (which §12.7
 * forbids) or a local clock anchor that drifts the same way. A browser
 * whose clock is wrong will show a countdown that is wrong by the same
 * amount. The alternative — refetching every second — is the thing §12.7
 * exists to prevent.
 */

export type GiveawayTournamentState = {
  schemaVersion: 'v1';
  entryCount: number | null;
  entryClosesAt: string | null;
  tournamentCurrentRound: number | null;
  tournamentTotalRounds: number | null;
  tournamentCompletedMatchesInRound: number | null;
  tournamentMatchesInRound: number | null;
};

const KEYS = [
  'schemaVersion',
  'entryCount',
  'entryClosesAt',
  'tournamentCurrentRound',
  'tournamentTotalRounds',
  'tournamentCompletedMatchesInRound',
  'tournamentMatchesInRound',
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

function isNullableCount(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableInstant(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

/**
 * Exactly the seven declared keys, and every value either null or a
 * non-negative safe integer / parseable instant, with each half
 * all-or-nothing and the bracket arithmetic internally consistent.
 *
 * `exactKeys` is doing real work here rather than being defensive
 * boilerplate: it is what makes an unexpected extra field — a winner, a
 * participant array, a player name, a Discord name, a viewer id, a prize,
 * a shipping address, a claim URL, a seed — fail the guard outright
 * instead of being silently ignored and then, one careless refactor later,
 * rendered.
 *
 * The bracket arithmetic is checked too. `0142`'s own constraints mean the
 * database cannot produce "round 4 of 3" or "3 of 2 matches complete", so
 * a payload that says so is evidence something upstream is wrong rather
 * than a state to paint — and a nonsense figure on a live broadcast is
 * worse than an absent card.
 */
export function isGiveawayTournamentState(value: unknown): value is GiveawayTournamentState {
  const row = record(value);
  if (!row || !exactKeys(row, KEYS)) return false;
  if (row.schemaVersion !== 'v1') return false;

  if (!isNullableCount(row.entryCount) || !isNullableInstant(row.entryClosesAt)) return false;
  if ((row.entryCount === null) !== (row.entryClosesAt === null)) return false;

  const bracket = [
    row.tournamentCurrentRound, row.tournamentTotalRounds,
    row.tournamentCompletedMatchesInRound, row.tournamentMatchesInRound,
  ];
  if (!bracket.every(isNullableCount)) return false;
  const present = bracket.filter((field) => field !== null).length;
  if (present !== 0 && present !== bracket.length) return false;

  if (present === bracket.length) {
    const round = row.tournamentCurrentRound as number;
    const total = row.tournamentTotalRounds as number;
    const done = row.tournamentCompletedMatchesInRound as number;
    const held = row.tournamentMatchesInRound as number;
    if (round < 1 || total < 1 || held < 1) return false;
    if (round > total || done > held) return false;
  }

  // Both halves absent is not a card. The read never returns such a row.
  return row.entryCount !== null || present === bracket.length;
}

export function hasGiveaway(state: GiveawayTournamentState): boolean {
  return state.entryCount !== null && state.entryClosesAt !== null;
}

export function hasTournament(state: GiveawayTournamentState): boolean {
  return state.tournamentCurrentRound !== null
    && state.tournamentTotalRounds !== null
    && state.tournamentCompletedMatchesInRound !== null
    && state.tournamentMatchesInRound !== null;
}

/**
 * True when the card has something to say at all.
 *
 * `null` means the read did not answer: an unrecognised, expired, revoked
 * or foreign token, a channel with neither a giveaway open nor a
 * tournament running, or a channel without the §30.3 Creator+/Events Pack
 * entitlement. All of those render nothing, and so does a concluded
 * tournament — there is deliberately no terminal state, because a terminal
 * label on a bracket is a winner announcement with the name left out.
 */
export function hasSomethingToShow(state: GiveawayTournamentState | null): boolean {
  return state !== null;
}

/**
 * The entry half of the giveaway line.
 *
 * Zero is rendered as an invitation rather than as a zero: "a giveaway is
 * open and nobody has entered yet" is exactly the state a viewer can act
 * on, which is why this card shows from the moment it opens.
 */
export function formatEntriesLabel(state: GiveawayTournamentState): string {
  const entries = state.entryCount;
  if (entries === null) return '';
  if (entries === 0) return 'No entries yet';
  return entries === 1 ? '1 entry' : `${String(entries)} entries`;
}

/**
 * Seconds left in the published entry window, clamped at zero. Computed
 * from the viewer's clock — see this file's header for why, and for what
 * that costs.
 */
export function secondsRemaining(state: GiveawayTournamentState, nowMs: number): number | null {
  if (state.entryClosesAt === null) return null;
  const closesMs = Date.parse(state.entryClosesAt);
  if (Number.isNaN(closesMs)) return null;
  const remaining = Math.floor((closesMs - nowMs) / 1000);
  return remaining > 0 ? remaining : 0;
}

/** `m:ss` under an hour, `h:mm:ss` above it. */
export function formatDuration(totalSeconds: number): string {
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => (value < 10 ? `0${String(value)}` : String(value));
  if (hours > 0) return `${String(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${String(minutes)}:${pad(seconds)}`;
}

/**
 * The time half of the giveaway line.
 *
 * Once the window has elapsed this says the window has closed and nothing
 * more. That is a statement about the ENTRY WINDOW — a fact the creator
 * published up front — and deliberately not a statement about an outcome:
 * no result exists, none can be produced, and none may be implied.
 */
export function formatTimeRemainingLabel(state: GiveawayTournamentState, nowMs: number): string {
  const remaining = secondsRemaining(state, nowMs);
  if (remaining === null) return '';
  if (remaining === 0) return 'entry closed';
  return `closes in ${formatDuration(remaining)}`;
}

/** The whole giveaway line, or the empty string when there is no giveaway. */
export function formatGiveawayLine(state: GiveawayTournamentState, nowMs: number): string {
  if (!hasGiveaway(state)) return '';
  const parts = [formatEntriesLabel(state), formatTimeRemainingLabel(state, nowMs)].filter((part) => part !== '');
  return parts.join(' · ');
}

/**
 * The whole tournament line, or the empty string when there is no
 * tournament.
 *
 * "Round 2 of 3 · 1 of 2 matches complete". Both halves are counts of
 * MATCHES and ROUNDS, never of people: this card counts fixtures, and it
 * never counts anyone by name, by initial or by avatar.
 *
 * The separator is a middot rather than a comma so neither half reads as a
 * subordinate clause of the other — the same separator the Lobby Status
 * and Moderator Status cards use, for the same reason.
 */
export function formatTournamentLine(state: GiveawayTournamentState): string {
  if (!hasTournament(state)) return '';
  const round = state.tournamentCurrentRound as number;
  const total = state.tournamentTotalRounds as number;
  const done = state.tournamentCompletedMatchesInRound as number;
  const held = state.tournamentMatchesInRound as number;
  return `Round ${String(round)} of ${String(total)} · ${String(done)} of ${String(held)} matches complete`;
}

/**
 * How far through the current round the bracket is, as 0–1, for the fill
 * bar.
 *
 * Clamped at both ends. `tournamentMatchesInRound` is guaranteed at least
 * 1 by the guard above, so there is no divide-by-zero branch to write, and
 * `done <= held` is likewise already guaranteed — the clamp is belt to
 * those braces rather than the thing making them true.
 */
export function tournamentFillRatio(state: GiveawayTournamentState): number {
  if (!hasTournament(state)) return 0;
  const ratio = (state.tournamentCompletedMatchesInRound as number) / (state.tournamentMatchesInRound as number);
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return ratio >= 1 ? 1 : ratio;
}
