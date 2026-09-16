import type { Sql, TransactionSql } from 'postgres';
import type {
  EndStreamMissionResult,
  StartStreamMissionResult,
  StreamMission,
  StreamMissionStore,
} from '../domain/stream-mission-store.js';

// PRF-02 slice 5, creator side of §6 module #9 (migration 0135).
//
// WIRED TO THE MAIN `sql` POOL, NOT `derivedReadSql`, and that is a
// deliberate structural choice, not an oversight. This file carries the
// creator WRITE path (start/end) plus the creator's own read of the
// current mission -- the same shape goal-store.ts, challenge-store.ts and
// master-canvas-sql-store.ts's creator half all have, and all three are
// likewise constructed with `sql` in apps/api/src/index.ts. RT-10/RT-11's
// `derivedReadSql` is the bounded, statement-timeout-bearing pool for
// widget/dashboard/analytics DERIVED READS; putting creator writes on it
// would be wrong twice over (wrong pool for a write, and three pro-forma
// exemptions forced into packages/db/explain-plans/required-queries.json,
// which is how an exemption list stops being read).
//
// The overlay-facing read lives in its own file
// (db/stream-mission-overlay-store.ts) precisely so that it CAN be wired
// to `derivedReadSql` and CAN be seen by every rule of
// scan-required-queries.mjs -- see that file's own header.

// Same convention as db/master-canvas-sql-store.ts / db/goal-store.ts -- a
// deliberate small duplication across store files rather than importing
// across an ownership boundary.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

type MissionRow = {
  mission_id: string;
  objective: string;
  started_at: Date;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toMission(row: MissionRow): StreamMission {
  return {
    schemaVersion: 'v1',
    missionId: row.mission_id,
    objective: row.objective,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

export function createSqlStreamMissionStore(sql: Sql): StreamMissionStore {
  async function readCurrent(userId: string, channelId: string): Promise<StreamMission | null> {
    const rows = await inUserTransaction(sql, userId, (tx) => tx<MissionRow[]>`
      select mission_id, objective, started_at, ended_at, created_at, updated_at
        from app_private.list_channel_stream_mission(${channelId}::uuid)
    `);
    const row = rows[0];
    return row ? toMission(row) : null;
  }

  return {
    getCurrent: readCurrent,

    async start(userId, channelId, objective): Promise<StartStreamMissionResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx<{ start_stream_mission: string }[]>`
          select app_private.start_stream_mission(${channelId}::uuid, ${objective})
        `);
      } catch (error) {
        // 42501 = insufficient_privilege, raised for a non-owner/admin.
        // 23505 = unique_violation, raised (explicitly, with a readable
        //         message) when a mission is already running -- never a
        //         silent supersede, see 0135's header.
        // 22023 = invalid_parameter_value, raised for an objective outside
        //         the 1-120 bound.
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, '23505')) return { outcome: 'conflict' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const mission = await readCurrent(userId, channelId);
      return mission ? { outcome: 'ok', mission } : { outcome: 'invalid' };
    },

    async end(userId, channelId, missionId): Promise<EndStreamMissionResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.end_stream_mission(${channelId}::uuid, ${missionId}::uuid)
        `);
        return { outcome: 'ok' };
      } catch (error) {
        // P0002 = no_data_found, raised for a mission that does not exist,
        // is already ended, belongs to another channel, OR that the caller
        // is not authorised to end -- one indistinguishable answer, by
        // design (0135's header).
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        throw error;
      }
    },
  };
}
