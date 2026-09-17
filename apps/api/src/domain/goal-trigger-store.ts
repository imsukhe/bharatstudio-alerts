// GOA-04/GOA-09/GOA-18/GOA-19/GOA-20/GOA-21: the goal trigger engine
// SPINE (migration 0158). Creator-facing configuration surface only --
// evaluation (app_private.evaluate_goal_trigger_rule) and dispatch
// (app_private.dispatch_goal_trigger_sequence) are system/event-driven
// entry points with no HTTP route of their own in this slice (see the
// migration's own header: live wiring into the payment/refund path is
// explicitly out of scope for this spine). This file's write surface is
// therefore: create a rule, enable/disable it, attach conditions,
// attach an ordered sequence of actions. Its read surface additionally
// includes listing the action runs a system-driven dispatch already
// produced, for a creator to inspect what fired, was prepared, or was
// blocked and why.
//
// GOA-10..GOA-17 (the real action catalogue) are NOT implemented here.
// actionType is restricted to three no-op values that exist purely to
// exercise sequencing, the interlock and the prepare/fire default (see
// migration 0158's own header).

export type GoalTriggerType = 'reached_100' | 'threshold_percentage' | 'threshold_absolute' | 'first_contribution';
export type GoalTriggerRepeatMode = 'once_per_stream' | 'every_time';
export type GoalTriggerConditionType = 'only_live' | 'named_scene' | 'not_in_clutch' | 'not_during_sponsor_slot';
export type GoalTriggerActionType = 'noop_local_quiet' | 'noop_local_loud_or_fullscreen' | 'noop_outbound';
export type GoalTriggerFireMode = 'prepare' | 'fire';
export type GoalTriggerActionRunStatus = 'prepared' | 'fired' | 'blocked_interlock' | 'blocked_condition';

export const GOAL_TRIGGER_TYPES: readonly GoalTriggerType[] = ['reached_100', 'threshold_percentage', 'threshold_absolute', 'first_contribution'];
export const GOAL_TRIGGER_REPEAT_MODES: readonly GoalTriggerRepeatMode[] = ['once_per_stream', 'every_time'];
export const GOAL_TRIGGER_CONDITION_TYPES: readonly GoalTriggerConditionType[] = ['only_live', 'named_scene', 'not_in_clutch', 'not_during_sponsor_slot'];
export const GOAL_TRIGGER_ACTION_TYPES: readonly GoalTriggerActionType[] = ['noop_local_quiet', 'noop_local_loud_or_fullscreen', 'noop_outbound'];
export const GOAL_TRIGGER_FIRE_MODES: readonly GoalTriggerFireMode[] = ['prepare', 'fire'];

export type GoalTriggerRule = {
  schemaVersion: 'v1';
  ruleId: string;
  goalId: string;
  triggerType: GoalTriggerType;
  enabled: boolean;
  /** Set only for triggerType = 'threshold_percentage'. */
  thresholdPercentage: number | null;
  /** Set only for triggerType = 'threshold_absolute'. */
  thresholdAmountPaise: number | null;
  repeatMode: GoalTriggerRepeatMode;
  createdAt: string;
  updatedAt: string;
};

export type GoalTriggerCondition = {
  schemaVersion: 'v1';
  conditionId: string;
  conditionType: GoalTriggerConditionType;
  /** Set only for conditionType = 'named_scene'. */
  conditionValue: string | null;
  createdAt: string;
};

export type GoalTriggerAction = {
  schemaVersion: 'v1';
  actionId: string;
  /** GOA-18: explicit order, not row/insertion order. */
  stepOrder: number;
  /** GOA-18: explicit per-step delay, milliseconds. */
  delayMs: number;
  actionType: GoalTriggerActionType;
  /** GOA-21: defaults to 'prepare'. An outbound actionType can never be
   *  'fire' -- rejected both here (isValidFireModeForActionType) and by
   *  a database CHECK constraint that references the same classification. */
  fireMode: GoalTriggerFireMode;
  createdAt: string;
  updatedAt: string;
};

export type GoalTriggerActionRun = {
  schemaVersion: 'v1';
  runId: string;
  actionId: string;
  stepOrder: number;
  delayMs: number;
  status: GoalTriggerActionRunStatus;
  blockedReason: string | null;
  createdAt: string;
};

