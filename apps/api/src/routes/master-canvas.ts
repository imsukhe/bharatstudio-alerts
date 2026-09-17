import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import {
  MASTER_CANVAS_MODULE_KEYS,
  type MasterCanvasModuleKey,
  type MasterCanvasOverlayStore,
  type MasterCanvasStore,
} from '../domain/master-canvas-store.js';
import {
  projectModeratorStatus,
  type ModeratorStatusOverlayStore,
} from '../domain/moderator-status-store.js';
import {
  projectReactionCloud,
  type ReactionCloudOverlayStore,
} from '../domain/reaction-cloud-store.js';
import {
  projectOverlayLobbyStatus,
  type LobbyStatusOverlayStore,
} from '../domain/lobby-status-store.js';
import {
  projectOverlayGiveawayTournament,
  type GiveawayTournamentOverlayStore,
} from '../domain/giveaway-tournament-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const moduleParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'moduleKey'],
  properties: { channelId: uuid, moduleKey: { type: 'string', enum: [...MASTER_CANVAS_MODULE_KEYS] } },
} as const;
const overlayParams = { type: 'object', additionalProperties: false, required: ['overlayId'], properties: { overlayId: uuid } } as const;

const upsertBody = {
  type: 'object', additionalProperties: false, required: ['enabled'],
  properties: { enabled: { type: 'boolean' } },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Master Canvas module configuration is temporarily unavailable', traceId, retryable: true });
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1];
}

