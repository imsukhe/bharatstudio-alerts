import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAndTerms } from '../auth/pre-handler.js';
import type { SessionStore } from '../auth/session-store.js';
import type { AccountStore } from '../domain/account-store.js';
import {
  GIVEAWAY_COUNT_MAX,
  TOURNAMENT_MAX_MATCHES_IN_ROUND,
  TOURNAMENT_MAX_ROUNDS,
  type GiveawayTournamentStore,
} from '../domain/giveaway-tournament-store.js';
import { logSafeError } from '../observability/safe-log.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const channelParams = { type: 'object', additionalProperties: false, required: ['channelId'], properties: { channelId: uuid } } as const;
const giveawayParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'giveawayId'],
  properties: { channelId: uuid, giveawayId: uuid },
} as const;
const tournamentParams = {
  type: 'object', additionalProperties: false, required: ['channelId', 'tournamentId'],
  properties: { channelId: uuid, tournamentId: uuid },
} as const;

// `additionalProperties: false` is LOAD-BEARING on every body below, not
// boilerplate. It is where the §17 prohibitions are enforced on the wire:
//
//   * NO CHANCE MECHANIC. A body carrying `drawMethod`, `seed`, `odds`,
//     `weighting`, `weightedEntries` or `selectionMode` is a 400 before
//     the store is ever called. §17.1 decided on 2026-09-13 that only
//     free-entry and skill-based formats ship and that supporter-weighted
//     odds are not built; GIV-07 gates chance-based formats on a legal
//     review that has not happened and stays Blocked.
//   * NO RESULT. `winner`, `winnerName`, `winnerUserId` and `result` are
//     likewise 400s. A winner needs consent §17.1 requires and this schema
//     has no mechanism for, and "the creator records who won" is an
//     invented surface the owner's 2026-09-16 decision names outright.
//   * NO PRIZE CUSTODY. `prize`, `prizeValue`, `escrow`, `shippingAddress`,
//     `courier` and `claimUrl` are 400s. BharatStudio never holds,
//     escrows, ships or guarantees a prize (§17.1); the creator is the
//     promoter and is responsible for eligibility, taxes and delivery.
//   * NEVER A PAID ENTRY. `entryFeePaise`, `pricePaise` and `amountPaise`
//     are 400s. There is no entry path in this slice at all, so there is
//     nothing for a payment to gate, and none may be added here.
//
// A client cannot quietly introduce a field the product does not have and
// the schema has no column for.
//
// THE BOUNDS ARE NOT PRODUCT NUMBERS. `maximum` on `entryCount` is
// PostgreSQL `integer`'s own range, so an out-of-range value is a 400 here
// rather than a 500 from a failed cast. `TOURNAMENT_MAX_ROUNDS` is
// log2(8) and `TOURNAMENT_MAX_MATCHES_IN_ROUND` is 8/2, both from §30.3's
// `Tournaments — single elim, up to 8`. The EXACT per-tournament bound
// depends on the referenced lobby's seat count and is enforced in SQL,
// where the lobby row can actually be read.
const openGiveawayBody = {
  type: 'object', additionalProperties: false, required: ['entryClosesAt'],
  properties: {
    // §17.1's entry window. The creator supplies the close instant; there
    // is no duration, countdown or timer anywhere, and the open instant is
    // recorded rather than chosen.
    entryClosesAt: { type: 'string', format: 'date-time' },
  },
} as const;

const entryCountBody = {
  type: 'object', additionalProperties: false, required: ['entryCount'],
  properties: {
    entryCount: { type: 'integer', minimum: 0, maximum: GIVEAWAY_COUNT_MAX },
  },
} as const;

const startTournamentBody = {
  type: 'object', additionalProperties: false, required: ['lobbySessionId'],
  properties: {
    // §17.2: tournaments are "built on the Lobby Engine rather than beside
    // it". The bracket's field size IS the referenced lobby's seat count,
    // so there is deliberately no field-size, bracket-size, capacity or
    // seeding field to supply here.
    lobbySessionId: uuid,
  },
} as const;

// Both values are required together, never one at a time, because they are
// read together on one card: a partial write would paint a round from one
// moment beside a match count from another.
const tournamentProgressBody = {
  type: 'object', additionalProperties: false, required: ['currentRound', 'completedMatchesInRound'],
  properties: {
    currentRound: { type: 'integer', minimum: 1, maximum: TOURNAMENT_MAX_ROUNDS },
    completedMatchesInRound: { type: 'integer', minimum: 0, maximum: TOURNAMENT_MAX_MATCHES_IN_ROUND },
  },
} as const;

