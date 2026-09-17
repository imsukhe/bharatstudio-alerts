import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration,
  formatEntriesLabel,
  formatGiveawayLine,
  formatTimeRemainingLabel,
  formatTournamentLine,
  hasGiveaway,
  hasSomethingToShow,
  hasTournament,
  isGiveawayTournamentState,
  secondsRemaining,
  tournamentFillRatio,
  type GiveawayTournamentState,
} from './giveaway-tournament-logic';

/*
 * §6 catalogue module #17 (Giveaway / Tournament Card) — the pure logic's
 * own cases.
 *
 * The cases that carry a recorded product decision rather than a
 * mechanical requirement are the NEGATIVE ones, and each is asserted in
 * both directions so the decision cannot quietly rot into "it happens to
 * work":
 *
 *   * a payload carrying a WINNER is refused outright. §17.1 permits an
 *     announcement only WITH CONSENT, no consent mechanism exists in this
 *     schema, a winner is a participant identifier on an aggregate-only
 *     path, and nothing could produce one (the mechanic is not built —
 *     §17.1's decision of 2026-09-13 — and GIV-07 stays Blocked).
 *   * a payload carrying a PRIZE, an ESCROW flag, an ADDRESS or a CLAIM
 *     link is refused. BharatStudio never holds, escrows, ships or
 *     guarantees a prize; the creator is the promoter.
 *   * a payload carrying a SEED, ODDS or a WEIGHTING is refused. No chance
 *     mechanic of any kind ships.
 *   * a payload carrying a PARTICIPANT in any shape is refused.
 */

const both: GiveawayTournamentState = {
  schemaVersion: 'v1',
  entryCount: 143,
  entryClosesAt: '2026-09-17T10:30:00.000Z',
  tournamentCurrentRound: 2,
  tournamentTotalRounds: 3,
  tournamentCompletedMatchesInRound: 1,
  tournamentMatchesInRound: 2,
};

const giveawayOnly: GiveawayTournamentState = {
  ...both,
  tournamentCurrentRound: null,
  tournamentTotalRounds: null,
  tournamentCompletedMatchesInRound: null,
  tournamentMatchesInRound: null,
};

const tournamentOnly: GiveawayTournamentState = {
  ...both,
  entryCount: null,
  entryClosesAt: null,
};

const windowOpensAtMs = Date.parse('2026-09-17T10:00:00.000Z');

test('the guard accepts exactly the seven declared keys', () => {
  assert.equal(isGiveawayTournamentState(both), true);
  assert.equal(isGiveawayTournamentState(giveawayOnly), true);
  assert.equal(isGiveawayTournamentState(tournamentOnly), true);
  assert.equal(isGiveawayTournamentState(null), false);
  assert.equal(isGiveawayTournamentState('nope'), false);
  assert.equal(isGiveawayTournamentState([both]), false);
  assert.equal(isGiveawayTournamentState({ ...both, schemaVersion: 'v2' }), false);
});

test('the guard refuses a winner, a prize, a chance mechanic and a participant in every shape', () => {
  for (const extra of [
    // No winner: consent does not exist, a winner is an identifier, and
    // nothing in this slice could produce one.
    { winner: 'Riya' }, { winnerUserId: '00000000-0000-4000-8000-0000000000a1' },
    { winnerAnnouncedAt: '2026-09-17T10:31:00.000Z' }, { champion: 'Riya' },
    // No prize custody, escrow, fulfilment, address or claim.
    { prize: 'A gaming mouse' }, { prizeValuePaise: 450000 }, { escrowHeld: true },
    { shippingAddress: '12 MG Road' }, { courier: 'BlueDart' }, { claimUrl: 'https://example.invalid' },
    { deliveredAt: '2026-09-18T00:00:00.000Z' },
    // No chance mechanic of any kind.
    { seed: 'abc123' }, { odds: 2 }, { weighting: 'supporter' }, { drawMethod: 'seeded' },
    // No participant, in any shape this codebase has one.
    { participants: [{ name: 'Riya' }] }, { entrants: ['Riya'] }, { playerName: 'Riya' },
    { inGameName: 'RIYA_OP' }, { discordName: 'riya#1234' },
    { viewerId: '00000000-0000-4000-8000-0000000000a2' }, { anonymousId: 'anon_1' },
    { initials: 'RS' }, { avatarUrl: 'https://example.invalid/a.png' },
    // No entry fee: there is no entry path at all for one to gate.
    { entryFeePaise: 5000 },
    // Not even a harmless-looking identifier.
    { giveawayId: '00000000-0000-4000-8000-000000005a51' },
  ]) {
    assert.equal(
      isGiveawayTournamentState({ ...both, ...extra }),
      false,
      `${Object.keys(extra)[0]} must fail the guard rather than be silently ignored`,
    );
  }
});

