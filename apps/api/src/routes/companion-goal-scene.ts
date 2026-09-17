import type { FastifyInstance } from 'fastify';
import { requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import type { AlertStore } from '../domain/alert-store.js';
import type { CompanionEntitlementStore } from '../domain/companion-entitlement-policy.js';
import type { CompanionGoalControlStore, GoalControlOutcome } from '../domain/companion-goal-control-store.js';
import type { CompanionScenePresetStore, ScenePresetActionType, ScenePresetName } from '../domain/companion-scene-preset-store.js';
import { SCENE_PRESET_ACTION_TYPES, SCENE_PRESET_NAMES } from '../domain/companion-scene-preset-store.js';
import { logSafeError } from '../observability/safe-log.js';

// CMP-21 (goal controls) and CMP-20 (scene presets), FULL-PRODUCT-
// DEFINITION.md S5.2 "Live Deck". See packages/db/migrations/0162 for the
// full design rationale. This file is NEW -- it does not edit
// apps/api/src/routes/companion.ts (read-only for this task) or
// goals.ts/goal-triggers.ts's own routes; it composes their existing
// domain interfaces (AlertStore, CompanionEntitlementStore) the same way
// they are already composed in companion.ts, without duplicating that
// file's ACTION_GROUPS allowlist or /actions dispatch logic.

const uuid = { type: 'string', format: 'uuid' } as const;
const idempotencyKeyPattern = '^[A-Za-z0-9._:-]{16,128}$';
const goalParams = { type: 'object', additionalProperties: false, required: ['channelId', 'goalId'], properties: { channelId: uuid, goalId: uuid } } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const presetParams = { type: 'object', additionalProperties: false, required: ['channelId', 'presetId'], properties: { channelId: uuid, presetId: uuid } } as const;

const controlBodyBase = {
  sessionId: uuid,
  idempotencyKey: { type: 'string', pattern: idempotencyKeyPattern },
} as const;

const startTimerBody = { type: 'object', additionalProperties: false, required: ['sessionId', 'idempotencyKey'], properties: controlBodyBase } as const;
const increaseTargetBody = {
  type: 'object', additionalProperties: false, required: ['sessionId', 'idempotencyKey', 'newTargetAmountPaise'],
  properties: { ...controlBodyBase, newTargetAmountPaise: { type: 'integer', minimum: 1000 } },
} as const;

const upsertPresetBody = {
  type: 'object', additionalProperties: false, required: ['presetName'],
  properties: { presetName: { type: 'string', enum: [...SCENE_PRESET_NAMES] } },
} as const;

const addPresetActionBody = {
  type: 'object', additionalProperties: false, required: ['stepOrder', 'actionType', 'targetLabel'],
  properties: {
    stepOrder: { type: 'integer', minimum: 0 },
    actionType: { type: 'string', enum: [...SCENE_PRESET_ACTION_TYPES] },
    targetLabel: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'companion_store_unavailable', message: 'Companion controls are temporarily unavailable', traceId, retryable: true });
}

// Layer 1 (entitlement) + Layer 2 (activation) of the Companion
// authorisation model for goal controls, reusing the SAME live sources
// companion.ts's own /actions route uses for its 'alerts' group
// (overlayConnected is the activation signal a goal widget shares with
// alerts -- both render on the same overlay Master Canvas). This is a
// deliberately smaller check than companion.ts's own resolveEntitledGroups
// -- it does not replicate that function's per-channel
// companionActionGroups override precedence (migration 0100's override
// layer is specific to the existing 17-action catalogue this file does
// not touch) -- see this task's return report, RISKS.
async function requireCompanionAlertsActive(
  alerts: AlertStore | undefined,
  companionEntitlement: CompanionEntitlementStore | undefined,
  userId: string,
  channelId: string,
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  traceId: string,
): Promise<boolean> {
  if (!alerts) {
    unavailable(reply, traceId);
    return false;
  }
  const entitlements = await alerts.getEntitlements(userId, channelId);
  let entitled: boolean;
  if (companionEntitlement) {
    const policy = await companionEntitlement.getCompanionGrantPolicy(userId, channelId);
    entitled = policy ? policy.granted && policy.actionGroups.includes('alerts') : false;
  } else {
    entitled = entitlements !== null;
  }
  if (!entitled) {
    reply.code(403).send({ schemaVersion: 'v1', errorCode: 'companion_action_group_not_entitled', message: 'Goal controls are not available on this channel\'s current plan', traceId, retryable: false });
    return false;
  }
  const state = await alerts.getCompanionState(userId, channelId);
  if (!state?.overlayConnected) {
    reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_action_not_active', message: 'Alerts is not currently running for this channel', traceId, retryable: true });
    return false;
  }
  return true;
}

