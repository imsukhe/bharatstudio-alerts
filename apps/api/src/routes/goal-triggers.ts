import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import {
  GOAL_TRIGGER_ACTION_TYPES,
  GOAL_TRIGGER_CONDITION_TYPES,
  GOAL_TRIGGER_FIRE_MODES,
  GOAL_TRIGGER_REPEAT_MODES,
  GOAL_TRIGGER_TYPES,
  isValidConditionValueCoupling,
  isValidFireModeForActionType,
  isValidThresholdCoupling,
  type GoalTriggerActionType,
  type GoalTriggerConditionType,
  type GoalTriggerFireMode,
  type GoalTriggerRepeatMode,
  type GoalTriggerStore,
  type GoalTriggerType,
} from '../domain/goal-trigger-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelGoalParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'goalId'],
  properties: { channelId: uuid, goalId: uuid },
} as const;
const channelRuleParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'ruleId'],
  properties: { channelId: uuid, ruleId: uuid },
} as const;
const channelEvaluationParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'evaluationId'],
  properties: { channelId: uuid, evaluationId: uuid },
} as const;

const createRuleBody = {
  type: 'object', additionalProperties: false, required: ['triggerType', 'thresholdPercentage', 'thresholdAmountPaise', 'repeatMode'],
  properties: {
    triggerType: { type: 'string', enum: [...GOAL_TRIGGER_TYPES] },
    thresholdPercentage: { type: ['integer', 'null'], minimum: 1, maximum: 100 },
    thresholdAmountPaise: { type: ['integer', 'null'], minimum: 1 },
    repeatMode: { type: 'string', enum: [...GOAL_TRIGGER_REPEAT_MODES] },
  },
} as const;

const setEnabledBody = {
  type: 'object', additionalProperties: false, required: ['enabled'],
  properties: { enabled: { type: 'boolean' } },
} as const;

const addConditionBody = {
  type: 'object', additionalProperties: false, required: ['conditionType', 'conditionValue'],
  properties: {
    conditionType: { type: 'string', enum: [...GOAL_TRIGGER_CONDITION_TYPES] },
    conditionValue: { type: ['string', 'null'], minLength: 1, maxLength: 120 },
  },
} as const;

const addActionBody = {
  type: 'object', additionalProperties: false, required: ['stepOrder', 'delayMs', 'actionType', 'fireMode'],
  properties: {
    stepOrder: { type: 'integer', minimum: 0 },
    delayMs: { type: 'integer', minimum: 0 },
    actionType: { type: 'string', enum: [...GOAL_TRIGGER_ACTION_TYPES] },
    // GOA-21: fireMode is REQUIRED on the wire (additionalProperties is
    // false and the field is required) but null is an accepted value --
    // it means "rely on the database default", which is always
    // 'prepare'. There is no way to omit the field and accidentally get
    // something other than the documented default.
    fireMode: { type: ['string', 'null'], enum: [...GOAL_TRIGGER_FIRE_MODES, null] },
  },
} as const;

type CreateRuleBody = { triggerType: GoalTriggerType; thresholdPercentage: number | null; thresholdAmountPaise: number | null; repeatMode: GoalTriggerRepeatMode };
type SetEnabledBody = { enabled: boolean };
type AddConditionBody = { conditionType: GoalTriggerConditionType; conditionValue: string | null };
type AddActionBody = { stepOrder: number; delayMs: number; actionType: GoalTriggerActionType; fireMode: GoalTriggerFireMode | null };

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'goal_trigger_store_unavailable', message: 'Goal triggers are temporarily unavailable', traceId, retryable: true });
}

function notFound(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Not found', traceId });
}

function invalid(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string, message: string) {
  return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_goal_trigger_request', message, traceId });
}

