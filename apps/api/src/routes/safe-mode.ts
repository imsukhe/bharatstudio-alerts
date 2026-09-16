import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import type { SafeModeStore } from '../domain/safe-mode-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;

// `additionalProperties: false` is load-bearing here, not boilerplate.
// Safe mode is a SWITCH, not a policy object: the owner's 2026-09-16
// decision says it is never automatic and is never engaged by any signal.
// This schema is where that is enforced on the wire -- a body carrying
// `threshold`, `windowSeconds`, `auto`, `expiresAt` or `reason` is a 400
// before the store is ever called, so a client cannot quietly introduce a
// knob the product does not have.
//
// `enum: [true, false]` RATHER THAN `type: 'boolean'`, AND THAT IS A
// DELIBERATE, MEASURED DEVIATION FROM THIS API'S NORM.
//
// This API runs AJV with Fastify's default `coerceTypes`, so a declared
// `type: 'boolean'` accepts more than booleans. That is harmless on most
// routes. It is not harmless here: it was MEASURED that `enabled: null`
// -- an uninitialised form field, a cleared React state, a JSON encoder
// writing a missing value -- coerces to `false` and SILENTLY TURNS SAFE
// MODE OFF, which would release the channel's alert flow onto a live
// broadcast without anyone asking for it. A wrong answer in that
// direction is not recoverable by retrying.
//
// Declaring the allowed VALUES instead of a type removes AJV's
// coercion entirely (it coerces against `type`, and there is none here),
// so only a real JSON `true` or `false` is accepted and everything else
// -- null, "true", 1, "on" -- is a 400 the client must fix. The cost is
// that a client sending `"true"` now gets a 400 where another route
// would have accepted it; for a moderation switch that is the right
// trade, and it is recorded rather than left to be rediscovered.
const setBody = {
  type: 'object', additionalProperties: false, required: ['enabled'],
  properties: { enabled: { enum: [true, false] } },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'safe_mode_store_unavailable', message: 'Safe mode is temporarily unavailable', traceId, retryable: true });
}

// PRF-02, §6 module #12: the creator's own read and write of safe mode.
//
// Authority: bharatstudio-requirements/reviews/
// 2026-09-16-prf-02-slice-6-owner-decisions.md decision 3. Task record:
// bharatstudio-requirements/active/tasks/PRF-02-safe-mode.md.
//
// ITS OWN FILE, ON PURPOSE. Safe mode is a moderation control, not a
// canvas module: routes/master-canvas.ts (which owns the module #12
// OVERLAY read) already takes six positional dependencies, and
// routes/interactions.ts fifteen. Adding a seventh to the former would
// have buried a moderation write inside a file named for rendering.
//
// NEVER TIER-GATED (§12.6). Storing, viewing and changing a durable
// creator record is available at every tier. The §30.3 module cap
// (migration 0131) gates only whether the Canvas RENDERS the Moderator
// Status Card. There is no tier check in this file.
//
// THE ONLY GATE IS THE ROLE GATE, and it lives in SQL:
// app_private.has_channel_role(channel, ['owner','admin']) inside
// migration 0138's own functions -- the same gate
// app_private.skip_payout_onboarding (0079) uses for the same kind of
// durable channel setting. No scoping decision is made in TypeScript.
//
// A NON-OWNER/ADMIN GETS 404, NEVER 403. Existence of a channel the
// caller may not see is itself information; master-canvas.ts and
// stream-mission.ts already answer this way and this file follows them.
export async function registerSafeModeRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: SafeModeStore,
  account?: AccountStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/safe-mode', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    // A missing store is a retryable 503, never a 200 reading
    // `enabled: false`. Reporting safe mode as OFF when the answer is
    // actually unknown would tell a creator their alerts are flowing
    // when nothing has checked.
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.get(request.auth.userId, request.params.channelId);
      if (result.outcome === 'not_found') {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
      }
      return reply.code(200).send({ schemaVersion: 'v1', safeMode: result.safeMode });
    } catch (error) {
      logSafeError(request, 'safe_mode_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // PUT, not two POSTs. The body carries the value, so "turn it on" and
  // "turn it off" are one idempotent code path that cannot drift apart,
  // and a stale dashboard tab cannot flip the switch by asking for a
  // toggle whose current state it no longer knows.
  app.put<{ Params: { channelId: string }; Body: { enabled: boolean } }>('/v1/channels/:channelId/safe-mode', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: setBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.set(request.auth.userId, request.params.channelId, request.body.enabled);
      if (result.outcome === 'not_found') {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
      }
      // 200, not 201: nothing is created. The channel already had a
      // safe-mode state; this changed it.
      return reply.code(200).send({ schemaVersion: 'v1', safeMode: result.safeMode });
    } catch (error) {
      logSafeError(request, 'safe_mode_write_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
