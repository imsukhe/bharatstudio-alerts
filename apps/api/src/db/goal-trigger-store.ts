import type { Sql, TransactionSql } from 'postgres';
import type {
  AddGoalTriggerActionInput,
  AddGoalTriggerActionResult,
  AddGoalTriggerConditionInput,
  AddGoalTriggerConditionResult,
  CreateGoalTriggerRuleInput,
  CreateGoalTriggerRuleResult,
  GoalTriggerAction,
  GoalTriggerActionRun,
  GoalTriggerCondition,
  GoalTriggerRule,
  GoalTriggerStore,
  MutateGoalTriggerResult,
} from '../domain/goal-trigger-store.js';

// GOA-04/GOA-09/GOA-18/GOA-19/GOA-20/GOA-21 (migration 0158). Wired to
// the main `sql` pool, not `derivedReadSql` -- this is creator
// configuration, the same structural position db/sponsor-card-store.ts
// and db/goal-store.ts occupy, not an overlay-facing derived read.

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

type RuleRow = {
  rule_id: string;
  goal_id: string;
  trigger_type: GoalTriggerRule['triggerType'];
  enabled: boolean;
  threshold_percentage: number | null;
  threshold_amount_paise: string | number | null;
  repeat_mode: GoalTriggerRule['repeatMode'];
  created_at: Date;
  updated_at: Date;
};