test('the guard refuses arithmetic the database cannot produce', () => {
  assert.equal(isGiveawayTournamentState({ ...both, entryCount: -1 }), false);
  assert.equal(isGiveawayTournamentState({ ...both, entryCount: 1.5 }), false);
  assert.equal(isGiveawayTournamentState({ ...both, entryClosesAt: 'not a date' }), false);
  // Round 4 of 3 is impossible; so is 3 of 2 matches complete.
  assert.equal(isGiveawayTournamentState({ ...both, tournamentCurrentRound: 4 }), false);
  assert.equal(isGiveawayTournamentState({ ...both, tournamentCompletedMatchesInRound: 3 }), false);
  assert.equal(isGiveawayTournamentState({ ...both, tournamentMatchesInRound: 0 }), false);
  // Half a giveaway and half a bracket are partial rows, not states.
  assert.equal(isGiveawayTournamentState({ ...both, entryClosesAt: null }), false);
  assert.equal(isGiveawayTournamentState({ ...both, tournamentTotalRounds: null }), false);
  // Both halves absent is not a card; the read never returns such a row.
  assert.equal(isGiveawayTournamentState({
    schemaVersion: 'v1', entryCount: null, entryClosesAt: null,
    tournamentCurrentRound: null, tournamentTotalRounds: null,
    tournamentCompletedMatchesInRound: null, tournamentMatchesInRound: null,
  }), false);
});

test('each half is detected independently', () => {
  assert.equal(hasGiveaway(both), true);
  assert.equal(hasTournament(both), true);
  assert.equal(hasGiveaway(tournamentOnly), false);
  assert.equal(hasTournament(giveawayOnly), false);
  assert.equal(hasSomethingToShow(null), false);
  assert.equal(hasSomethingToShow(giveawayOnly), true);
});

test('zero entries is an invitation, not a zero', () => {
  // The card shows from the moment a giveaway opens: "a giveaway is open
  // and it closes in thirty minutes" is exactly the state a viewer can act
  // on. That is the opposite of the Moderator Status Card's zero rule, and
  // deliberately so.
  assert.equal(formatEntriesLabel({ ...giveawayOnly, entryCount: 0 }), 'No entries yet');
  assert.equal(formatEntriesLabel({ ...giveawayOnly, entryCount: 1 }), '1 entry');
  assert.equal(formatEntriesLabel({ ...giveawayOnly, entryCount: 143 }), '143 entries');
  assert.equal(formatEntriesLabel(tournamentOnly), '');
});

test('the countdown is computed against the supplied clock and clamps at zero', () => {
  assert.equal(secondsRemaining(giveawayOnly, windowOpensAtMs), 1800);
  assert.equal(secondsRemaining(giveawayOnly, windowOpensAtMs + 1_800_000), 0);
  assert.equal(secondsRemaining(giveawayOnly, windowOpensAtMs + 9_999_999), 0);
  assert.equal(secondsRemaining(tournamentOnly, windowOpensAtMs), null);
});

test('durations read m:ss under an hour and h:mm:ss above it', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(9), '0:09');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(1800), '30:00');
  assert.equal(formatDuration(3600), '1:00:00');
  assert.equal(formatDuration(3725), '1:02:05');
});

test('an elapsed window says the ENTRY WINDOW closed, and never anything about an outcome', () => {
  // This is a statement about a window the creator published up front. It
  // is deliberately not a statement about a result: no result exists, none
  // can be produced, and none may be implied.
  assert.equal(formatTimeRemainingLabel(giveawayOnly, windowOpensAtMs), 'closes in 30:00');
  assert.equal(formatTimeRemainingLabel(giveawayOnly, windowOpensAtMs + 1_800_000), 'entry closed');
  const closed = formatTimeRemainingLabel(giveawayOnly, windowOpensAtMs + 1_800_000);
  for (const forbidden of ['winner', 'won', 'champion', 'prize', 'claim', 'result']) {
    assert.equal(closed.toLowerCase().includes(forbidden), false, `"${forbidden}" must never appear in the closed-window copy`);
  }
});

test('the giveaway line joins the entry count and the countdown', () => {
  assert.equal(formatGiveawayLine(both, windowOpensAtMs), '143 entries · closes in 30:00');
  assert.equal(formatGiveawayLine({ ...giveawayOnly, entryCount: 0 }, windowOpensAtMs), 'No entries yet · closes in 30:00');
  assert.equal(formatGiveawayLine(tournamentOnly, windowOpensAtMs), '');
});

test('the tournament line is bracket PROGRESS and counts fixtures, never people', () => {
  assert.equal(formatTournamentLine(both), 'Round 2 of 3 · 1 of 2 matches complete');
  assert.equal(formatTournamentLine({ ...tournamentOnly, tournamentCurrentRound: 1, tournamentCompletedMatchesInRound: 0, tournamentMatchesInRound: 4 }), 'Round 1 of 3 · 0 of 4 matches complete');
  assert.equal(formatTournamentLine(giveawayOnly), '');
  // A bracket TREE is not built: it needs participant labels, which §16
  // ruled need an opt-in mechanism that does not exist. Nothing this line
  // can produce names anyone.
  for (const forbidden of ['vs', 'winner', 'seed', 'player', 'team']) {
    assert.equal(formatTournamentLine(both).toLowerCase().includes(forbidden), false, `"${forbidden}" must never appear in the bracket line`);
  }
});

test('the fill ratio is the current round, clamped at both ends', () => {
  assert.equal(tournamentFillRatio(both), 0.5);
  assert.equal(tournamentFillRatio({ ...tournamentOnly, tournamentCompletedMatchesInRound: 0, tournamentMatchesInRound: 4 }), 0);
  assert.equal(tournamentFillRatio({ ...tournamentOnly, tournamentCompletedMatchesInRound: 1, tournamentMatchesInRound: 1, tournamentCurrentRound: 3 }), 1);
  assert.equal(tournamentFillRatio(giveawayOnly), 0);
});