// PRF-02: the server-owned §30.3 module cap (Free 2 / Pro 5 / Creator 12 /
// Studio all) and the durable per-channel module configuration it gates.
// Two route groups, mirroring the goals.ts split exactly:
//   - creator-facing (session auth, dashboard-shaped): list + toggle. This
//     is deliberately NOT the canvas designer UI (§7, out of this task's
//     scope) -- it is the same kind of undocumented internal CRUD surface
//     goals.ts's own POST/PATCH routes already are (neither is in
//     contracts/openapi/v1.yaml; only overlay/browser-source reads are).
//   - overlay-facing (bearer overlay-session token, browser-source-shaped):
//     the active module key list the Master Canvas runtime mounts from.
export async function registerMasterCanvasRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: MasterCanvasStore,
  account?: AccountStore,
  overlayModules?: MasterCanvasOverlayStore,
  overlayModeratorStatus?: ModeratorStatusOverlayStore,
  // PRF-02 slice 6, §6 module #5 (Reaction Cloud). Appended at the end so
  // every existing positional call keeps compiling and behaving unchanged;
  // when it is undefined the new route below fails closed to 503, exactly
  // like every other optional dependency in this file.
  overlayReactionCloud?: ReactionCloudOverlayStore,
  // PRF-02 slice 6, §6 module #16 (Lobby Status). Appended at the end for
  // the same reason overlayReactionCloud was: every existing positional
  // call keeps compiling and behaving unchanged, and when it is undefined
  // the new route below fails closed to 503 like every other optional
  // dependency in this file.
  overlayLobbyStatus?: LobbyStatusOverlayStore,
  // PRF-02 slice 6, §6 module #17 (Giveaway / Tournament Card). Appended
  // at the end for the same reason overlayReactionCloud and
  // overlayLobbyStatus were: every existing positional call keeps
  // compiling and behaving unchanged, and when it is undefined the new
  // route below fails closed to 503 like every other optional dependency
  // in this file.
  overlayGiveawayTournament?: GiveawayTournamentOverlayStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/master-canvas/modules', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const modules = await store.list(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', modules });
    } catch (error) {
      logSafeError(request, 'master_canvas_module_list_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.put<{ Params: { channelId: string; moduleKey: MasterCanvasModuleKey }; Body: { enabled: boolean } }>('/v1/channels/:channelId/master-canvas/modules/:moduleKey', {
    preHandler: termsAuth,
    schema: { params: moduleParams, body: upsertBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.upsert(request.auth.userId, request.params.channelId, request.params.moduleKey, request.body.enabled);
      switch (result.outcome) {
        case 'ok': return reply.code(200).send(result.module);
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_master_canvas_module', message: 'The module could not be configured', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'master_canvas_module_upsert_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The module could not be configured', traceId: request.id, retryable: true });
    }
  });

  // Overlay browser-source read. Deliberately outside the session-cookie
  // auth chain -- same shape as registerGoalRoutes's /v1/overlay-goals: no
  // preHandler, a scoped bearer token read from the Authorization header,
  // all channel/session/tier/cap scoping enforced inside
  // app_private.list_overlay_master_canvas_modules (0131). Reuses the
  // existing overlay_sessions table and token-fingerprint model.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/master-canvas/modules', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Master Canvas is not available', traceId: request.id });
    if (!overlayModules) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Master Canvas is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const moduleKeys = await overlayModules.listActiveForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', moduleKeys });
    } catch (error) {
      logSafeError(request, 'overlay_master_canvas_modules_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Master Canvas is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });

  // PRF-02, §6 module #12 (Moderator Status Card). Slice 5 shipped the
  // held half; safe mode (migration 0138) completes it. Same overlay
  // browser-source shape as the route just above, and deliberately in
  // this file rather than interactions.ts: this is a Master Canvas
  // module read, not an interaction, and this file already owns the
  // bearer-token helper and the master_canvas_store_unavailable envelope.
  //
  // THE RESPONSE CARRIES A COUNT, A BOOLEAN, AND NOTHING ELSE. §6:
  // "never private content", which the owner's 2026-09-16 decision
  // requires to be a property of the query --
  // app_private.list_overlay_moderator_status (migration 0138) returns
  // exactly `held_count bigint, safe_mode boolean`, so no supporter
  // name, message, amount, delivery id, queue id or viewer identifier
  // exists to be leaked here. projectModeratorStatus() then narrows a
  // SECOND, independent time in front of whatever the store hands up, so
  // the guarantee does not rest on a single layer.
  //
  // safeMode IS THE CREATOR'S OWN SWITCH, AND STILL NOT THE QUEUE-PAUSED
  // FLAG. Owner decision, 2026-09-16: safe mode is a per-channel
  // moderation state the creator turns on and off, routing incoming
  // alerts to `held` instead of `ready` while it is on. It is never
  // automatic and is engaged by no signal. alert_queues.is_paused
  // remains a different thing, still never read on this path, and still
  // refused by the published response schema.
  //
  // THIS ROUTE IS READ-ONLY. Turning safe mode on or off is the
  // creator's own session-authenticated surface
  // (routes/safe-mode.ts) -- an overlay browser-source token can read
  // the state and can never change it.
  //
  // A VALID SESSION WITH NOTHING HELD AND SAFE MODE OFF ANSWERS 200 WITH
  // heldCount: 0, safeMode: false; an unrecognised/expired/revoked/
  // foreign token answers 200 with moderatorStatus: null. The Canvas
  // module renders those the same (nothing), but they are not the same
  // answer and collapsing them here would be a bug.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/moderator-status', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Moderator status is not available', traceId: request.id });
    if (!overlayModeratorStatus) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Moderator status is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const status = await overlayModeratorStatus.getForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', moderatorStatus: projectModeratorStatus(status) });
    } catch (error) {
      logSafeError(request, 'overlay_moderator_status_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Moderator status is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });

  // PRF-02 slice 6, §6 module #5 (Reaction Cloud) -- the SERVER-SIDE
  // SAMPLED overlay read. Same overlay browser-source shape as the two
  // routes above, and in this file for the same reason slice 5 recorded:
  // it is a Master Canvas module read, not an interaction, and this file
  // already owns the bearer-token helper and the
  // master_canvas_store_unavailable envelope.
  //
  // THE SAMPLING ALREADY HAPPENED BY THE TIME CONTROL REACHES HERE, AND
  // THIS ROUTE MUST NOT REDO IT. §19.5 requires reactions to be "sampled
  // and rate-limited server-side BEFORE they reach the canvas" and the
  // cloud to show "a representative sample, never every event".
  // app_private.list_overlay_reaction_cloud (migration 0139) aggregates
  // every event into one row per catalogue entry and then applies the
  // configured display ceiling as its own LIMIT -- inside the database.
  // There is deliberately NO cap, slice or filter in this handler: adding
  // one would make it ambiguous where sampling happens, and its absence is
  // the proof that it happens in the query.
  //
  // THE RESPONSE CARRIES CATALOGUE ENTRY IDS AND COUNTS, AND NOTHING
  // ELSE. §6 #5's "non-identifying" is a property of the query (owner
  // decision, 2026-09-16): the function returns four columns, so no viewer
  // id, anonymous identity token, session id, IP or timestamp exists to be
  // leaked here. projectReactionCloud() then narrows a SECOND, independent
  // time in front of whatever the store hands up, so the guarantee does
  // not rest on a single layer.
  //
  // AN UNRECOGNISED TOKEN ANSWERS 200 WITH AN EMPTY LIST, not 401. Unlike
  // the Moderator Status Card, this read has no count whose zero the
  // renderer must treat differently from "no answer" -- an empty cloud and
  // an unauthorised read both mean "paint nothing" -- so collapsing them
  // loses nothing. A MISSING bearer token is still 401: that is a
  // malformed request, not an empty answer.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/reaction-cloud', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'The reaction cloud is not available', traceId: request.id });
    if (!overlayReactionCloud) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The reaction cloud is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const entries = await overlayReactionCloud.listForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', entries: projectReactionCloud(entries) });
    } catch (error) {
      logSafeError(request, 'overlay_reaction_cloud_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The reaction cloud is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });

  // PRF-02 slice 6, §6 module #16 (Lobby Status) -- the AGGREGATE-ONLY
  // overlay read. Same overlay browser-source shape as the three routes
  // above, and in this file for the same reason slices 5 and 6 recorded:
  // it is a Master Canvas module read, not an interaction, and this file
  // already owns the bearer-token helper and the
  // master_canvas_store_unavailable envelope. The creator's own lobby
  // read and writes are a separate, session-authenticated surface
  // (routes/lobby-session.ts) -- an overlay browser-source token can read
  // the aggregate and can never change it.
  //
  // THE RESPONSE CARRIES THREE NUMBERS AND NOTHING ELSE. §16: the public
  // overlay shows "aggregate status only: '8/16 seats confirmed', queue
  // count ... Never player identifiers, never Discord names, never codes
  // or passwords." The owner's 2026-09-16 decision 4 requires that to be
  // a property of the query, and it is:
  // app_private.list_overlay_lobby_status (migration 0140) returns
  // exactly `seat_count, confirmed_seat_count, queue_count`, so no room
  // code, password, seat token, player identifier, in-game name, Discord
  // name, viewer id, anonymous identity or session id exists to be leaked
  // here -- and none exists in the schema either.
  // projectOverlayLobbyStatus() then narrows a SECOND, independent time
  // in front of whatever the store hands up, so the guarantee does not
  // rest on a single layer.
  //
  // THE LOBBY ID IS NOT RETURNED. It carries no information the card
  // paints, and "a session id" is on the prohibited list.
  //
  // THE TIER GATE IS NOT APPLIED HERE, AND THAT IS DELIBERATE. §30.3
  // places the Lobby Engine at Creator+, and the owner's decision 5 makes
  // that `tier in ('creator','studio')` OR an active Events Pack grant --
  // a check with no grant path yet, so present behaviour is exactly
  // "included at Creator+". That check lives INSIDE the SQL function,
  // beside the session gate, so an unentitled channel's perfectly valid
  // token matches no row. A second copy of the tier rule in TypeScript
  // would be a second place for it to be wrong, and the SQL one is the
  // one packages/db/tests/prf02_slice6_lobby_status.sql can prove.
  //
  // AN UNRECOGNISED TOKEN ANSWERS 200 WITH `lobbyStatus: null`, not 401,
  // and so do a channel with no open lobby and an unentitled channel. All
  // three mean "paint nothing" to the card, so collapsing them loses
  // nothing -- unlike the Moderator Status Card, there is no zero here
  // whose meaning differs from "no answer". A MISSING bearer token is
  // still 401: that is a malformed request, not an empty answer.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/lobby-status', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Lobby status is not available', traceId: request.id });
    if (!overlayLobbyStatus) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Lobby status is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const status = await overlayLobbyStatus.getForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', lobbyStatus: projectOverlayLobbyStatus(status) });
    } catch (error) {
      logSafeError(request, 'overlay_lobby_status_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Lobby status is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });

  // PRF-02 slice 6, §6 module #17 (Giveaway / Tournament Card) -- the
  // AGGREGATE-ONLY overlay read. Same overlay browser-source shape as the
  // four routes above, and in this file for the same reason slices 5 and 6
  // recorded: it is a Master Canvas module read, not an interaction, and
  // this file already owns the bearer-token helper and the
  // master_canvas_store_unavailable envelope. The creator's own giveaway
  // and tournament reads and writes are a separate, session-authenticated
  // surface (routes/giveaway-tournament.ts) -- an overlay browser-source
  // token can read the aggregate and can never change it.
  //
  // THE RESPONSE CARRIES SIX AGGREGATE VALUES AND NOTHING ELSE. §17.1's
  // overlay list is "entry count, time remaining, winner announcement with
  // consent, and a claim flow"; §17.2 adds a standings module. The entry
  // count, the window close instant and the bracket progress ship.
  //
  // THE WINNER DOES NOT, AND THAT IS THE CORRECT CONCLUSION rather than an
  // omission: §17.1 permits the announcement only WITH CONSENT and no
  // consent mechanism exists in this schema; a winner would be a
  // participant identifier on an aggregate-only path; and nothing could
  // produce one anyway, because the mechanic is not built (§17.1's
  // decision of 2026-09-13; GIV-07 stays Blocked) and "the creator records
  // who won" is an invented surface the owner's 2026-09-16 decision names
  // outright. The claim flow does not ship either -- §17.1 requires it
  // never expose an address on stream, and BharatStudio never holds,
  // escrows, ships or guarantees a prize.
  //
  // So app_private.list_overlay_giveaway_tournament (migration 0142)
  // returns exactly six aggregate values, and no participant identifier,
  // in-game name, Discord name, viewer id, anonymous identity, session id,
  // postal field or contact detail exists to be leaked here -- and none
  // exists in the schema either. projectOverlayGiveawayTournament() then
  // narrows a SECOND, independent time in front of whatever the store
  // hands up, so the guarantee does not rest on a single layer.
  //
  // NEITHER RECORD'S ID IS RETURNED. Neither carries information the card
  // paints, and "a session id" is on the prohibited list.
  //
  // THE TIER GATE IS NOT APPLIED HERE, AND THAT IS DELIBERATE. §30.3
  // places the Lobby and tournament engine at Creator+, and the owner's
  // decision 5 makes that `tier in ('creator','studio')` OR an active
  // Events Pack grant -- a check with no grant path yet, so present
  // behaviour is exactly "included at Creator+". That check is
  // app_private.events_pack_entitled, which migration 0140 already ships
  // and 0142 CALLS from inside the SQL function rather than
  // reimplementing. An unentitled channel's perfectly valid token matches
  // no row. A second copy of the tier rule in TypeScript would be a second
  // place for it to be wrong.
  //
  // AN UNRECOGNISED TOKEN ANSWERS 200 WITH `giveawayTournament: null`, not
  // 401, and so do a channel with nothing running and an unentitled
  // channel. All three mean "paint nothing" to the card. A MISSING bearer
  // token is still 401: that is a malformed request, not an empty answer.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/giveaway-tournament', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'Giveaway and tournament state is not available', traceId: request.id });
    if (!overlayGiveawayTournament) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Giveaway and tournament state is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const state = await overlayGiveawayTournament.getForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', giveawayTournament: projectOverlayGiveawayTournament(state) });
    } catch (error) {
      logSafeError(request, 'overlay_giveaway_tournament_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'Giveaway and tournament state is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
}
