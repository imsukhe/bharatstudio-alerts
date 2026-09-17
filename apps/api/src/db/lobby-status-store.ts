import type { Sql, TransactionSql } from 'postgres';
import type {
  CloseLobbySessionResult,
  LobbySession,
  LobbySessionStore,
  OpenLobbySessionResult,
  UpdateLobbySessionResult,
} from '../domain/lobby-status-store.js';

// PRF-02 slice 6, creator side of §6 module #16 (migration 0140).
//
// WIRED TO THE MAIN `sql` POOL, NOT `derivedReadSql`, and that is a
// deliberate structural choice, not an oversight. This file carries the
// creator WRITE paths (open/update/close) plus the creator's own read of
// the current lobby -- the same shape db/stream-mission-store.ts,
// db/goal-store.ts and db/challenge-store.ts all have, and all three are
// likewise constructed with `sql` in apps/api/src/index.ts. RT-10/RT-11's
// `derivedReadSql` is the bounded, statement-timeout-bearing pool for
// widget/dashboard/analytics DERIVED READS; putting creator writes on it
// would be wrong twice over (wrong pool for a write, and four pro-forma
// exemptions forced into
// packages/db/explain-plans/required-queries.json, which is how an
// exemption list stops being read).
//
// The overlay-facing read lives in its own file
// (db/lobby-status-overlay-store.ts) precisely so that it CAN be wired to
// `derivedReadSql` and CAN be seen by every rule of
// scan-required-queries.mjs -- see that file's own header.
//
// NO TIER CHECK EXISTS IN THIS FILE, AND NONE MAY BE ADDED (§12.6).
// Storing, viewing and changing a durable creator record is available at
// every tier. `app_private.events_pack_entitled` is called from exactly
// one place in the product -- the OVERLAY read -- because §30.3 gates
// whether the CANVAS renders the card, never whether a creator can reach
// their own lobby.
//
// THE ONLY GATE IS THE ROLE GATE, and it lives in SQL:
// app_private.has_channel_role(channel, ['owner','admin']) inside
// migration 0140's own functions. No scoping decision is made in
// TypeScript.

// Same convention as db/stream-mission-store.ts / db/goal-store.ts -- a
// deliberate small duplication across store files rather than importing
// across an ownership boundary.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

type LobbyRow = {
  lobby_id: string;
  seat_count: number;
  confirmed_seat_count: number;
  queue_count: number;
  opened_at: Date;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toLobby(row: LobbyRow): LobbySession {
  return {
    schemaVersion: 'v1',
    lobbyId: row.lobby_id,
    seatCount: Number(row.seat_count),
    confirmedSeatCount: Number(row.confirmed_seat_count),
    queueCount: Number(row.queue_count),
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

export function createSqlLobbySessionStore(sql: Sql): LobbySessionStore {
  async function readCurrent(userId: string, channelId: string): Promise<LobbySession | null> {
    // Eight columns selected, because eight columns are what the CREATOR
    // read returns. The OVERLAY read returns three, in a different
    // function, in a different file, on a different pool -- the two are
    // never the same query and never share a projection.
    const rows = await inUserTransaction(sql, userId, (tx) => tx<LobbyRow[]>`
      select lobby_id, seat_count, confirmed_seat_count, queue_count, opened_at, closed_at, created_at, updated_at
        from app_private.list_channel_lobby_session(${channelId}::uuid)
    `);
    const row = rows[0];
    return row ? toLobby(row) : null;
  }

  return {
    getCurrent: readCurrent,

    async open(userId, channelId, seatCount): Promise<OpenLobbySessionResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.open_lobby_session(${channelId}::uuid, ${seatCount}::integer)
        `);
      } catch (error) {
        // 42501 = insufficient_privilege, raised for a non-owner/admin.
        // 23505 = unique_violation, raised (explicitly, with a readable
        //         message) when a lobby is already open -- never a silent
        //         supersede, see 0140's header.
        // 22023 = invalid_parameter_value, raised for a seat count below 1.
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, '23505')) return { outcome: 'conflict' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const lobby = await readCurrent(userId, channelId);
      return lobby ? { outcome: 'ok', lobby } : { outcome: 'invalid' };
    },

    async updateCounts(userId, channelId, lobbyId, confirmedSeatCount, queueCount): Promise<UpdateLobbySessionResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.update_lobby_session_counts(
            ${channelId}::uuid, ${lobbyId}::uuid, ${confirmedSeatCount}::integer, ${queueCount}::integer
          )
        `);
      } catch (error) {
        // P0002 = no_data_found, raised for a lobby that does not exist,
        // is already closed, belongs to another channel, OR that the
        // caller is not authorised to write -- one indistinguishable
        // answer, by design (0140's header).
        // 22023 = invalid_parameter_value: a negative count, or more seats
        //         confirmed than the lobby has.
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const lobby = await readCurrent(userId, channelId);
      return lobby ? { outcome: 'ok', lobby } : { outcome: 'not_found' };
    },

    async close(userId, channelId, lobbyId): Promise<CloseLobbySessionResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.close_lobby_session(${channelId}::uuid, ${lobbyId}::uuid)
        `);
        return { outcome: 'ok' };
      } catch (error) {
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        throw error;
      }
    },
  };
}
