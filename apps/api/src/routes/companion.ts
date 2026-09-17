import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AlertStore, CompanionAction, CompanionActionSlot, CompanionControlSession } from '../domain/alert-store.js';
import type { AccountStore } from '../domain/account-store.js';
import type { CompanionFeatureStore } from '../domain/companion-feature-store.js';
import type { CompanionEntitlementStore } from '../domain/companion-entitlement-policy.js';
import { logSafeError } from '../observability/safe-log.js';

// L24 companion action catalogue.
//
// A later task (L24 activation, migration 0093) extended file ownership to
// include apps/api/src/domain/alert-store.ts, apps/api/src/db/alert-store.ts,
// this route file, migration 0093, and l24-activation-/companion-activation-
// prefixed tests -- see 0093's own header comment for the activation-signal
// work that did. The paragraphs below describe the original, narrower L24
// action-catalogue task (this file, migration 0089, l24-/companion-action-
// prefixed tests only) and remain accurate for that scope:
//
//   - ACTION_GROUPS below is this repo's *third* mirror of the allowlist
//     (after migration 0089's `companion_commands_v1_action_check` CHECK
//     constraint and `app_private.companion_action_group()`), alongside the
//     three native/mobile client mirrors. Five places total; see the
//     "Allowlist sync" note in this task's return report for how they are
//     kept from drifting.
//   - Calls into `store.executeCompanionAction` no longer launder the action
//     through `as unknown as CompanionAction`. That bridge existed because
//     the domain union was stuck at the original three 'alerts' verbs while
//     migration 0089 had already widened the database to all 17; it was
//     removed on 2026-09-18 when the domain union was corrected to match.
//     Enforcement is unchanged and still (a) this file's own ACTION_GROUPS
//     allowlist and JSON schema `enum`, and (b) migration 0089's DB CHECK
//     constraint, which rejects any string outside the catalogue whatever
//     TypeScript believes.
//   - Activation (is the action's target actually live, independent of
//     entitlement) is now checked here for every group, against
//     migration 0093's fields on `CompanionState`: 'alerts' uses
//     overlayConnected (unchanged); 'obs' uses helperPaired + obsConnected
//     (a fresh, non-stale heartbeat from a currently-paired desktop
//     helper -- see 0093's 45-second staleness window); 'mirror' and
//     'stream' use mirrorReachable/streamPaired, which 0093 models as
//     always false because those products report no liveness signal to
//     this API today -- so every mirror_*/stream_* action is entitlement-
//     gated as before but now also activation-gated, and activation for
//     them can never currently pass. That is intentional honesty (0093's
//     own header comment), not a bug: a real signal arriving later needs
//     no route change here, only 0093's placeholder columns to gain a
//     real writer.

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const controlSessionParams = { type: 'object', additionalProperties: false, required: ['channelId', 'sessionId'], properties: { channelId: uuid, sessionId: uuid } } as const;
const idempotencyKeyPattern = '^[A-Za-z0-9._:-]+$';

type CompanionActionGroup = 'alerts' | 'obs' | 'mirror' | 'stream';

// The full L24 catalogue. Keep this literally identical (same 17 strings,
// same grouping) to:
//   - migration 0089's companion_commands_v1_action_check CHECK constraint
//   - migration 0089's app_private.companion_action_group() SQL function
//   - bharatstudio-companion-desktop/macos/.../CompanionPolicy.swift's
//     CompanionControlAction enum
//   - bharatstudio-companion-desktop/windows/CompanionPolicy.cs's
//     CompanionControlAction enum
//   - bharatstudio-companion-mobile/src/api/CompanionApi.ts's allowlist
const ACTION_GROUPS: Record<string, CompanionActionGroup> = {
  pause_queue: 'alerts',
  resume_queue: 'alerts',
  send_test_alert: 'alerts',
  obs_set_scene: 'obs',
  obs_toggle_source: 'obs',
  obs_toggle_mute: 'obs',
  obs_start_stream: 'obs',
  obs_stop_stream: 'obs',
  obs_start_record: 'obs',
  obs_stop_record: 'obs',
  obs_save_replay_buffer: 'obs',
  obs_set_transition: 'obs',
  mirror_start: 'mirror',
  mirror_stop: 'mirror',
  mirror_screenshot: 'mirror',
  stream_go_live: 'stream',
  stream_end: 'stream',
};
const actions = Object.keys(ACTION_GROUPS);
const DEFAULT_ENTITLED_GROUPS: CompanionActionGroup[] = ['alerts', 'obs', 'mirror', 'stream'];
const NO_ALERTS_ENTITLED_GROUPS: CompanionActionGroup[] = ['obs', 'mirror', 'stream'];

