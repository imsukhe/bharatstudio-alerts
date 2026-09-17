import { createHash } from 'node:crypto';
import type {
  GiveawayTournamentOverlayStore,
  OverlayGiveawayTournament,
} from '../domain/giveaway-tournament-store.js';
import type { Sql } from 'postgres';

// PRF-02 slice 6, §6 catalogue module #17 (Giveaway / Tournament Card) --
// the overlay read half.
//
// Mirrors apps/api/src/db/lobby-status-overlay-store.ts,
// moderator-status-overlay-store.ts and stream-mission-overlay-store.ts
// exactly: sha256 fingerprint of the bearer token, matched against
// overlay_sessions.token_fingerprint INSIDE the security-definer function
// (packages/db/migrations/0142). Same overlay_sessions table, same gate --
// no second auth mechanism, and no scoping decision made in TypeScript.
//
// RT-12: this file's name contains "overlay", so the required-queries
// scan's rule 2 covers every app_private call in it regardless of the
// function's name; the factory below is constructed with `derivedReadSql`
// in apps/api/src/index.ts, so rule 3 covers it structurally as well; and
// the function follows the list_overlay_* convention, so rule 1 covers it
// too. All three independently require the manifest entry in
// packages/db/explain-plans/required-queries.json.
//
// ======================================================================
// SIX AGGREGATE VALUES. THAT IS THE WHOLE SURFACE.
// ======================================================================
// §17.1's overlay list is "entry count, time remaining, winner
// announcement with consent, and a claim flow"; §17.2 adds a standings
// module. The first two ship. The winner does NOT -- consent does not
// exist as a mechanism in this schema, a winner is a participant
// identifier on an aggregate-only path, and nothing could produce one
// anyway (the mechanic is not built; GIV-07 stays Blocked). Neither does
// the claim flow, which §17.1 requires never expose an address on stream
// and which would be a fulfilment surface BharatStudio may not have --
// the creator is the promoter and is responsible for eligibility, taxes
// and delivery.
//
// So app_private.list_overlay_giveaway_tournament returns exactly
// (entry_count, entry_closes_at, tournament_current_round,
//  tournament_total_rounds, tournament_completed_matches_in_round,
//  tournament_matches_in_round), and this file selects six columns because
// six columns are all there are.
//
// Widening this select is not possible without widening 0142's own
// `returns table` signature, which
// packages/db/tests/prf02_slice6_giveaway_tournament.sql asserts against
// directly -- twice, from pg_get_function_result and from a table
// materialised out of a live call.
//
// NEITHER RECORD'S ID IS READ HERE, and not because it was forgotten:
// neither carries information the card paints, and "a session id" is on
// the prohibited list. There is no per-viewer or per-entrant row anywhere
// in this schema for either to be joined to either, so nothing on this
// path can correlate one visit to another.
//
// ======================================================================
// THE ENTITLEMENT IS NOT CHECKED IN THIS FILE, DELIBERATELY.
// ======================================================================
// §30.3 places the Lobby and tournament engine at Creator+, and the
// owner's decision 5 makes that `tier in ('creator','studio')` OR an
// active Events Pack grant (a check with no grant path yet, so today's
// behaviour is exactly "included at Creator+"). That check is
// app_private.events_pack_entitled, which migration 0140 already ships;
// 0142 CALLS it from inside app_private.list_overlay_giveaway_tournament
// rather than reimplementing it. An unentitled channel's perfectly valid
// overlay token simply matches no row, so this file receives `undefined`
// and the module renders nothing.
//
// Putting a second copy of the tier rule in TypeScript would create two
// places for it to be wrong, and the one in SQL is the one the SQL test
// can prove.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type OverlayRow = {
  entry_count: string | number | null;
  entry_closes_at: Date | null;
  tournament_current_round: string | number | null;
  tournament_total_rounds: string | number | null;
  tournament_completed_matches_in_round: string | number | null;
  tournament_matches_in_round: string | number | null;
};

function count(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function createSqlGiveawayTournamentOverlayStore(sql: Sql): GiveawayTournamentOverlayStore {
  return {
    async getForOverlay(token, overlayId): Promise<OverlayGiveawayTournament | null> {
      const rows = await sql<OverlayRow[]>`
        select entry_count, entry_closes_at, tournament_current_round, tournament_total_rounds,
               tournament_completed_matches_in_round, tournament_matches_in_round
          from app_private.list_overlay_giveaway_tournament(${overlayId}::uuid, ${fingerprint(token)})
      `;
      const row = rows[0];
      // Zero rows is the answer for an unrecognised, expired, revoked or
      // foreign token, for a channel with neither a giveaway open nor a
      // tournament running, AND for an unentitled channel. All of them
      // mean the same thing to the card -- paint nothing -- so they are
      // collapsed to null here rather than given four shapes the renderer
      // would have to tell apart.
      if (!row) return null;
      return {
        schemaVersion: 'v1',
        entryCount: count(row.entry_count),
        entryClosesAt: row.entry_closes_at ? row.entry_closes_at.toISOString() : null,
        tournamentCurrentRound: count(row.tournament_current_round),
        tournamentTotalRounds: count(row.tournament_total_rounds),
        tournamentCompletedMatchesInRound: count(row.tournament_completed_matches_in_round),
        tournamentMatchesInRound: count(row.tournament_matches_in_round),
      };
    },
  };
}