// GOA-04/GOA-09/GOA-18/GOA-19/GOA-20/GOA-21 (migration 0158): the goal
// trigger engine spine's creator-facing configuration API. A
// non-owner/admin/operator/moderator caller, or a rule/condition/action
// that does not belong to the given channel, gets 404, never 403 --
// the same non-leaking mapping sponsor-card.ts, goals.ts and
// master-canvas.ts already use.
//
// NO EVALUATE/DISPATCH ROUTE. app_private.evaluate_goal_trigger_rule and
// app_private.dispatch_goal_trigger_sequence are system/event-driven
// entry points with no HTTP surface in this slice -- see migration
// 0158's own header. This file only configures rules/conditions/actions
// and reads back what a system-driven dispatch already produced.
export async function registerGoalTriggerRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: GoalTriggerStore,
  account?: AccountStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string; goalId: string } }>('/v1/channels/:channelId/goals/:goalId/triggers', {
    preHandler: auth,
    schema: { params: channelGoalParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const rules = await store.listRules(request.auth.userId, request.params.channelId, request.params.goalId);
      if (rules === null) return notFound(reply, request.id);
      return reply.code(200).send({ schemaVersion: 'v1', rules });
    } catch (error) {
      logSafeError(request, 'goal_trigger_rules_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{ Params: { channelId: string; goalId: string }; Body: CreateRuleBody }>('/v1/channels/:channelId/goals/:goalId/triggers', {
    preHandler: termsAuth,
    schema: { params: channelGoalParams, body: createRuleBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const { triggerType, thresholdPercentage, thresholdAmountPaise, repeatMode } = request.body;
    if (!isValidThresholdCoupling(triggerType, thresholdPercentage, thresholdAmountPaise)) {
      return invalid(reply, request.id, 'threshold_percentage/threshold_amount_paise do not match triggerType (GOA-04)');
    }
    try {
      const result = await store.createRule(request.auth.userId, request.params.channelId, request.params.goalId, {
        triggerType, thresholdPercentage, thresholdAmountPaise, repeatMode,
      });
      switch (result.outcome) {
        case 'ok': return reply.code(201).send({ schemaVersion: 'v1', rule: result.rule });
        case 'forbidden': case 'not_found': return notFound(reply, request.id);
        case 'invalid': return invalid(reply, request.id, 'The goal trigger rule could not be created');
      }
    } catch (error) {
      logSafeError(request, 'goal_trigger_rule_create_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.patch<{ Params: { channelId: string; ruleId: string }; Body: SetEnabledBody }>('/v1/channels/:channelId/goal-triggers/:ruleId', {
    preHandler: termsAuth,
    schema: { params: channelRuleParams, body: setEnabledBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.setRuleEnabled(request.auth.userId, request.params.channelId, request.params.ruleId, request.body.enabled);
      switch (result.outcome) {
        case 'ok': return reply.code(204).send();
        case 'forbidden': case 'not_found': return notFound(reply, request.id);
      }
    } catch (error) {
      logSafeError(request, 'goal_trigger_rule_update_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.get<{ Params: { channelId: string; ruleId: string } }>('/v1/channels/:channelId/goal-triggers/:ruleId/conditions', {
    preHandler: auth,
    schema: { params: channelRuleParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const conditions = await store.listConditions(request.auth.userId, request.params.channelId, request.params.ruleId);
      if (conditions === null) return notFound(reply, request.id);
      return reply.code(200).send({ schemaVersion: 'v1', conditions });
    } catch (error) {
      logSafeError(request, 'goal_trigger_conditions_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{ Params: { channelId: string; ruleId: string }; Body: AddConditionBody }>('/v1/channels/:channelId/goal-triggers/:ruleId/conditions', {
    preHandler: termsAuth,
    schema: { params: channelRuleParams, body: addConditionBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const { conditionType, conditionValue } = request.body;
    if (!isValidConditionValueCoupling(conditionType, conditionValue)) {
      return invalid(reply, request.id, 'conditionValue is required for named_scene and forbidden otherwise (GOA-19)');
    }
    try {
      const result = await store.addCondition(request.auth.userId, request.params.channelId, request.params.ruleId, { conditionType, conditionValue });
      switch (result.outcome) {
        case 'ok': return reply.code(201).send({ schemaVersion: 'v1', condition: result.condition });
        case 'forbidden': case 'not_found': return notFound(reply, request.id);
        case 'invalid': return invalid(reply, request.id, 'The condition could not be added');
      }
    } catch (error) {
      logSafeError(request, 'goal_trigger_condition_add_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.get<{ Params: { channelId: string; ruleId: string } }>('/v1/channels/:channelId/goal-triggers/:ruleId/actions', {
    preHandler: auth,
    schema: { params: channelRuleParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const actions = await store.listActions(request.auth.userId, request.params.channelId, request.params.ruleId);
      if (actions === null) return notFound(reply, request.id);
      return reply.code(200).send({ schemaVersion: 'v1', actions });
    } catch (error) {
      logSafeError(request, 'goal_trigger_actions_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // GOA-18/GOA-21: adds one ordered step. There is no bulk "replace the
  // whole sequence" verb in this spine -- steps are appended one at a
  // time, each with its own explicit stepOrder and delayMs.
  app.post<{ Params: { channelId: string; ruleId: string }; Body: AddActionBody }>('/v1/channels/:channelId/goal-triggers/:ruleId/actions', {
    preHandler: termsAuth,
    schema: { params: channelRuleParams, body: addActionBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const { stepOrder, delayMs, actionType, fireMode } = request.body;
    if (!isValidFireModeForActionType(actionType, fireMode)) {
      return invalid(reply, request.id, 'outbound/public actions may never be configured to fire directly -- prepare only (GOA-21)');
    }
    try {
      const result = await store.addAction(request.auth.userId, request.params.channelId, request.params.ruleId, { stepOrder, delayMs, actionType, fireMode });
      switch (result.outcome) {
        case 'ok': return reply.code(201).send({ schemaVersion: 'v1', action: result.action });
        case 'forbidden': case 'not_found': return notFound(reply, request.id);
        case 'invalid': return invalid(reply, request.id, 'The action could not be added');
      }
    } catch (error) {
      logSafeError(request, 'goal_trigger_action_add_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // Read-only: what a system-driven dispatch of one evaluation already
  // produced. GOA-18's ordering/delay, GOA-19/GOA-20's blocked reasons
  // and GOA-21's prepared-vs-fired outcome are all visible here.
  app.get<{ Params: { channelId: string; evaluationId: string } }>('/v1/channels/:channelId/goal-trigger-runs/:evaluationId', {
    preHandler: auth,
    schema: { params: channelEvaluationParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const runs = await store.listActionRuns(request.auth.userId, request.params.channelId, request.params.evaluationId);
      if (runs === null) return notFound(reply, request.id);
      return reply.code(200).send({ schemaVersion: 'v1', runs });
    } catch (error) {
      logSafeError(request, 'goal_trigger_action_runs_read_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