const slotSchema = {
  type: 'object', additionalProperties: false,
  required: ['slotIndex', 'page', 'label', 'action', 'targetId'],
  properties: {
    slotIndex: { type: 'integer', minimum: 1, maximum: 64 },
    page: { type: 'integer', minimum: 1, maximum: 16 },
    label: { type: 'string', minLength: 1, maxLength: 80 },
    action: { type: 'string', enum: actions },
    targetId: uuid,
    targetLabel: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'companion_store_unavailable', message: 'Companion controls are temporarily unavailable', traceId, retryable: true });
}

function readExplicitGroupOverride(values: Record<string, unknown> | undefined): CompanionActionGroup[] | null {
  // Presence, rather than a non-empty valid value, selects the override.
  // Migration 0100 gives every explicit per-channel override precedence over
  // the live policy; an empty override is therefore an intentional deny-all
  // value. A malformed persisted override must also fail closed instead of
  // silently becoming a permissive policy fallback.
  if (!values || !Object.prototype.hasOwnProperty.call(values, 'companionActionGroups')) return null;
  const raw = values.companionActionGroups;
  if (!Array.isArray(raw)) return [];
  const valid: CompanionActionGroup[] = ['alerts', 'obs', 'mirror', 'stream'];
  if (raw.some((entry) => typeof entry !== 'string' || !(valid as string[]).includes(entry))) return [];
  return raw as CompanionActionGroup[];
}

// L24 Companion separation (migration 0100, master plan 3.7): Layer 1's
// entitled-groups source. Precedence, matching migration 0100's DB
// functions exactly (same order, same reasoning):
//   1. An explicit per-channel channel_entitlement_versions.values.
//      companionActionGroups override (0089) always wins when present.
//   2. Otherwise, the live app_private.companion_grant_policy(channelId)
//      (0100) -- read through `companionEntitlement`, the new optional
//      dependency this task adds -- decides: its own `granted` flag gates
//      whether this channel has Companion at all right now, and its
//      `actionGroups` is the entitled set.
//   3. If `companionEntitlement` is unavailable (for example in a focused
//      unit test), fall back to exactly today's shipped constants:
//      DEFAULT_ENTITLED_GROUPS when an entitlements row exists,
//      NO_ALERTS_ENTITLED_GROUPS when it does not. This is a pure
//      fallback behavior for isolated callers that intentionally omit the
//      optional dependency.
async function resolveEntitledGroups(
  companionEntitlement: CompanionEntitlementStore | undefined,
  userId: string,
  channelId: string,
  entitlements: { values?: Record<string, unknown> } | null,
): Promise<CompanionActionGroup[]> {
  const override = entitlements ? readExplicitGroupOverride(entitlements.values) : null;
  if (override) return override;
  if (companionEntitlement) {
    const policy = await companionEntitlement.getCompanionGrantPolicy(userId, channelId);
    if (policy) return policy.granted ? policy.actionGroups : [];
  }
  return entitlements ? DEFAULT_ENTITLED_GROUPS : NO_ALERTS_ENTITLED_GROUPS;
}