export type CreateGoalTriggerRuleInput = {
  triggerType: GoalTriggerType;
  thresholdPercentage: number | null;
  thresholdAmountPaise: number | null;
  repeatMode: GoalTriggerRepeatMode;
};

export type AddGoalTriggerConditionInput = {
  conditionType: GoalTriggerConditionType;
  conditionValue: string | null;
};

export type AddGoalTriggerActionInput = {
  stepOrder: number;
  delayMs: number;
  actionType: GoalTriggerActionType;
  /** null relies on the database default ('prepare') -- see GOA-21. */
  fireMode: GoalTriggerFireMode | null;
};

export type CreateGoalTriggerRuleResult =
  | { outcome: 'ok'; rule: GoalTriggerRule }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

export type MutateGoalTriggerResult =
  | { outcome: 'ok' }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' };

export type AddGoalTriggerConditionResult =
  | { outcome: 'ok'; condition: GoalTriggerCondition }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

export type AddGoalTriggerActionResult =
  | { outcome: 'ok'; action: GoalTriggerAction }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

/** GOA-04's threshold coupling, re-checked client-side of the database:
 *  exactly one threshold field is set, and only for the trigger type
 *  that uses it. Mirrors migration 0158's own CHECK constraint. */
export function isValidThresholdCoupling(
  triggerType: GoalTriggerType,
  thresholdPercentage: number | null,
  thresholdAmountPaise: number | null,
): boolean {
  if (triggerType === 'threshold_percentage') {
    return typeof thresholdPercentage === 'number' && Number.isInteger(thresholdPercentage)
      && thresholdPercentage >= 1 && thresholdPercentage <= 100 && thresholdAmountPaise === null;
  }
  if (triggerType === 'threshold_absolute') {
    return typeof thresholdAmountPaise === 'number' && Number.isSafeInteger(thresholdAmountPaise)
      && thresholdAmountPaise > 0 && thresholdPercentage === null;
  }
  return thresholdPercentage === null && thresholdAmountPaise === null;
}

/** GOA-19: named_scene is the only condition type carrying a value. */
export function isValidConditionValueCoupling(conditionType: GoalTriggerConditionType, conditionValue: string | null): boolean {
  if (conditionType === 'named_scene') {
    return typeof conditionValue === 'string' && conditionValue.length >= 1 && conditionValue.length <= 120;
  }
  return conditionValue === null;
}

/** GOA-21, STRUCTURAL half at the API layer: an outbound/public
 *  actionType may never be requested with fireMode = 'fire'. The
 *  database CHECK constraint (migration 0158) is the guarantee that
 *  actually matters -- this is the friendlier 400 in front of it, not a
 *  substitute for it. */
export function isValidFireModeForActionType(actionType: GoalTriggerActionType, fireMode: GoalTriggerFireMode | null): boolean {
  if (fireMode === null) return true;
  if (fireMode === 'fire' && actionType === 'noop_outbound') return false;
  return true;
}

// Creator-facing: authenticated by session, scoped to a channel the
// caller belongs to. Owner/admin for every write; owner/admin/operator/
// moderator for every read -- this is creator/staff configuration, never
// a viewer-facing or overlay-facing surface (unlike 0150's goal
// completion read, which also allows 'viewer').
export interface GoalTriggerStore {
  createRule(userId: string, channelId: string, goalId: string, input: CreateGoalTriggerRuleInput): Promise<CreateGoalTriggerRuleResult>;
  listRules(userId: string, channelId: string, goalId: string): Promise<GoalTriggerRule[] | null>;
  setRuleEnabled(userId: string, channelId: string, ruleId: string, enabled: boolean): Promise<MutateGoalTriggerResult>;

  addCondition(userId: string, channelId: string, ruleId: string, input: AddGoalTriggerConditionInput): Promise<AddGoalTriggerConditionResult>;
  listConditions(userId: string, channelId: string, ruleId: string): Promise<GoalTriggerCondition[] | null>;

  addAction(userId: string, channelId: string, ruleId: string, input: AddGoalTriggerActionInput): Promise<AddGoalTriggerActionResult>;
  listActions(userId: string, channelId: string, ruleId: string): Promise<GoalTriggerAction[] | null>;

  listActionRuns(userId: string, channelId: string, evaluationId: string): Promise<GoalTriggerActionRun[] | null>;
}
