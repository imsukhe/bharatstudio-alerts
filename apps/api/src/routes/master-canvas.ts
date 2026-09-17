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
import {
  projectOverlayMediaQueue,
  type MediaQueueOverlayStore,
} from '../domain/media-queue-store.js';
import {
  projectOverlaySoundboardPlay,
  type SafeSoundboardOverlayStore,
} from '../domain/safe-soundboard-store.js';
import {
  projectOverlaySponsorCard,
  type SponsorCardOverlayStore,
} from '../domain/sponsor-card-store.js';
import {
  projectOverlayQrSmartCard,
  type QrSmartCardOverlayStore,
} from '../domain/qr-smart-card-store.js';
import {
  projectOverlayCanvasLayout,
  type CanvasLayoutOverlayStore,
} from '../domain/canvas-layout-store.js';
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
  // PRF-02 slice 7, §6 module #20 (Media / Meme Queue). Appended at the
  // end for the same reason every overlay store above was: every existing
  // positional call keeps compiling and behaving unchanged, and when it
  // is undefined the new route below fails closed to 503 like every
  // other optional dependency in this file.
  overlayMediaQueue?: MediaQueueOverlayStore,
  // PRF-02 slice 7, §6 module #6 (Safe Soundboard Alert). Appended at the
  // end for the same reason every other slice's overlay store was: every
  // existing positional call keeps compiling and behaving unchanged, and
  // when it is undefined the new route below fails closed to 503 like
  // every other optional dependency in this file.
  overlaySafeSoundboard?: SafeSoundboardOverlayStore,
  // PRF-02 slice 7, §6 module #11 (Sponsor Card). Appended at the end for
  // the same reason every prior module's overlay dependency was: every
  // existing positional call keeps compiling and behaving unchanged, and
  // when it is undefined the new route below fails closed to 503 like
  // every other optional dependency in this file.
  overlaySponsorCard?: SponsorCardOverlayStore,
  // PRF-02 slice 7, §6 module #10 (QR Smart Card). Appended at the end
  // for the same reason every dependency above was: every existing
  // positional call keeps compiling and behaving unchanged, and when it
  // is undefined the new route below fails closed to 503 like every
  // other optional dependency in this file.
  overlayQrSmartCard?: QrSmartCardOverlayStore,
  // PRF-02 slice 7, §6 module #14 (Vertical Stream Layout). Appended at
  // the end for the same reason every dependency above was: every
  // existing positional call keeps compiling and behaving unchanged, and
  // when it is undefined the new route below fails closed to 503 like
  // every other optional dependency in this file. A LAYOUT IS NOT A
  // MODULE (migration 0147's header) -- this dependency is still
  // positioned here, alongside every other module's overlay store,
  // because the ROUTE it backs is an overlay browser-source read exactly
  // like the others, even though the setting it reads is not one of
  // MASTER_CANVAS_MODULE_KEYS and consumes no §30.3 cap slot.
  overlayCanvasLayout?: CanvasLayoutOverlayStore,
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

  // PRF-02 slice 7, §6 module #20 (Media / Meme Queue) -- the read that is
  // creator-only to WRITE and this endpoint's sole reason to exist: an
  // overlay browser-source token can read the current/next projection and
  // can NEVER submit, approve, reject or otherwise write anything (owner
  // decision 2026-09-17, MED-20). The creator's own reads and writes are
  // a separate, session-authenticated surface (routes/media-queue.ts).
  //
  // THE RESPONSE CARRIES AT MOST TWO ITEMS, LABELLED 'current' AND
  // 'next', AND NOTHING ELSE. §12.7's Overlay row authorises "current and
  // next alert state" in those exact words, and this reuses the SAME
  // bound apps/web/app/overlay/canvas/modules/support-theater-
  // module.ts:68-72 already established for this codebase rather than
  // inventing a queue-depth number -- no aggregate count of how many
  // items are queued is ever returned, so an overlay token cannot learn
  // how deep the rotation is.
  //
  // So app_private.list_overlay_media_queue (migration 0146) returns at
  // most two rows, and no item id, submitter identity, viewer identity or
  // channel-wide count exists to be leaked here -- and none exists in the
  // schema either. projectOverlayMediaQueue() then narrows a SECOND,
  // independent time in front of whatever the store hands up, so the
  // guarantee does not rest on a single layer.
  //
  // THIS MODULE HAS NO PER-MODULE ENTITLEMENT GATE, UNLIKE THE GIVEAWAY /
  // TOURNAMENT CARD ABOVE. §30.3 names no Creator+/Events-Pack-style row
  // for Media / Meme Queue; the only gate on whether this module renders
  // at all is 0131's existing, untouched, module-wide "Master Canvas
  // modules active" cap, which already lists 'media_meme_queue' as one of
  // its twenty catalogue keys.
  //
  // AN UNRECOGNISED TOKEN ANSWERS 200 WITH `mediaQueue: []`, not 401, and
  // so does a channel with nothing live in rotation. Both mean "paint
  // nothing" to the module. A MISSING bearer token is still 401: that is
  // a malformed request, not an empty answer.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/media-queue', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'The media queue is not available', traceId: request.id });
    if (!overlayMediaQueue) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The media queue is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const entries = await overlayMediaQueue.getForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', mediaQueue: projectOverlayMediaQueue(entries) });
    } catch (error) {
      logSafeError(request, 'overlay_media_queue_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The media queue is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
  // PRF-02 slice 7, §6 module #6 (Safe Soundboard Alert) -- the overlay
  // read. Same overlay browser-source shape as the routes above, and in
  // this file for the same reason: it is a Master Canvas module read,
  // not an interaction. The creator's own catalogue/upload/trigger
  // surface is routes/safe-soundboard.ts -- an overlay browser-source
  // token can read the current trigger and can never write one.
  //
  // THE RESPONSE CARRIES SEVEN FIELDS AND NOTHING ELSE, AND THE NAME IS
  // ABOUT THE BROADCAST, NOT THE CONTENT (see migration 0143's header
  // and the 2026-09-17 decision it implements): no viewer, supporter or
  // session identifier exists on this path, because none exists in the
  // schema for app_private.list_overlay_soundboard_play (migration 0143)
  // to return. `projectOverlaySoundboardPlay` then narrows a SECOND,
  // independent time in front of whatever the store hands up, including
  // re-validating any `playbackUrl` as our own https origin.
  //
  // THE §30.3 Pro+ MODULE GATE IS NOT APPLIED HERE, AND THAT IS
  // DELIBERATE: it lives inside app_private.soundboard_module_entitled,
  // called from inside the SQL function rather than reimplemented, so an
  // unentitled channel's perfectly valid token matches no row.
  //
  // `soundboardPlay: null` is every "nothing to paint" case at once: an
  // unrecognised/expired/revoked/foreign token, a channel that has
  // triggered nothing, and an unentitled (sub-Pro) channel. A MISSING
  // bearer token is still 401.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/safe-soundboard', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'The soundboard is not available', traceId: request.id });
    if (!overlaySafeSoundboard) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The soundboard is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const play = await overlaySafeSoundboard.getForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', soundboardPlay: projectOverlaySoundboardPlay(play) });
    } catch (error) {
      logSafeError(request, 'overlay_safe_soundboard_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The soundboard is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
  // PRF-02 slice 7, §6 module #11 (Sponsor Card) -- the overlay read. Same
  // overlay browser-source shape as the routes above, and in this file for
  // the same reason every prior slice recorded: it is a Master Canvas
  // module read, not an interaction, and this file already owns the
  // bearer-token helper and the master_canvas_store_unavailable envelope.
  // The creator's own sponsor-card read/write is a separate,
  // session-authenticated surface (routes/sponsor-card.ts) -- an overlay
  // browser-source token can read the card and can never change it.
  //
  // THE CARD RENDERS THE SPONSOR AND COUNTS NOTHING (owner decision,
  // 2026-09-17). THE RESPONSE CARRIES A NAME AND, OPTIONALLY, A LOGO
  // REFERENCE, AND NOTHING ELSE. app_private.list_overlay_sponsor_card
  // (migration 0145) returns exactly `sponsor_name, logo_mime_type,
  // logo_storage_key` -- no id, no schedule, no enabled flag, no
  // timestamp, and no count, impression, exposure or duration of any
  // kind, because none exists in the schema behind it either.
  // projectOverlaySponsorCard() then narrows a SECOND, independent time
  // in front of whatever the store hands up, so the guarantee does not
  // rest on a single layer.
  //
  // A ROW IS RETURNED ONLY WHEN THE CARD IS CURRENTLY SUPPOSED TO BE
  // VISIBLE: `enabled = true`, and inside its schedule window if it has
  // one. Disabled, outside the window, an unrecognised/expired/revoked/
  // foreign token, and a channel with no sponsor card at all all answer
  // 200 with `sponsorCard: null` -- every one of them means "paint
  // nothing", and collapsing them loses nothing the card needs to know. A
  // MISSING bearer token is still 401: that is a malformed request, not
  // an empty answer.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/sponsor-card', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'The sponsor card is not available', traceId: request.id });
    if (!overlaySponsorCard) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The sponsor card is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const sponsorCard = await overlaySponsorCard.getForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', sponsorCard: projectOverlaySponsorCard(sponsorCard) });
    } catch (error) {
      logSafeError(request, 'overlay_sponsor_card_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The sponsor card is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
  // PRF-02 slice 7, §6 module #10 (QR Smart Card) -- the overlay read.
  // Same overlay browser-source shape as the routes above, and in this
  // file for the same reason every other module's overlay read is: it is
  // a Master Canvas module read, not an interaction, and this file
  // already owns the bearer-token helper and the
  // master_canvas_store_unavailable envelope. The creator's own
  // destination/label/toggle read-writes are a separate,
  // session-authenticated surface (routes/qr-smart-card.ts) -- an
  // overlay browser-source token can read the enabled card and can never
  // change it.
  //
  // THE RESPONSE CARRIES TWO STRINGS AND NOTHING ELSE. Owner decision,
  // 2026-09-17 (reviews/2026-09-17-remaining-eight-modules-and-youtube-
  // v1-amendment.md Part 1 §2): "The creator sets one destination and
  // one label. The card shows or hides on a single toggle. That is the
  // entire feature." app_private.list_overlay_qr_smart_card (migration
  // 0144) returns exactly `destination text, label text`, so no scan
  // count, view count, impression count, exposure count, card id or
  // timestamp exists on this path at all -- because the function has no
  // such column to return. projectOverlayQrSmartCard() then narrows a
  // SECOND, independent time in front of whatever the store hands up, so
  // the guarantee does not rest on a single layer.
  //
  // THE DESTINATION IS DATA, NEVER SOMETHING THIS SERVER OR THE CANVAS
  // FETCHES (§9.1.1). It crosses this boundary as an ordinary JSON string
  // field, exactly like `label` -- there is no redirect, no server-side
  // fetch of it, and the client renders it as a first-party-generated QR
  // code image (apps/web/app/overlay/canvas/modules/
  // qr-smart-card-logic.ts), never a link the runtime navigates to or
  // embeds.
  //
  // THE TOGGLE IS NOT A SEPARATE FIELD HERE, AND THAT IS DELIBERATE. The
  // function's own `where card.is_enabled` predicate (migration 0144)
  // means a row is returned ONLY when the card is on -- so a disabled
  // card and a channel that has never configured one both answer with
  // the identical `qrSmartCard: null`, exactly like an unrecognised,
  // expired, revoked or foreign token. All four mean "paint nothing" to
  // the card. A MISSING bearer token is still 401: that is a malformed
  // request, not an empty answer.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/qr-smart-card', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'The QR smart card is not available', traceId: request.id });
    if (!overlayQrSmartCard) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The QR smart card is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const card = await overlayQrSmartCard.getForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', qrSmartCard: projectOverlayQrSmartCard(card) });
    } catch (error) {
      logSafeError(request, 'overlay_qr_smart_card_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The QR smart card is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
  // PRF-02 slice 7, §6 module #14 (Vertical Stream Layout) -- the
  // overlay read. Same overlay browser-source shape as the routes
  // above, and in this file for the same reason every other module's
  // overlay read is: this file already owns the bearer-token helper and
  // the master_canvas_store_unavailable envelope. The creator's own
  // read/write is a separate, session-authenticated surface
  // (routes/canvas-layout.ts) -- an overlay browser-source token can
  // read the effective layout and can never change it.
  //
  // A LAYOUT IS NOT A MODULE (migration 0147's header). This route is
  // not one of the sixteen MASTER_CANVAS_MODULE_KEYS entries, consumes
  // no §30.3 cap slot, and is never listed by
  // GET /v1/overlay-widgets/:overlayId/master-canvas/modules above --
  // the client runtime reads it as its own, separate arrangement
  // decision, the same way it reads moderator-status/reaction-cloud/etc
  // as their own separate module reads.
  //
  // THE RESPONSE ALWAYS CARRIES A LAYOUT FOR A VALID SESSION, UNLIKE
  // EVERY OTHER ROUTE IN THIS FILE. app_private.list_overlay_canvas_
  // layout (migration 0147) evaluates the §30.3 Pro+ gate
  // (app_private.vertical_canvas_layout_entitled) INSIDE the query, so a
  // sub-Pro channel that configured 'vertical' still gets exactly one
  // row back with layout = 'horizontal' -- never an error, and never
  // `canvasLayout: null` for that reason. `canvasLayout: null` here
  // means the SESSION itself is invalid (revoked/expired/wrong
  // fingerprint/foreign), the one state this projection still has to
  // represent. A MISSING bearer token is still 401: that is a malformed
  // request, not an empty answer.
  app.get<{ Params: { overlayId: string }; Headers: { authorization?: string } }>('/v1/overlay-widgets/:overlayId/canvas-layout', {
    schema: {
      params: overlayParams,
      headers: { type: 'object', properties: { authorization: { type: 'string', maxLength: 512 } } },
    },
  }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ schemaVersion: 'v1', errorCode: 'overlay_unauthorized', message: 'The canvas layout is not available', traceId: request.id });
    if (!overlayCanvasLayout) return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The canvas layout is temporarily unavailable', traceId: request.id, retryable: true });
    try {
      const layout = await overlayCanvasLayout.getForOverlay(token, request.params.overlayId);
      return reply.code(200).send({ schemaVersion: 'v1', canvasLayout: projectOverlayCanvasLayout(layout) });
    } catch (error) {
      logSafeError(request, 'overlay_canvas_layout_read_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'master_canvas_store_unavailable', message: 'The canvas layout is temporarily unavailable', traceId: request.id, retryable: true });
    }
  });
}