function toRule(row: RuleRow): GoalTriggerRule {
  return {
    schemaVersion: 'v1',
    ruleId: row.rule_id,
    goalId: row.goal_id,
    triggerType: row.trigger_type,
    enabled: row.enabled,
    thresholdPercentage: row.threshold_percentage,
    thresholdAmountPaise: row.threshold_amount_paise === null ? null : Number(row.threshold_amount_paise),
    repeatMode: row.repeat_mode,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

type ConditionRow = {
  condition_id: string;
  condition_type: GoalTriggerCondition['conditionType'];
  condition_value: string | null;
  created_at: Date;
};

function toCondition(row: ConditionRow): GoalTriggerCondition {
  return {
    schemaVersion: 'v1',
    conditionId: row.condition_id,
    conditionType: row.condition_type,
    conditionValue: row.condition_value,
    createdAt: row.created_at.toISOString(),
  };
}

type ActionRow = {
  action_id: string;
  step_order: number;
  delay_ms: number;
  action_type: GoalTriggerAction['actionType'];
  fire_mode: GoalTriggerAction['fireMode'];
  created_at: Date;
  updated_at: Date;
};

function toAction(row: ActionRow): GoalTriggerAction {
  return {
    schemaVersion: 'v1',
    actionId: row.action_id,
    stepOrder: row.step_order,
    delayMs: row.delay_ms,
    actionType: row.action_type,
    fireMode: row.fire_mode,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

type ActionRunRow = {
  run_id: string;
  action_id: string;
  step_order: number;
  delay_ms: number;
  status: GoalTriggerActionRun['status'];
  blocked_reason: string | null;
  created_at: Date;
};

function toActionRun(row: ActionRunRow): GoalTriggerActionRun {
  return {
    schemaVersion: 'v1',
    runId: row.run_id,
    actionId: row.action_id,
    stepOrder: row.step_order,
    delayMs: row.delay_ms,
    status: row.status,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at.toISOString(),
  };
}

export function createSqlGoalTriggerStore(sql: Sql): GoalTriggerStore {
  return {
    async createRule(userId, channelId, goalId, input: CreateGoalTriggerRuleInput): Promise<CreateGoalTriggerRuleResult> {
      let ruleId: string;
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ create_goal_trigger_rule: string }[]>`
          select app_private.create_goal_trigger_rule(
            ${channelId}::uuid, ${goalId}::uuid, ${input.triggerType},
            ${input.thresholdPercentage}, ${input.thresholdAmountPaise}, ${input.repeatMode}
          ) as create_goal_trigger_rule
        `);
        ruleId = rows[0]!.create_goal_trigger_rule;
      } catch (error) {
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }

      const rows = await inUserTransaction(sql, userId, (tx) => tx<RuleRow[]>`
        select rule_id, goal_id, trigger_type, enabled, threshold_percentage, threshold_amount_paise, repeat_mode, created_at, updated_at
          from app_private.list_channel_goal_trigger_rules(${channelId}::uuid, ${goalId}::uuid)
         where rule_id = ${ruleId}::uuid
      `);
      const row = rows[0];
      return row ? { outcome: 'ok', rule: toRule(row) } : { outcome: 'invalid' };
    },

    async listRules(userId, channelId, goalId): Promise<GoalTriggerRule[] | null> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<RuleRow[]>`
          select rule_id, goal_id, trigger_type, enabled, threshold_percentage, threshold_amount_paise, repeat_mode, created_at, updated_at
            from app_private.list_channel_goal_trigger_rules(${channelId}::uuid, ${goalId}::uuid)
        `);
        return rows.map(toRule);
      } catch (error) {
        if (isPgErrorWithCode(error, '42501')) return null;
        throw error;
      }
    },

    async setRuleEnabled(userId, channelId, ruleId, enabled): Promise<MutateGoalTriggerResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.set_goal_trigger_rule_enabled(${channelId}::uuid, ${ruleId}::uuid, ${enabled})
        `);
      } catch (error) {
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        throw error;
      }
      return { outcome: 'ok' };
    },

    async addCondition(userId, channelId, ruleId, input: AddGoalTriggerConditionInput): Promise<AddGoalTriggerConditionResult> {
      let conditionId: string;
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ add_goal_trigger_condition: string }[]>`
          select app_private.add_goal_trigger_condition(
            ${channelId}::uuid, ${ruleId}::uuid, ${input.conditionType}, ${input.conditionValue}
          ) as add_goal_trigger_condition
        `);
        conditionId = rows[0]!.add_goal_trigger_condition;
      } catch (error) {
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }

      const rows = await inUserTransaction(sql, userId, (tx) => tx<ConditionRow[]>`
        select condition_id, condition_type, condition_value, created_at
          from app_private.list_goal_trigger_conditions(${channelId}::uuid, ${ruleId}::uuid)
         where condition_id = ${conditionId}::uuid
      `);
      const row = rows[0];
      return row ? { outcome: 'ok', condition: toCondition(row) } : { outcome: 'invalid' };
    },

    async listConditions(userId, channelId, ruleId): Promise<GoalTriggerCondition[] | null> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<ConditionRow[]>`
          select condition_id, condition_type, condition_value, created_at
            from app_private.list_goal_trigger_conditions(${channelId}::uuid, ${ruleId}::uuid)
        `);
        return rows.map(toCondition);
      } catch (error) {
        if (isPgErrorWithCode(error, '42501') || isPgErrorWithCode(error, 'P0002')) return null;
        throw error;
      }
    },

    async addAction(userId, channelId, ruleId, input: AddGoalTriggerActionInput): Promise<AddGoalTriggerActionResult> {
      let actionId: string;
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ add_goal_trigger_action: string }[]>`
          select app_private.add_goal_trigger_action(
            ${channelId}::uuid, ${ruleId}::uuid, ${input.stepOrder}, ${input.delayMs}, ${input.actionType}, ${input.fireMode}
          ) as add_goal_trigger_action
        `);
        actionId = rows[0]!.add_goal_trigger_action;
      } catch (error) {
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        if (isPgErrorWithCode(error, '22023') || isPgErrorWithCode(error, '23505') || isPgErrorWithCode(error, '23514')) return { outcome: 'invalid' };
        throw error;
      }

      const rows = await inUserTransaction(sql, userId, (tx) => tx<ActionRow[]>`
        select action_id, step_order, delay_ms, action_type, fire_mode, created_at, updated_at
          from app_private.list_goal_trigger_actions(${channelId}::uuid, ${ruleId}::uuid)
         where action_id = ${actionId}::uuid
      `);
      const row = rows[0];
      return row ? { outcome: 'ok', action: toAction(row) } : { outcome: 'invalid' };
    },

    async listActions(userId, channelId, ruleId): Promise<GoalTriggerAction[] | null> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<ActionRow[]>`
          select action_id, step_order, delay_ms, action_type, fire_mode, created_at, updated_at
            from app_private.list_goal_trigger_actions(${channelId}::uuid, ${ruleId}::uuid)
        `);
        return rows.map(toAction);
      } catch (error) {
        if (isPgErrorWithCode(error, '42501') || isPgErrorWithCode(error, 'P0002')) return null;
        throw error;
      }
    },

    async listActionRuns(userId, channelId, evaluationId): Promise<GoalTriggerActionRun[] | null> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<ActionRunRow[]>`
          select run_id, action_id, step_order, delay_ms, status, blocked_reason, created_at
            from app_private.list_goal_trigger_action_runs(${channelId}::uuid, ${evaluationId}::uuid)
        `);
        return rows.map(toActionRun);
      } catch (error) {
        if (isPgErrorWithCode(error, '42501') || isPgErrorWithCode(error, 'P0002')) return null;
        throw error;
      }
    },
  };
}
