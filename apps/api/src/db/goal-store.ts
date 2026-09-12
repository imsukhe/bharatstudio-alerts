import type { Sql, TransactionSql } from 'postgres';
import type {
  CreateGoalInput,
  CreateGoalResult,
  GoalStore,
  GoalWindow,
  MutateGoalResult,
  SupportGoal,
  UpdateGoalInput,
} from '../domain/goal-store.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function isPgErrorWithMessage(error: unknown, substring: string): boolean {
  return error instanceof Error && error.message.includes(substring);
}

type GoalRow = {
  goal_id: string;
  title: string;
  target_amount_paise: string | number;
  goal_window: GoalWindow;
  is_public: boolean;
  progress_paise: string | number;
  reached: boolean;
  ended: boolean;
  started_at: Date;
  ended_at: Date | null;
};

function toSupportGoal(channelId: string, row: GoalRow): SupportGoal {
  return {
    schemaVersion: 'v1',
    goalId: row.goal_id,
    channelId,
    title: row.title,
    targetAmountPaise: Number(row.target_amount_paise),
    window: row.goal_window,
    isPublic: row.is_public,
    progressPaise: Number(row.progress_paise),
    reached: row.reached,
    ended: row.ended,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
  };
}

export function createSqlGoalStore(sql: Sql): GoalStore {
  return {
    async create(userId, channelId, input: CreateGoalInput): Promise<CreateGoalResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ create_support_goal: string }[]>`
          select app_private.create_support_goal(
            ${channelId}::uuid, ${input.title}, ${input.targetAmountPaise}::bigint, ${input.window}, ${input.isPublic ?? true}
          )
        `);
        const goalId = rows[0]?.create_support_goal;
        if (!goalId) return { outcome: 'invalid' };
        const created = await this.get(userId, channelId, goalId);
        if (!created) return { outcome: 'invalid' };
        return { outcome: 'created', goal: created };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'support goal limit reached')) return { outcome: 'tier_limit_reached' };
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'invalid support goal')) return { outcome: 'invalid' };
        throw error;
      }
    },

    async list(userId, channelId): Promise<SupportGoal[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<GoalRow[]>`
        select goal_id, title, target_amount_paise, goal_window, is_public, progress_paise, reached, ended, started_at, ended_at
          from app_private.list_channel_goals(${channelId}::uuid)
      `);
      return rows.map((row) => toSupportGoal(channelId, row));
    },

    async get(userId, channelId, goalId): Promise<SupportGoal | null> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<GoalRow[]>`
        select goal_id, title, target_amount_paise, goal_window, is_public, progress_paise, reached, ended, started_at, ended_at
          from app_private.get_channel_goal(${channelId}::uuid, ${goalId}::uuid)
      `);
      const row = rows[0];
      return row ? toSupportGoal(channelId, row) : null;
    },

    async update(userId, channelId, goalId, input: UpdateGoalInput): Promise<MutateGoalResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.update_support_goal(${channelId}::uuid, ${goalId}::uuid, ${input.title ?? null}, ${input.targetAmountPaise ?? null})
        `);
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'support goal not found')) return { outcome: 'not_found' };
        if (isPgErrorWithMessage(error, 'ended support goal cannot be edited')) return { outcome: 'ended' };
        if (isPgErrorWithMessage(error, 'invalid support goal')) return { outcome: 'invalid' };
        throw error;
      }
      const updated = await this.get(userId, channelId, goalId);
      return updated ? { outcome: 'ok', goal: updated } : { outcome: 'not_found' };
    },

    async end(userId, channelId, goalId): Promise<MutateGoalResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.end_support_goal(${channelId}::uuid, ${goalId}::uuid)
        `);
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'support goal not found')) return { outcome: 'not_found' };
        throw error;
      }
      const ended = await this.get(userId, channelId, goalId);
      return ended ? { outcome: 'ok', goal: ended } : { outcome: 'not_found' };
    },
  };
}