// L07 remaining feature list (master plan 7.11 items 2, 5, 8-10). `features`
// remains optional so focused tests can prove the fail-closed 503 boundary
// when no store is supplied. Production passes SQL-backed feature and
// entitlement stores from buildApp/index.
export async function registerCompanionRoutes(app: FastifyInstance, sessions?: SessionStore, store?: AlertStore, account?: AccountStore, features?: CompanionFeatureStore, companionEntitlement?: CompanionEntitlementStore): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/companion/state', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const result = await store.getCompanionState(request.auth.userId, request.params.channelId);
    return result ? reply.code(200).send(result) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Companion state not found', traceId: request.id });
  });

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/companion/layout', { preHandler: auth, schema: { params: channelParams } }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const result = await store.getCompanionLayout(request.auth.userId, request.params.channelId);
    return result ? reply.code(200).send(result) : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Companion layout not found', traceId: request.id });
  });

  app.patch<{
    Params: { channelId: string };
    Headers: { 'if-match-version'?: string };
    Body: { pageSize: 4 | 8 | 16; slots: CompanionActionSlot[] };
  }>('/v1/channels/:channelId/companion/layout', {
    preHandler: termsAuth,
    schema: {
      params: channelParams,
      headers: { type: 'object', required: ['if-match-version'], properties: { 'if-match-version': { type: 'string', pattern: '^(0|[1-9][0-9]*)$' } } },
      body: { type: 'object', additionalProperties: false, required: ['pageSize', 'slots'], properties: { pageSize: { type: 'integer', enum: [4, 8, 16] }, slots: { type: 'array', maxItems: 64, items: slotSchema } } },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const expectedVersion = Number(request.headers['if-match-version']);
    try {
      const result = await store.updateCompanionLayout(request.auth.userId, request.params.channelId, expectedVersion, request.body.pageSize, request.body.slots);
      return result
        ? reply.code(200).send(result)
        : reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_layout_version_conflict', message: 'Companion layout changed; reload before saving', traceId: request.id, retryable: false });
    } catch (error) {
      logSafeError(request, 'companion_layout_update_failed', error);
      const message = error instanceof Error ? error.message : '';
      if (/layout version conflict/i.test(message)) return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_layout_version_conflict', message: 'Companion layout changed; reload before saving', traceId: request.id, retryable: false });
      if (/not entitled/i.test(message)) return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'companion_action_group_not_entitled', message: 'This action group is not available on the channel\'s current plan', traceId: request.id, retryable: false });
      if (/targetLabel|target must be a queue/i.test(message)) return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_layout_target_shape_invalid', message: 'Companion slot target does not match its action type', traceId: request.id, retryable: false });
      if (/Companion|companion/i.test(message)) return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_layout_invalid', message: 'Companion layout could not be saved', traceId: request.id, retryable: false });
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_layout_rejected', message: 'Companion layout could not be saved', traceId: request.id, retryable: true });
    }
  });

  app.post<{
    Params: { channelId: string };
    Body: { clientType: CompanionControlSession['clientType']; clientInstanceId: string };
  }>('/v1/channels/:channelId/companion/control-session', {
    preHandler: termsAuth,
    schema: {
      params: channelParams,
      body: {
        type: 'object', additionalProperties: false, required: ['clientType', 'clientInstanceId'],
        properties: {
          clientType: { type: 'string', enum: ['web', 'mobile', 'desktop'] },
          clientInstanceId: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
        },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      return reply.code(201).send(await store.acquireCompanionControlSession(request.auth.userId, request.params.channelId, request.body.clientType, request.body.clientInstanceId));
    } catch (error) {
      logSafeError(request, 'companion_control_session_acquire_failed', error);
      const message = error instanceof Error ? error.message : '';
      if (/already active/i.test(message)) return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_control_busy', message: 'Another Companion control session is active', traceId: request.id, retryable: true });
      if (/access denied|not found/i.test(message)) return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'forbidden', message: 'Companion control access denied', traceId: request.id, retryable: false });
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_control_invalid', message: 'Companion control session could not be created', traceId: request.id, retryable: false });
    }
  });

  app.delete<{ Params: { channelId: string; sessionId: string } }>('/v1/channels/:channelId/companion/control-session/:sessionId', {
    preHandler: termsAuth,
    schema: { params: controlSessionParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const revoked = await store.revokeCompanionControlSession(request.auth.userId, request.params.channelId, request.params.sessionId);
      return revoked ? reply.code(204).send() : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Companion control session not found', traceId: request.id });
    } catch (error) {
      logSafeError(request, 'companion_control_session_revoke_failed', error);
      return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'forbidden', message: 'Companion control access denied', traceId: request.id, retryable: false });
    }
  });

  app.post<{ Params: { channelId: string }; Headers: { 'idempotency-key'?: string }; Body: { action: string; targetId: string; targetLabel?: string } }>('/v1/channels/:channelId/companion/actions', {
    preHandler: termsAuth,
    schema: {
      params: channelParams,
      headers: { type: 'object', properties: { 'idempotency-key': { type: 'string', minLength: 16, maxLength: 128, pattern: idempotencyKeyPattern } } },
      body: {
        type: 'object', additionalProperties: false, required: ['action', 'targetId'],
        properties: {
          action: { type: 'string', enum: actions },
          targetId: { type: 'string', minLength: 1, maxLength: 200 },
          targetLabel: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'idempotency_key_required', message: 'Idempotency-Key is required', traceId: request.id });
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_idempotency_key', message: 'A valid Idempotency-Key header is required', traceId: request.id, retryable: false });

    const { action, targetId, targetLabel } = request.body;
    // Layer 0 (defense in depth ahead of migration 0089's DB CHECK): the
    // action must be a name this route recognises at all.
    const group = ACTION_GROUPS[action];
    if (!group) return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_action_unsupported', message: 'Companion action is not in the allowlist', traceId: request.id, retryable: false });

    // Layer 1: entitlement -- may this action's group exist for this
    // channel at all. Server-authoritative: reads live entitlement data,
    // ignores anything the client claims.
    const entitlements = await store.getEntitlements(request.auth.userId, request.params.channelId);
    const entitledGroups = await resolveEntitledGroups(companionEntitlement, request.auth.userId, request.params.channelId, entitlements);
    if (!entitledGroups.includes(group)) {
      return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'companion_action_group_not_entitled', message: `The ${group} action group is not available on this channel's current plan`, traceId: request.id, retryable: false });
    }

    // Layer 2: activation -- is the thing this action controls actually
    // live right now, independent of entitlement. Every group is checked
    // here (see this file's header comment for what each group's signal
    // is and where it comes from). This is deliberately a *different*
    // errorCode/status (409 companion_action_not_active) from Layer 1's
    // 403 companion_action_group_not_entitled, so a client can tell "you
    // can't do this on your plan" apart from "this isn't live right now"
    // without parsing the message text.
    const state = await store.getCompanionState(request.auth.userId, request.params.channelId);
    if (!state) {
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_action_not_active', message: 'Companion state is unavailable for this channel', traceId: request.id, retryable: true });
    }
    if (group === 'alerts' && !state.overlayConnected) {
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_action_not_active', message: 'Alerts is not currently running for this channel', traceId: request.id, retryable: true });
    }
    if (group === 'obs' && !(state.helperPaired && state.obsConnected)) {
      const reason = !state.helperPaired ? 'No desktop helper is currently paired for this channel' : 'OBS is not currently connected';
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_action_not_active', message: reason, traceId: request.id, retryable: true });
    }
    if (group === 'mirror' && !state.mirrorReachable) {
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_action_not_active', message: 'Mirror is not currently reachable for this channel', traceId: request.id, retryable: true });
    }
    if (group === 'stream' && !state.streamPaired) {
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_action_not_active', message: 'Stream is not currently paired for this channel', traceId: request.id, retryable: true });
    }

    // Target-shape validation (mirrors migration 0089's per-group slot
    // validation for the direct-action endpoint): alerts actions need a
    // queue UUID and no targetLabel; obs actions need a bounded free-text
    // targetLabel (scene/source/input/transition name); mirror/stream need
    // neither, but any provided targetLabel is still bounded (already
    // enforced by the JSON schema above).
    if (group === 'alerts') {
      if (targetLabel !== undefined) return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_action_target_shape_invalid', message: 'Alerts actions do not take a targetLabel', traceId: request.id, retryable: false });
      if (!/^[0-9a-fA-F-]{36}$/.test(targetId)) return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_action_target_shape_invalid', message: 'Alerts action target must be a queue UUID', traceId: request.id, retryable: false });
    } else if (group === 'obs') {
      if (!targetLabel) return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_action_target_shape_invalid', message: 'OBS actions require a targetLabel naming the scene/source/input/transition', traceId: request.id, retryable: false });
    }

    try {
      // Migration 0089's DB CHECK constraint is the real allowlist
      // enforcement at this call; ACTION_GROUPS above and the route's JSON
      // schema `enum` reject anything outside the catalogue before we get
      // here. The `as unknown as CompanionAction` laundering that used to
      // sit on this line is gone: the domain union now carries all 17.
      return reply.code(202).send(await store.executeCompanionAction(request.auth.userId, request.params.channelId, action as CompanionAction, targetId, idempotencyKey));
    } catch (error) {
      logSafeError(request, 'companion_action_failed', error);
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_action_rejected', message: 'Companion action could not be accepted', traceId: request.id, retryable: true });
    }
  });

  // L24 activation (migration 0093): lets the paired desktop helper report
  // (or clear) its own local OBS connection state, so the 'obs' group's
  // activation check above has a real signal instead of trusting the
  // client. This is a STATUS REPORT, not a control channel -- see 0093's
  // header comment on the L07 boundary ("no general-purpose local/public
  // API", "no arbitrary command execution"): the helper can only ever
  // write a boolean + timestamp onto its own session row, nothing else.
  //
  // Deliberately NOT gated by `termsAuth`/`auth`: the desktop helper may
  // hold only a control-session lease and no account bearer token at all
  // (0082's pairing flow never issues one). Authentication here is the
  // control session id itself, exactly like the existing DELETE
  // .../control-session/:sessionId route accepts sessionId + channelId as
  // its sole caller-supplied credential. `reportCompanionObsConnection`
  // (apps/api/src/db/alert-store.ts, via migration 0093's
  // report_companion_obs_status) requires the session to be an unrevoked,
  // unexpired, client_type = 'desktop' row on exactly this channelId --
  // so a session id from a different channel (or a revoked/expired one)
  // is rejected here and never reports on another channel's behalf.
  app.put<{
    Params: { channelId: string; sessionId: string };
    Body: { connected: boolean };
  }>('/v1/channels/:channelId/companion/control-session/:sessionId/obs-status', {
    schema: {
      params: controlSessionParams,
      body: { type: 'object', additionalProperties: false, required: ['connected'], properties: { connected: { type: 'boolean' } } },
    },
  }, async (request, reply) => {
    if (!store) return unavailable(reply, request.id);
    try {
      const reported = await store.reportCompanionObsConnection(request.params.channelId, request.params.sessionId, request.body.connected);
      if (!reported) {
        return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'companion_helper_session_invalid', message: 'Companion control session is not a currently active desktop session for this channel', traceId: request.id, retryable: false });
      }
      return reply.code(204).send();
    } catch (error) {
      logSafeError(request, 'companion_obs_status_report_failed', error);
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_obs_status_invalid', message: 'OBS status could not be recorded', traceId: request.id, retryable: false });
    }
  });

  function featuresUnavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
    return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'companion_store_unavailable', message: 'Companion controls are temporarily unavailable', traceId, retryable: true });
  }

  // Two-layer gate shared by the mute/cancel/full-test routes below,
  // mirroring the /actions route's own Layer 1 (entitlement) + Layer 2
  // (activation) split above: 403 companion_action_group_not_entitled vs
  // 409 companion_action_not_active, same errorCodes, so a client already
  // handling those from /actions needs no new branch for these routes.
  // TTS capabilities live in the 'alerts' domain (they control the Alerts
  // TTS pipeline, not OBS/Mirror/Stream), so activation reuses
  // overlayConnected exactly like the 'alerts' action group does.
  async function requireAlertsTtsActive(
    request: { auth?: { userId: string } | null; params: { channelId: string }; id: string },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ): Promise<boolean> {
    if (!store || !request.auth) {
      featuresUnavailable(reply, request.id);
      return false;
    }
    const entitlements = await store.getEntitlements(request.auth.userId, request.params.channelId);
    const ttsEnabled = entitlements?.values?.ttsEnabled === true;
    if (!ttsEnabled) {
      reply.code(403).send({ schemaVersion: 'v1', errorCode: 'companion_action_group_not_entitled', message: 'TTS is not available on this channel\'s current plan', traceId: request.id, retryable: false });
      return false;
    }
    const state = await store.getCompanionState(request.auth.userId, request.params.channelId);
    if (!state?.overlayConnected) {
      reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_action_not_active', message: 'Alerts is not currently running for this channel', traceId: request.id, retryable: true });
      return false;
    }
    return true;
  }

  // Mute upcoming TTS (master plan 7.11 item 5, half 1) -- forward-looking,
  // per-queue. Distinct endpoint and distinct DB target (alert_queues.
  // tts_muted_at, migration 0098) from cancel below.
  app.put<{
    Params: { channelId: string };
    Body: { queueId: string; muted: boolean };
  }>('/v1/channels/:channelId/companion/tts/mute', {
    preHandler: termsAuth,
    schema: {
      params: channelParams,
      body: { type: 'object', additionalProperties: false, required: ['queueId', 'muted'], properties: { queueId: uuid, muted: { type: 'boolean' } } },
    },
  }, async (request, reply) => {
    if (!features || !store || !request.auth) return featuresUnavailable(reply, request.id);
    if (!(await requireAlertsTtsActive(request, reply))) return;
    try {
      return reply.code(200).send(await features.setCompanionTtsMuted(request.auth.userId, request.params.channelId, request.body.queueId, request.body.muted));
    } catch (error) {
      logSafeError(request, 'companion_tts_mute_failed', error);
      const message = error instanceof Error ? error.message : '';
      if (/access denied|actor mismatch/i.test(message)) return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'forbidden', message: 'Companion TTS mute access denied', traceId: request.id, retryable: false });
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_tts_mute_invalid', message: 'Companion TTS mute target queue is not active in channel', traceId: request.id, retryable: false });
    }
  });

  // Cancel the currently-playing (or queued-and-about-to-play) TTS delivery
  // (master plan 7.11 item 5, half 2) -- a one-shot transition of exactly
  // one delivery, never the queue's future deliveries. Distinct from mute.
  app.post<{
    Params: { channelId: string };
    Body: { deliveryId: string };
  }>('/v1/channels/:channelId/companion/tts/cancel', {
    preHandler: termsAuth,
    schema: {
      params: channelParams,
      body: { type: 'object', additionalProperties: false, required: ['deliveryId'], properties: { deliveryId: uuid } },
    },
  }, async (request, reply) => {
    if (!features || !store || !request.auth) return featuresUnavailable(reply, request.id);
    if (!(await requireAlertsTtsActive(request, reply))) return;
    try {
      const result = await features.cancelCompanionTts(request.auth.userId, request.params.channelId, request.body.deliveryId);
      return result
        ? reply.code(200).send(result)
        : reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_tts_cancel_not_active', message: 'Companion TTS cancel target is not currently playing or queued', traceId: request.id, retryable: false });
    } catch (error) {
      logSafeError(request, 'companion_tts_cancel_failed', error);
      const message = error instanceof Error ? error.message : '';
      if (/access denied|actor mismatch/i.test(message)) return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'forbidden', message: 'Companion TTS cancel access denied', traceId: request.id, retryable: false });
      return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'companion_tts_cancel_invalid', message: 'Companion TTS cancel could not be recorded', traceId: request.id, retryable: false });
    }
  });

  // Run full test (master plan 7.11 item 2): fires a synthetic alert
  // end-to-end via the existing 'send_test_alert' Companion action, after
  // applying the same alerts-group entitlement and activation checks as the
  // public action route, then
  // reports each hop the resulting event passed through. Distinct from the
  // plain send_test_alert action, which only reports "accepted".
  app.post<{
    Params: { channelId: string };
    Body: { queueId: string };
  }>('/v1/channels/:channelId/companion/full-test', {
    preHandler: termsAuth,
    schema: {
      params: channelParams,
      body: { type: 'object', additionalProperties: false, required: ['queueId'], properties: { queueId: uuid } },
    },
  }, async (request, reply) => {
    if (!features || !store || !request.auth) return featuresUnavailable(reply, request.id);
    const entitlements = await store.getEntitlements(request.auth.userId, request.params.channelId);
    const entitledGroups = await resolveEntitledGroups(companionEntitlement, request.auth.userId, request.params.channelId, entitlements);
    if (!entitledGroups.includes('alerts')) {
      return reply.code(403).send({ schemaVersion: 'v1', errorCode: 'companion_action_group_not_entitled', message: 'The alerts action group is not available on this channel\'s current plan', traceId: request.id, retryable: false });
    }
    const state = await store.getCompanionState(request.auth.userId, request.params.channelId);
    if (!state?.overlayConnected) {
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_action_not_active', message: 'Alerts is not currently running for this channel', traceId: request.id, retryable: true });
    }
    let accepted;
    try {
      accepted = await store.executeCompanionAction(request.auth.userId, request.params.channelId, 'send_test_alert', request.body.queueId, `companion-full-test-${randomUUID()}`);
    } catch (error) {
      logSafeError(request, 'companion_full_test_trigger_failed', error);
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_action_rejected', message: 'Companion full test could not be started', traceId: request.id, retryable: true });
    }
    if (!accepted.eventId) {
      return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'companion_action_rejected', message: 'Companion full test did not produce a test event', traceId: request.id, retryable: true });
    }
    const report = await features.getCompanionTestReport(request.auth.userId, request.params.channelId, accepted.eventId);
    return report
      ? reply.code(200).send(report)
      : reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Companion full test report not found', traceId: request.id });
  });

  // Payment and refund status (master plan 7.11 items 9-10) -- read-only,
  // finance-role-gated (see migration 0098's get_companion_payment_status).
  app.get<{ Params: { channelId: string }; Querystring: { limit?: string } }>('/v1/channels/:channelId/companion/payments', {
    preHandler: auth,
    schema: {
      params: channelParams,
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^[1-9][0-9]*$' } } },
    },
  }, async (request, reply) => {
    if (!features || !request.auth) return featuresUnavailable(reply, request.id);
    const limit = request.query.limit ? Number(request.query.limit) : 20;
    return reply.code(200).send(await features.getCompanionPaymentStatus(request.auth.userId, request.params.channelId, limit));
  });

  // Recent tips (master plan 7.11 item 8) -- read-only, donor-visibility-
  // scoped (see migration 0098's get_companion_recent_tips).
  app.get<{ Params: { channelId: string }; Querystring: { limit?: string } }>('/v1/channels/:channelId/companion/tips', {
    preHandler: auth,
    schema: {
      params: channelParams,
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^[1-9][0-9]*$' } } },
    },
  }, async (request, reply) => {
    if (!features || !request.auth) return featuresUnavailable(reply, request.id);
    const limit = request.query.limit ? Number(request.query.limit) : 20;
    return reply.code(200).send(await features.getCompanionRecentTips(request.auth.userId, request.params.channelId, limit));
  });
}
