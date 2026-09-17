import type { Sql, TransactionSql } from 'postgres';
import type {
  CompanionGoalControlStore,
  GoalControlInput,
  GoalControlOutcome,
  IncreaseGoalTargetInput,
} from '../domain/companion-goal-control-store.js';

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

// Shared error mapping for all four control functions -- they all raise
// the same small set of messages (see migration 0162).
function mapControlError(error: unknown): GoalControlOutcome {
  if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
  if (isPgErrorWithMessage(error, 'no active Companion control session')) return { outcome: 'session_inactive' };
  if (isPgErrorWithMessage(error, 'support goal not found')) return { outcome: 'not_found' };
  if (isPgErrorWithMessage(error, 'ended support goal cannot be edited')) return { outcome: 'ended' };
  if (isPgErrorWithMessage(error, 'Companion control session is required')) return { outcome: 'invalid' };
  if (isPgErrorWithMessage(error, 'start timer only applies')) return { outcome: 'invalid' };
  if (isPgErrorWithMessage(error, 'new target must be greater')) return { outcome: 'invalid' };
  throw error;
}

export function createSqlCompanionGoalControlStore(sql: Sql): CompanionGoalControlStore {
  return {
    async increaseTarget(userId, channelId, goalId, input: IncreaseGoalTargetInput): Promise<GoalControlOutcome> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.increase_support_goal_target(
            ${channelId}::uuid, ${goalId}::uuid, ${input.sessionId}::uuid, ${input.idempotencyKey}, ${input.newTargetAmountPaise}::bigint
          )
        `);
        return { outcome: 'ok' };
      } catch (error) {
        return mapControlError(error);
      }
    },

    async startTimer(userId, channelId, goalId, input: GoalControlInput): Promise<GoalControlOutcome> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.start_support_goal_timer(${channelId}::uuid, ${goalId}::uuid, ${input.sessionId}::uuid, ${input.idempotencyKey})
        `);
        return { outcome: 'ok' };
      } catch (error) {
        return mapControlError(error);
      }
    },

    async markComplete(userId, channelId, goalId, input: GoalControlInput): Promise<GoalControlOutcome> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.manually_complete_support_goal(${channelId}::uuid, ${goalId}::uuid, ${input.sessionId}::uuid, ${input.idempotencyKey})
        `);
        return { outcome: 'ok' };
      } catch (error) {
        return mapControlError(error);
      }
    },

    async prepareCelebration(userId, channelId, goalId, input: GoalControlInput): Promise<GoalControlOutcome> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.prepare_support_goal_celebration(${channelId}::uuid, ${goalId}::uuid, ${input.sessionId}::uuid, ${input.idempotencyKey})
        `);
        return { outcome: 'ok' };
      } catch (error) {
        return mapControlError(error);
      }
    },
  };
}
