import type { Sql, TransactionSql } from 'postgres';
import type {
  CloseGiveawayResult,
  ConcludeTournamentResult,
  Giveaway,
  GiveawayTournamentStore,
  OpenGiveawayResult,
  SetTournamentProgressResult,
  StartTournamentResult,
  Tournament,
  UpdateGiveawayResult,
} from '../domain/giveaway-tournament-store.js';

// PRF-02 slice 6, creator side of §6 module #17 (migration 0142).
//
// WIRED TO THE MAIN `sql` POOL, NOT `derivedReadSql`, and that is a
// deliberate structural choice rather than an oversight -- the identical
// position db/lobby-status-store.ts, db/stream-mission-store.ts and
// db/safe-mode-store.ts occupy. This file carries the creator WRITE paths
// plus the creator's own reads of the current giveaway and tournament.
// RT-10/RT-11's `derivedReadSql` is the bounded, statement-timeout-bearing
// pool for widget/dashboard/analytics DERIVED READS; putting creator
// writes on it would be wrong twice over (wrong pool for a write, and six
// pro-forma exemptions forced into
// packages/db/explain-plans/required-queries.json, which is how an
// exemption list stops being read).
//
// The overlay-facing read lives in its own file
// (db/giveaway-tournament-overlay-store.ts) precisely so that it CAN be
// wired to `derivedReadSql` and CAN be seen by every rule of
// scan-required-queries.mjs -- see that file's own header.
//
// NO TIER CHECK EXISTS IN THIS FILE, AND NONE MAY BE ADDED (§12.6).
// `app_private.events_pack_entitled` -- which migration 0140 already ships
// and this slice CALLS rather than reimplements -- is invoked from exactly
// one place in the product: the OVERLAY read.
//
// THE ONLY GATE IS THE ROLE GATE, and it lives in SQL:
// app_private.has_channel_role(channel, ['owner','admin']) inside
// migration 0142's own functions. No scoping decision is made in
// TypeScript.
//
// NO CHANCE MECHANIC EXISTS AT THIS LAYER EITHER. There is no selection,
// no seed, no shuffle and no weighting here, because there is none in the
// schema and none in the product: §17.1 decided on 2026-09-13 that only
// free-entry and skill-based formats ship, and GIV-07 stays Blocked.

// Same convention as db/lobby-status-store.ts / db/stream-mission-store.ts
// -- a deliberate small duplication across store files rather than
// importing across an ownership boundary.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

