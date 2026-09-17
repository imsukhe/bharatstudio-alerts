import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import {
  LOBBY_COUNT_MAX,
  LOBBY_SEAT_COUNT_MIN,
  type LobbySessionStore,
} from '../domain/lobby-status-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const lobbyParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'lobbyId'],
  properties: { channelId: uuid, lobbyId: uuid },
} as const;

// `additionalProperties: false` is LOAD-BEARING on both bodies below, not
// boilerplate. §16 forbids a room code, a password, a seat token, a player
// identifier or a Discord name ever reaching the overlay, and the owner's
// 2026-09-16 decision 4 makes this module aggregates-only. This schema is
// where that is enforced on the wire: a body carrying `roomCode`,
// `password`, `seatToken`, `playerName`, `inGameName`, `discordName`,
// `viewerId`, `participants`, `initials` or `avatarUrl` is a 400 before
// the store is ever called, so a client cannot quietly introduce a field
// the product does not have and the schema has no column for.
//
// It is also where "no ready check, no selection policy" is enforced: a
// body carrying `readyCheck`, `selectionPolicy` or `queuePolicy` is
// likewise a 400. Those are the Lobby Engine and are Phase 3.
//
// THE BOUNDS ARE NOT PRODUCT NUMBERS. `minimum: 1` on `seatCount` is
// arithmetic (a lobby with no seats cannot render a seat status) and
// matches `0140`'s own `seat_count >= 1` check. `maximum` is PostgreSQL
// `integer`'s own range, so an out-of-range value is a 400 here rather
// than a 500 from a failed cast in the database. §16 names no maximum seat
// count and this file invents none.
const openBody = {
  type: 'object', additionalProperties: false, required: ['seatCount'],
  properties: {
    seatCount: { type: 'integer', minimum: LOBBY_SEAT_COUNT_MIN, maximum: LOBBY_COUNT_MAX },
  },
} as const;

// Both counts are required together, never one at a time, because they are
// read together on one card: a partial write would paint a seat figure
// from one moment beside a queue figure from another.
const countsBody = {
  type: 'object', additionalProperties: false, required: ['confirmedSeatCount', 'queueCount'],
  properties: {
    confirmedSeatCount: { type: 'integer', minimum: 0, maximum: LOBBY_COUNT_MAX },
    queueCount: { type: 'integer', minimum: 0, maximum: LOBBY_COUNT_MAX },
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'lobby_session_store_unavailable', message: 'The lobby is temporarily unavailable', traceId, retryable: true });
}

// PRF-02 slice 6, §6 catalogue module #16: the creator's own read and
// writes of a lobby session.
//
// Authority: FULL-PRODUCT-DEFINITION.md §6 module #16, §12.6, §16, §30.3,
// and bharatstudio-requirements/reviews/
// 2026-09-16-prf-02-slice-6-owner-decisions.md decisions 4 and 5. Task
// record: bharatstudio-requirements/active/tasks/
// PRF-02-slice-6-lobby-status.md.
//
// ITS OWN FILE, ON PURPOSE, the same reason routes/safe-mode.ts is its own
// file: routes/master-canvas.ts (which owns the module #16 OVERLAY read)
// already takes seven positional dependencies, and these are creator
// writes rather than canvas rendering.
//
// NEVER TIER-GATED (§12.6). Storing, viewing and changing a durable
// creator record is available at every tier. There is no tier check
// anywhere in this file and none may be added: a Pro creator opens a
// lobby, reports its counts, closes it and reads it back exactly as a
// Studio creator does. What §30.3's Creator+ entitlement decides is
// whether the CANVAS renders the card, and that check lives in one place
// -- inside app_private.list_overlay_lobby_status (migration 0140).
//
// THE ONLY GATE HERE IS THE ROLE GATE, and it lives in SQL:
// app_private.has_channel_role(channel, ['owner','admin']) inside
// migration 0140's own functions -- the same gate 0135's mission
// functions and 0079's payout-onboarding setting use. No scoping decision
// is made in TypeScript.
//
// A NON-OWNER/ADMIN GETS 404, NEVER 403. Existence of a channel the caller
// may not see is itself information; master-canvas.ts, stream-mission.ts
// and safe-mode.ts already answer this way and this file follows them.
export async function registerLobbySessionRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: LobbySessionStore,
  account?: AccountStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/lobby-session', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    // A missing store is a retryable 503, never a 200 reading
    // `lobby: null`. Reporting "no lobby is open" when the answer is
    // actually unknown would tell a creator their community game is not
    // running when nothing has checked.
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const lobby = await store.getCurrent(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', lobby });
    } catch (error) {
      logSafeError(request, 'lobby_session_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{ Params: { channelId: string }; Body: { seatCount: number } }>('/v1/channels/:channelId/lobby-session', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: openBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.open(request.auth.userId, request.params.channelId, request.body.seatCount);
      switch (result.outcome) {
        case 'ok': return reply.code(201).send({ schemaVersion: 'v1', lobby: result.lobby });
        // A lobby is already open. Deliberately a conflict the creator
        // resolves, never a silent supersede that destroys the running one.
        case 'conflict': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'lobby_session_already_open', message: 'A lobby session is already open for this channel. Close it before opening another.', traceId: request.id });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_lobby_session', message: 'The lobby session could not be opened', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'lobby_session_open_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'lobby_session_store_unavailable', message: 'The lobby session could not be opened', traceId: request.id, retryable: true });
    }
  });

  // PATCH, and addressed by lobby id rather than ambient: a stale
  // dashboard tab cannot write counts onto a lobby opened after that tab
  // loaded. The read that precedes it already returns the id, so this
  // costs the caller nothing.
  //
  // PATCH rather than PUT because the body carries the two COUNTS, not the
  // whole lobby -- the seat count is fixed when the lobby is opened and is
  // deliberately not writable here.
  app.patch<{ Params: { channelId: string; lobbyId: string }; Body: { confirmedSeatCount: number; queueCount: number } }>('/v1/channels/:channelId/lobby-session/:lobbyId', {
    preHandler: termsAuth,
    schema: { params: lobbyParams, body: countsBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.updateCounts(
        request.auth.userId,
        request.params.channelId,
        request.params.lobbyId,
        request.body.confirmedSeatCount,
        request.body.queueCount,
      );
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', lobby: result.lobby });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Lobby session not found', traceId: request.id });
        // More seats confirmed than the lobby has, which the database
        // refuses outright -- the arithmetic of "8/16 seats confirmed".
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_lobby_counts', message: 'A lobby cannot confirm more seats than it has', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'lobby_session_update_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'lobby_session_store_unavailable', message: 'The lobby counts could not be updated', traceId: request.id, retryable: true });
    }
  });

  // Closing deletes nothing (§12.6). The row stays durable and readable;
  // §16.1 step 8's "automatic deletion of temporary lobby data" is about
  // the Lobby Engine's codes, tokens and per-viewer rows, none of which
  // exist in this slice, and is not built here.
  app.post<{ Params: { channelId: string; lobbyId: string } }>('/v1/channels/:channelId/lobby-session/:lobbyId/close', {
    preHandler: termsAuth,
    schema: { params: lobbyParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.close(request.auth.userId, request.params.channelId, request.params.lobbyId);
      if (result.outcome === 'not_found') {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Lobby session not found', traceId: request.id });
      }
      return reply.code(204).send();
    } catch (error) {
      logSafeError(request, 'lobby_session_close_failed', error);
      return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'lobby_session_store_unavailable', message: 'The lobby session could not be closed', traceId: request.id, retryable: true });
    }
  });
}