function sendControlOutcome(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  traceId: string,
  goalId: string,
  controlType: string,
  outcome: GoalControlOutcome,
) {
  switch (outcome.outcome) {
    case 'ok': return reply.code(202).send({ schemaVersion: 'v1', goalId, controlType, accepted: true });
    case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Support goal not found', traceId });
    case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Support goal not found', traceId });
    case 'ended': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'goal_ended', message: 'An ended support goal cannot be edited', traceId });
    case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_goal_control', message: 'The goal control could not be accepted', traceId });
    case 'session_inactive': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_control_session_inactive', message: 'No active Companion control session for this channel', traceId, retryable: true });
  }
}

export async function registerCompanionGoalSceneRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  account?: AccountStore,
  goalControls?: CompanionGoalControlStore,
  scenePresets?: CompanionScenePresetStore,
  alerts?: AlertStore,
  companionEntitlement?: CompanionEntitlementStore,
): Promise<void> {
  const termsAuth = requireAuthAndTerms(sessions, account);

  // ---- CMP-21: goal controls from Companion ----

  app.post<{ Params: { channelId: string; goalId: string }; Body: { sessionId: string; idempotencyKey: string; newTargetAmountPaise: number } }>(
    '/v1/channels/:channelId/companion/goals/:goalId/increase-target',
    { preHandler: termsAuth, schema: { params: goalParams, body: increaseTargetBody } },
    async (request, reply) => {
      if (!goalControls || !request.auth) return unavailable(reply, request.id);
      if (!(await requireCompanionAlertsActive(alerts, companionEntitlement, request.auth.userId, request.params.channelId, reply, request.id))) return;
      try {
        const outcome = await goalControls.increaseTarget(request.auth.userId, request.params.channelId, request.params.goalId, request.body);
        return sendControlOutcome(reply, request.id, request.params.goalId, 'increase_target', outcome);
      } catch (error) {
        logSafeError(request, 'companion_goal_increase_target_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  app.post<{ Params: { channelId: string; goalId: string }; Body: { sessionId: string; idempotencyKey: string } }>(
    '/v1/channels/:channelId/companion/goals/:goalId/start-timer',
    { preHandler: termsAuth, schema: { params: goalParams, body: startTimerBody } },
    async (request, reply) => {
      if (!goalControls || !request.auth) return unavailable(reply, request.id);
      if (!(await requireCompanionAlertsActive(alerts, companionEntitlement, request.auth.userId, request.params.channelId, reply, request.id))) return;
      try {
        const outcome = await goalControls.startTimer(request.auth.userId, request.params.channelId, request.params.goalId, request.body);
        return sendControlOutcome(reply, request.id, request.params.goalId, 'start_timer', outcome);
      } catch (error) {
        logSafeError(request, 'companion_goal_start_timer_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  app.post<{ Params: { channelId: string; goalId: string }; Body: { sessionId: string; idempotencyKey: string } }>(
    '/v1/channels/:channelId/companion/goals/:goalId/mark-complete',
    { preHandler: termsAuth, schema: { params: goalParams, body: startTimerBody } },
    async (request, reply) => {
      if (!goalControls || !request.auth) return unavailable(reply, request.id);
      if (!(await requireCompanionAlertsActive(alerts, companionEntitlement, request.auth.userId, request.params.channelId, reply, request.id))) return;
      try {
        const outcome = await goalControls.markComplete(request.auth.userId, request.params.channelId, request.params.goalId, request.body);
        return sendControlOutcome(reply, request.id, request.params.goalId, 'mark_complete', outcome);
      } catch (error) {
        logSafeError(request, 'companion_goal_mark_complete_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  // Trigger celebration -- PREPARE ONLY. See migration 0162: fire_mode is
  // hardcoded 'prepare' in app_private.prepare_support_goal_celebration
  // and structurally enforced by a CHECK constraint keyed on an IMMUTABLE
  // classifier -- nothing in this route, or anywhere else in the API
  // layer, can turn this into a fire.
  app.post<{ Params: { channelId: string; goalId: string }; Body: { sessionId: string; idempotencyKey: string } }>(
    '/v1/channels/:channelId/companion/goals/:goalId/trigger-celebration',
    { preHandler: termsAuth, schema: { params: goalParams, body: startTimerBody } },
    async (request, reply) => {
      if (!goalControls || !request.auth) return unavailable(reply, request.id);
      if (!(await requireCompanionAlertsActive(alerts, companionEntitlement, request.auth.userId, request.params.channelId, reply, request.id))) return;
      try {
        const outcome = await goalControls.prepareCelebration(request.auth.userId, request.params.channelId, request.params.goalId, request.body);
        return sendControlOutcome(reply, request.id, request.params.goalId, 'trigger_celebration', outcome);
      } catch (error) {
        logSafeError(request, 'companion_goal_trigger_celebration_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  // ---- CMP-20: scene presets ----

  app.post<{ Params: { channelId: string }; Body: { presetName: ScenePresetName } }>(
    '/v1/channels/:channelId/companion/scene-presets',
    { preHandler: termsAuth, schema: { params: channelParams, body: upsertPresetBody } },
    async (request, reply) => {
      if (!scenePresets || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await scenePresets.upsert(request.auth.userId, request.params.channelId, request.body.presetName);
        switch (result.outcome) {
          case 'ok': return reply.code(200).send({ schemaVersion: 'v1', presetId: result.presetId });
          case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
          case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_scene_preset', message: 'The scene preset could not be saved', traceId: request.id });
        }
      } catch (error) {
        logSafeError(request, 'companion_scene_preset_upsert_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  app.get<{ Params: { channelId: string } }>(
    '/v1/channels/:channelId/companion/scene-presets',
    { preHandler: termsAuth, schema: { params: channelParams } },
    async (request, reply) => {
      if (!scenePresets || !request.auth) return unavailable(reply, request.id);
      const items = await scenePresets.list(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', items });
    },
  );

  app.post<{ Params: { channelId: string; presetId: string }; Body: { stepOrder: number; actionType: ScenePresetActionType; targetLabel: string } }>(
    '/v1/channels/:channelId/companion/scene-presets/:presetId/actions',
    { preHandler: termsAuth, schema: { params: presetParams, body: addPresetActionBody } },
    async (request, reply) => {
      if (!scenePresets || !request.auth) return unavailable(reply, request.id);
      try {
        const result = await scenePresets.addAction(request.auth.userId, request.params.channelId, request.params.presetId, request.body);
        switch (result.outcome) {
          case 'ok': return reply.code(201).send({ schemaVersion: 'v1', actionId: result.actionId });
          case 'forbidden': case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Scene preset not found', traceId: request.id });
          case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_scene_preset_action', message: 'The scene preset action could not be added', traceId: request.id });
        }
      } catch (error) {
        logSafeError(request, 'companion_scene_preset_action_add_failed', error);
        return unavailable(reply, request.id);
      }
    },
  );

  // Resolution: the ordered OBS-action steps for this preset. A Companion
  // client executes each step through the EXISTING
  // /v1/channels/{channelId}/companion/actions route (companion.ts,
  // untouched), in stepOrder -- this route only ever reads and resolves,
  // it never dispatches.
  app.get<{ Params: { channelId: string; presetId: string } }>(
    '/v1/channels/:channelId/companion/scene-presets/:presetId/actions',
    { preHandler: termsAuth, schema: { params: presetParams } },
    async (request, reply) => {
      if (!scenePresets || !request.auth) return unavailable(reply, request.id);
      const actions = await scenePresets.listActions(request.auth.userId, request.params.channelId, request.params.presetId);
      return actions === null
        ? reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Scene preset not found', traceId: request.id })
        : reply.code(200).send({ schemaVersion: 'v1', actions });
    },
  );
}