type GiveawayRow = {
  giveaway_id: string;
  entry_count: number;
  entry_opens_at: Date;
  entry_closes_at: Date;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type TournamentRow = {
  tournament_id: string;
  lobby_session_id: string;
  field_size: number;
  current_round: number;
  total_rounds: number;
  completed_matches_in_round: number;
  matches_in_round: number;
  started_at: Date;
  concluded_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toGiveaway(row: GiveawayRow): Giveaway {
  return {
    schemaVersion: 'v1',
    giveawayId: row.giveaway_id,
    entryCount: Number(row.entry_count),
    entryOpensAt: row.entry_opens_at.toISOString(),
    entryClosesAt: row.entry_closes_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toTournament(row: TournamentRow): Tournament {
  return {
    schemaVersion: 'v1',
    tournamentId: row.tournament_id,
    lobbySessionId: row.lobby_session_id,
    fieldSize: Number(row.field_size),
    currentRound: Number(row.current_round),
    totalRounds: Number(row.total_rounds),
    completedMatchesInRound: Number(row.completed_matches_in_round),
    matchesInRound: Number(row.matches_in_round),
    startedAt: row.started_at.toISOString(),
    concludedAt: row.concluded_at ? row.concluded_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

export function createSqlGiveawayTournamentStore(sql: Sql): GiveawayTournamentStore {
  async function readGiveaway(userId: string, channelId: string): Promise<Giveaway | null> {
    const rows = await inUserTransaction(sql, userId, (tx) => tx<GiveawayRow[]>`
      select giveaway_id, entry_count, entry_opens_at, entry_closes_at, closed_at, created_at, updated_at
        from app_private.list_channel_giveaway(${channelId}::uuid)
    `);
    const row = rows[0];
    return row ? toGiveaway(row) : null;
  }

  async function readTournament(userId: string, channelId: string): Promise<Tournament | null> {
    const rows = await inUserTransaction(sql, userId, (tx) => tx<TournamentRow[]>`
      select tournament_id, lobby_session_id, field_size, current_round, total_rounds,
             completed_matches_in_round, matches_in_round, started_at, concluded_at, created_at, updated_at
        from app_private.list_channel_tournament(${channelId}::uuid)
    `);
    const row = rows[0];
    return row ? toTournament(row) : null;
  }

  return {
    getCurrentGiveaway: readGiveaway,
    getCurrentTournament: readTournament,

    async openGiveaway(userId, channelId, entryClosesAt): Promise<OpenGiveawayResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.open_giveaway(${channelId}::uuid, ${entryClosesAt}::timestamptz)
        `);
      } catch (error) {
        // 42501 = insufficient_privilege, raised for a non-owner/admin.
        // 23505 = unique_violation, raised (explicitly, with a readable
        //         message) when a giveaway is already open -- never a
        //         silent supersede, see 0142's header.
        // 22023 = invalid_parameter_value, raised for an entry window that
        //         closes in the past.
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, '23505')) return { outcome: 'conflict' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const giveaway = await readGiveaway(userId, channelId);
      return giveaway ? { outcome: 'ok', giveaway } : { outcome: 'invalid' };
    },

    async updateGiveawayEntryCount(userId, channelId, giveawayId, entryCount): Promise<UpdateGiveawayResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.update_giveaway_entry_count(
            ${channelId}::uuid, ${giveawayId}::uuid, ${entryCount}::integer
          )
        `);
      } catch (error) {
        // P0002 = no_data_found, raised for a giveaway that does not
        //         exist, is already closed, belongs to another channel, OR
        //         that the caller is not authorised to write -- one
        //         indistinguishable answer, by design.
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const giveaway = await readGiveaway(userId, channelId);
      return giveaway ? { outcome: 'ok', giveaway } : { outcome: 'not_found' };
    },

    async closeGiveaway(userId, channelId, giveawayId): Promise<CloseGiveawayResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.close_giveaway(${channelId}::uuid, ${giveawayId}::uuid)
        `);
        return { outcome: 'ok' };
      } catch (error) {
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        throw error;
      }
    },

    async startTournament(userId, channelId, lobbySessionId): Promise<StartTournamentResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.start_tournament(${channelId}::uuid, ${lobbySessionId}::uuid)
        `);
      } catch (error) {
        // P0002 here means the LOBBY could not be reached -- unknown,
        // closed, or another channel's -- which is a different answer from
        // "you may not do this" (42501) and from "that lobby cannot host a
        // single-elimination bracket" (22023).
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, '23505')) return { outcome: 'conflict' };
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const tournament = await readTournament(userId, channelId);
      return tournament ? { outcome: 'ok', tournament } : { outcome: 'invalid' };
    },

    async setTournamentProgress(
      userId, channelId, tournamentId, currentRound, completedMatchesInRound,
    ): Promise<SetTournamentProgressResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.set_tournament_progress(
            ${channelId}::uuid, ${tournamentId}::uuid, ${currentRound}::integer, ${completedMatchesInRound}::integer
          )
        `);
      } catch (error) {
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const tournament = await readTournament(userId, channelId);
      return tournament ? { outcome: 'ok', tournament } : { outcome: 'not_found' };
    },

    async concludeTournament(userId, channelId, tournamentId): Promise<ConcludeTournamentResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.conclude_tournament(${channelId}::uuid, ${tournamentId}::uuid)
        `);
        return { outcome: 'ok' };
      } catch (error) {
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        throw error;
      }
    },
  };
}
