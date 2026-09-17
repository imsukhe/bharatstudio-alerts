import type { Sql, TransactionSql } from 'postgres';
import type {
  CreateGoalInput,
  CreateGoalResult,
  GetGoalCompletionResult,
  GoalCompletion,
  GoalStore,
  GoalWindow,
  MutateGoalResult,
  ReopenGoalCompletionInput,
  ReopenGoalCompletionResult,
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

type GoalCompletionRow = {
  goal_id: string;
  completed: boolean;
  completed_at: Date | null;
  completed_progress_paise: string | number | null;
  target_amount_paise_at_completion: string | number | null;
  progress_paise: string | number;
  target_amount_paise: string | number;
  last_reopened_at: Date | null;
  last_reopened_by_user_id: string | null;
  last_reopen_reason: string | null;
};

function toGoalCompletion(row: GoalCompletionRow): GoalCompletion {
  return {
    schemaVersion: 'v1',
    goalId: row.goal_id,
    completed: row.completed,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    completedProgressPaise: row.completed_progress_paise === null ? null : Number(row.completed_progress_paise),
    targetAmountPaiseAtCompletion: row.target_amount_paise_at_completion === null ? null : Number(row.target_amount_paise_at_completion),
    progressPaise: Number(row.progress_paise),
    targetAmountPaise: Number(row.target_amount_paise),
    lastReopenedAt: row.last_reopened_at ? row.last_reopened_at.toISOString() : null,
    lastReopenedByUserId: row.last_reopened_by_user_id,
    lastReopenReason: row.last_reopen_reason,
  };
}

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

    // GOA-01/GOA-02: app_private.get_channel_goal_completion (0150)
    // opportunistically latches (writes goal_completed once, idempotently)
    // before reading, so this always returns the current, up-to-date
    // completion state. "not found" and "not authorized" are the same
    // P0002 answer on the SQL side (same shape 0135's end_stream_mission
    // uses), which is why this method has no separate 'forbidden' outcome.
    async getCompletion(userId, channelId, goalId): Promise<GetGoalCompletionResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<GoalCompletionRow[]>`
          select goal_id, completed, completed_at, completed_progress_paise, target_amount_paise_at_completion,
                 progress_paise, target_amount_paise, last_reopened_at, last_reopened_by_user_id, last_reopen_reason
            from app_private.get_channel_goal_completion(${channelId}::uuid, ${goalId}::uuid)
        `);
        const row = rows[0];
        return row ? { outcome: 'ok', completion: toGoalCompletion(row) } : { outcome: 'not_found' };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'support goal not found')) return { outcome: 'not_found' };
        throw error;
      }
    },

    // GOA-03: manual reopen — explicit, reason-required, audited.
    // app_private.reopen_support_goal_completion (0150) never fires as a
    // side effect of anything else; this is the only call site.
    async reopenCompletion(userId, channelId, goalId, input: ReopenGoalCompletionInput): Promise<ReopenGoalCompletionResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.reopen_support_goal_completion(${channelId}::uuid, ${goalId}::uuid, ${input.reason})
        `);
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'support goal not found')) return { outcome: 'not_found' };
        if (isPgErrorWithMessage(error, 'support goal is not completed')) return { outcome: 'not_completed' };
        if (isPgErrorWithMessage(error, 'a reopen reason is required')) return { outcome: 'invalid' };
        throw error;
      }
      const result = await this.getCompletion(userId, channelId, goalId);
      return result.outcome === 'ok' ? { outcome: 'ok', completion: result.completion } : { outcome: 'not_found' };
    },
  };
}