function unavailable(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, traceId: string) {
  return reply.code(503).send({ schemaVersion: 'v1', errorCode: 'giveaway_tournament_store_unavailable', message: 'Giveaways and tournaments are temporarily unavailable', traceId, retryable: true });
}

// PRF-02 slice 6, §6 catalogue module #17: the creator's own reads and
// writes of a giveaway and of a tournament.
//
// Authority: FULL-PRODUCT-DEFINITION.md §6 module #17, §12.6, §16, §17,
// §30.3, GIV-07, and bharatstudio-requirements/reviews/
// 2026-09-16-prf-02-slice-6-owner-decisions.md decisions 4 and 5. Task
// record: bharatstudio-requirements/active/tasks/
// PRF-02-slice-6-giveaway-tournament.md.
//
// ITS OWN FILE, ON PURPOSE, for the same reason routes/lobby-session.ts
// and routes/safe-mode.ts are: routes/master-canvas.ts (which owns the
// module #17 OVERLAY read) already takes eight positional dependencies,
// and these are creator writes rather than canvas rendering.
//
// NEVER TIER-GATED (§12.6). Storing, viewing and changing a durable
// creator record is available at every tier. There is no tier check
// anywhere in this file and none may be added: a Pro creator opens a
// giveaway, reports entries, runs a tournament and reads it all back
// exactly as a Studio creator does. What §30.3's Creator+ entitlement
// decides is whether the CANVAS renders the card, and that check lives in
// one place -- inside app_private.list_overlay_giveaway_tournament, as
// migration 0140's app_private.events_pack_entitled, called rather than
// reimplemented.
//
// THE ONLY GATE HERE IS THE ROLE GATE, and it lives in SQL:
// app_private.has_channel_role(channel, ['owner','admin']) inside
// migration 0142's own functions. No scoping decision is made in
// TypeScript.
//
// A NON-OWNER/ADMIN GETS 404, NEVER 403. Existence of a channel the caller
// may not see is itself information; master-canvas.ts, lobby-session.ts
// and stream-mission.ts already answer this way and this file follows
// them.
export async function registerGiveawayTournamentRoutes(
  app: FastifyInstance,
  sessions?: SessionStore,
  store?: GiveawayTournamentStore,
  account?: AccountStore,
): Promise<void> {
  const auth = requireAuth(sessions);
  const termsAuth = requireAuthAndTerms(sessions, account);

  // =====================================================================
  // The giveaway half.
  // =====================================================================

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/giveaway', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    // A missing store is a retryable 503, never a 200 reading
    // `giveaway: null`. Reporting "nothing is running" when the answer is
    // actually unknown would tell a creator their giveaway is closed when
    // nothing has checked.
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const giveaway = await store.getCurrentGiveaway(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', giveaway });
    } catch (error) {
      logSafeError(request, 'giveaway_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{ Params: { channelId: string }; Body: { entryClosesAt: string } }>('/v1/channels/:channelId/giveaway', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: openGiveawayBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.openGiveaway(request.auth.userId, request.params.channelId, request.body.entryClosesAt);
      switch (result.outcome) {
        case 'ok': return reply.code(201).send({ schemaVersion: 'v1', giveaway: result.giveaway });
        // A giveaway is already open. Deliberately a conflict the creator
        // resolves, never a silent supersede that destroys the running one.
        case 'conflict': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'giveaway_already_open', message: 'A giveaway is already open for this channel. Close it before opening another.', traceId: request.id });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_entry_window', message: 'The entry window must close in the future', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'giveaway_open_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // PATCH, and addressed by giveaway id rather than ambient: a stale
  // dashboard tab cannot write a count onto a giveaway opened after that
  // tab loaded. The read that precedes it already returns the id, so this
  // costs the caller nothing.
  app.patch<{ Params: { channelId: string; giveawayId: string }; Body: { entryCount: number } }>('/v1/channels/:channelId/giveaway/:giveawayId', {
    preHandler: termsAuth,
    schema: { params: giveawayParams, body: entryCountBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.updateGiveawayEntryCount(
        request.auth.userId, request.params.channelId, request.params.giveawayId, request.body.entryCount,
      );
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', giveaway: result.giveaway });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Giveaway not found', traceId: request.id });
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_entry_count', message: 'The entry count could not be recorded', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'giveaway_update_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // Closing deletes nothing (§12.6) and announces nothing. The row stays
  // durable and readable, and no result follows -- see the domain type's
  // header for the three reasons the card can show no winner.
  app.post<{ Params: { channelId: string; giveawayId: string } }>('/v1/channels/:channelId/giveaway/:giveawayId/close', {
    preHandler: termsAuth,
    schema: { params: giveawayParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.closeGiveaway(request.auth.userId, request.params.channelId, request.params.giveawayId);
      if (result.outcome === 'not_found') {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Giveaway not found', traceId: request.id });
      }
      return reply.code(204).send();
    } catch (error) {
      logSafeError(request, 'giveaway_close_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // =====================================================================
  // The tournament half.
  // =====================================================================

  app.get<{ Params: { channelId: string } }>('/v1/channels/:channelId/tournament', {
    preHandler: auth,
    schema: { params: channelParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const tournament = await store.getCurrentTournament(request.auth.userId, request.params.channelId);
      return reply.code(200).send({ schemaVersion: 'v1', tournament });
    } catch (error) {
      logSafeError(request, 'tournament_read_failed', error);
      return unavailable(reply, request.id);
    }
  });

  app.post<{ Params: { channelId: string }; Body: { lobbySessionId: string } }>('/v1/channels/:channelId/tournament', {
    preHandler: termsAuth,
    schema: { params: channelParams, body: startTournamentBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.startTournament(request.auth.userId, request.params.channelId, request.body.lobbySessionId);
      switch (result.outcome) {
        case 'ok': return reply.code(201).send({ schemaVersion: 'v1', tournament: result.tournament });
        case 'conflict': return reply.code(409).send({ schemaVersion: 'v1', errorCode: 'tournament_already_running', message: 'A tournament is already running for this channel. Conclude it before starting another.', traceId: request.id });
        case 'forbidden': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Channel not found', traceId: request.id });
        // The LOBBY could not be reached -- unknown, already closed, or
        // another channel's. §17.2 builds a tournament ON a lobby, so
        // there is nothing to start without one.
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Lobby session not found', traceId: request.id });
        // The lobby exists but cannot host a single-elimination bracket:
        // §30.3 caps the field at 8, and a bracket without byes needs a
        // power of two. Seeding, which is what byes belong to, is not
        // built.
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_bracket_field', message: 'A single-elimination bracket needs a lobby of 2, 4 or 8 seats', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'tournament_start_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // PATCH rather than PUT because the body carries the two PROGRESS
  // values, not the whole tournament -- the lobby it runs on is fixed when
  // the tournament starts and is deliberately not writable here.
  //
  // NO SCORE, NO PAIRING, NO RESULT AND NO DISPUTE NOTE is accepted. Those
  // are TRN-04 and need match rows, which do not exist in this slice.
  app.patch<{ Params: { channelId: string; tournamentId: string }; Body: { currentRound: number; completedMatchesInRound: number } }>('/v1/channels/:channelId/tournament/:tournamentId', {
    preHandler: termsAuth,
    schema: { params: tournamentParams, body: tournamentProgressBody },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.setTournamentProgress(
        request.auth.userId, request.params.channelId, request.params.tournamentId,
        request.body.currentRound, request.body.completedMatchesInRound,
      );
      switch (result.outcome) {
        case 'ok': return reply.code(200).send({ schemaVersion: 'v1', tournament: result.tournament });
        case 'not_found': return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Tournament not found', traceId: request.id });
        // The round is past the end of this bracket, or the round cannot
        // hold that many matches. Both bounds come from the referenced
        // lobby's seat count, which only the database can read.
        case 'invalid': return reply.code(400).send({ schemaVersion: 'v1', errorCode: 'invalid_tournament_progress', message: 'That round or match count does not fit this bracket', traceId: request.id });
      }
    } catch (error) {
      logSafeError(request, 'tournament_progress_failed', error);
      return unavailable(reply, request.id);
    }
  });

  // Concluding deletes nothing and announces nothing: the record stays
  // durable and readable (§12.6) and the overlay simply stops having
  // anything to paint. There is deliberately no terminal state.
  app.post<{ Params: { channelId: string; tournamentId: string } }>('/v1/channels/:channelId/tournament/:tournamentId/conclude', {
    preHandler: termsAuth,
    schema: { params: tournamentParams },
  }, async (request, reply) => {
    if (!store || !request.auth) return unavailable(reply, request.id);
    try {
      const result = await store.concludeTournament(request.auth.userId, request.params.channelId, request.params.tournamentId);
      if (result.outcome === 'not_found') {
        return reply.code(404).send({ schemaVersion: 'v1', errorCode: 'not_found', message: 'Tournament not found', traceId: request.id });
      }
      return reply.code(204).send();
    } catch (error) {
      logSafeError(request, 'tournament_conclude_failed', error);
      return unavailable(reply, request.id);
    }
  });
}
