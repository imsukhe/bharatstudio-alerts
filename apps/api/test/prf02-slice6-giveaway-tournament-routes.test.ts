import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerMasterCanvasRoutes } from '../src/routes/master-canvas.js';
import { registerGiveawayTournamentRoutes } from '../src/routes/giveaway-tournament.js';
import {
  projectOverlayGiveawayTournament,
  type Giveaway,
  type GiveawayTournamentOverlayStore,
  type GiveawayTournamentStore,
  type OpenGiveawayResult,
  type OverlayGiveawayTournament,
  type Tournament,
} from '../src/domain/giveaway-tournament-store.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';

/*
 * PRF-02 slice 6, §6 catalogue module #17 (Giveaway / Tournament Card).
 *
 *   GET   /v1/overlay-widgets/:overlayId/giveaway-tournament (overlay token)
 *   GET   /v1/channels/:channelId/giveaway                   (creator session)
 *   POST  /v1/channels/:channelId/giveaway                   (creator session)
 *   PATCH /v1/channels/:channelId/giveaway/:giveawayId       (creator session)
 *   POST  .../giveaway/:giveawayId/close                     (creator session)
 *   GET   /v1/channels/:channelId/tournament                 (creator session)
 *   POST  /v1/channels/:channelId/tournament                 (creator session)
 *   PATCH /v1/channels/:channelId/tournament/:tournamentId   (creator session)
 *   POST  .../tournament/:tournamentId/conclude              (creator session)
 *
 * The route layer's own correctness surface and nothing below it. The SQL
 * layer's proof that the overlay read CANNOT return a participant
 * identifier, that no randomness primitive exists anywhere, that no prize
 * custody or claim column exists, and that the §30.3 entitlement gates the
 * module rather than the creator's own record, lives in
 * packages/db/tests/prf02_slice6_giveaway_tournament.sql. This file is the
 * second, independent narrowing: even a store handing up a winner, a
 * participant name or a prize must not get them past the route.
 */

const overlayId = '00000000-0000-4000-8000-000000005a41';
const overlayUrl = `/v1/overlay-widgets/${overlayId}/giveaway-tournament`;
const channelId = '00000000-0000-4000-8000-000000005a11';
const giveawayId = '00000000-0000-4000-8000-000000005a51';
const tournamentId = '00000000-0000-4000-8000-000000005a61';
const lobbySessionId = '00000000-0000-4000-8000-000000005851';
const userId = '00000000-0000-4000-8000-000000000001';
const giveawayUrl = `/v1/channels/${channelId}/giveaway`;
const tournamentUrl = `/v1/channels/${channelId}/tournament`;

const state: OverlayGiveawayTournament = {
  schemaVersion: 'v1',
  entryCount: 143,
  entryClosesAt: '2026-09-17T10:30:00.000Z',
  tournamentCurrentRound: 2,
  tournamentTotalRounds: 3,
  tournamentCompletedMatchesInRound: 1,
  tournamentMatchesInRound: 2,
};

const giveaway: Giveaway = {
  schemaVersion: 'v1',
  giveawayId,
  entryCount: 143,
  entryOpensAt: '2026-09-17T10:00:00.000Z',
  entryClosesAt: '2026-09-17T10:30:00.000Z',
  closedAt: null,
  createdAt: '2026-09-17T10:00:00.000Z',
  updatedAt: '2026-09-17T10:05:00.000Z',
};

const tournament: Tournament = {
  schemaVersion: 'v1',
  tournamentId,
  lobbySessionId,
  fieldSize: 8,
  currentRound: 2,
  totalRounds: 3,
  completedMatchesInRound: 1,
  matchesInRound: 2,
  startedAt: '2026-09-17T10:10:00.000Z',
  concludedAt: null,
  createdAt: '2026-09-17T10:10:00.000Z',
  updatedAt: '2026-09-17T10:20:00.000Z',
};

async function buildOverlayApp(store?: Partial<GiveawayTournamentOverlayStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerMasterCanvasRoutes(
    app,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    store as GiveawayTournamentOverlayStore | undefined,
  );
  return app;
}

// The session/terms chain is exercised by its own suites; this file stubs
// it exactly as prf02-slice6-lobby-status-routes.test.ts does, so its
// cases are about §17 rather than about auth plumbing. `installAuthState`
// is still installed, so a request with no session takes the real
// unauthenticated path.
const token = 'a'.repeat(48);
const authHeaders = { authorization: `Bearer ${token}` };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-09-18T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const account = {
  async hasAcceptedActiveDocuments() { return true; },
} as unknown as AccountStore;

async function buildCreatorApp(store?: Partial<GiveawayTournamentStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerGiveawayTournamentRoutes(app, sessions, store as GiveawayTournamentStore | undefined, account);
  return app;
}

// =====================================================================
// The overlay read.
// =====================================================================

test('a missing bearer token is 401, and a missing store is a retryable 503', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return state; } });
  const noToken = await app.inject({ method: 'GET', url: overlayUrl });
  assert.equal(noToken.statusCode, 401);

  const noStore = await buildOverlayApp(undefined);
  const unavailable = await noStore.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().retryable, true);
  // A 503 rather than a 200 reading `giveawayTournament: null`: "unknown"
  // and "nothing is running" are different answers, and collapsing them
  // would tell a viewer nothing is happening when nothing checked.
  await app.close();
  await noStore.close();
});

test('a valid read returns six aggregate values, the schema version, and nothing else', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return state; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['giveawayTournament', 'schemaVersion']);
  assert.deepEqual(Object.keys(body.giveawayTournament).sort(), [
    'entryClosesAt', 'entryCount', 'schemaVersion',
    'tournamentCompletedMatchesInRound', 'tournamentCurrentRound',
    'tournamentMatchesInRound', 'tournamentTotalRounds',
  ]);
  assert.equal(body.giveawayTournament.entryCount, 143);
  assert.equal(body.giveawayTournament.tournamentTotalRounds, 3);
  await app.close();
});

test('an unrecognised token is 200 with a null state, never 401 and never another channel', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return null; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer nope' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().giveawayTournament, null);
  await app.close();
});

test('a store failure is a retryable 503, not a 200 asserting nothing is running', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { throw new Error('boom'); } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});

// =====================================================================
// The route's own narrowing. THIS IS THE PROHIBITION SURFACE.
// =====================================================================

test('a store handing up a winner, a participant or a prize gets none of it past the route', async () => {
  const polluted = {
    ...state,
    // §17.1 permits a winner announcement only WITH CONSENT, no consent
    // mechanism exists, a winner is a participant identifier, and nothing
    // in this slice could produce one -- the mechanic is not built and
    // GIV-07 stays Blocked.
    winner: 'Riya',
    winnerUserId: '00000000-0000-4000-8000-0000000000a1',
    // BharatStudio never holds, escrows, ships or guarantees a prize.
    prize: 'A gaming mouse',
    prizeValuePaise: 450000,
    escrowHeld: true,
    shippingAddress: '12 MG Road',
    claimUrl: 'https://example.invalid/claim',
    // No chance mechanic of any kind.
    seed: 'abc123',
    odds: { supporter: 2 },
    // Identity in every shape this codebase has one.
    participants: [{ name: 'Riya' }],
    playerName: 'Riya',
    inGameName: 'RIYA_OP',
    discordName: 'riya#1234',
    viewerId: '00000000-0000-4000-8000-0000000000a2',
    anonymousId: 'anon_1',
    giveawayId,
    tournamentId,
  };
  const app = await buildOverlayApp({ async getForOverlay() { return polluted as unknown as OverlayGiveawayTournament; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().giveawayTournament, state);
  await app.close();
});

test('projectOverlayGiveawayTournament refuses everything that is not aggregate state', () => {
  assert.equal(projectOverlayGiveawayTournament(null), null);
  assert.equal(projectOverlayGiveawayTournament('nope'), null);
  assert.equal(projectOverlayGiveawayTournament({ ...state, schemaVersion: 'v2' }), null);
  // Both halves absent is not a card; the database never returns such a
  // row, and an all-null card is indistinguishable from no card.
  assert.equal(projectOverlayGiveawayTournament({
    schemaVersion: 'v1', entryCount: null, entryClosesAt: null,
    tournamentCurrentRound: null, tournamentTotalRounds: null,
    tournamentCompletedMatchesInRound: null, tournamentMatchesInRound: null,
  }), null);
  // A half-present giveaway is a partial row rather than a state.
  assert.equal(projectOverlayGiveawayTournament({ ...state, entryClosesAt: null }), null);
  // A half-present tournament likewise.
  assert.equal(projectOverlayGiveawayTournament({ ...state, tournamentTotalRounds: null }), null);
  // Arithmetic the database cannot produce is evidence of a fault
  // upstream, and a nonsense figure on a broadcast is worse than no card.
  assert.equal(projectOverlayGiveawayTournament({ ...state, tournamentCurrentRound: 3, tournamentTotalRounds: 2 }), null);
  assert.equal(projectOverlayGiveawayTournament({ ...state, tournamentCompletedMatchesInRound: 3, tournamentMatchesInRound: 2 }), null);
  assert.equal(projectOverlayGiveawayTournament({ ...state, entryCount: -1 }), null);
  assert.equal(projectOverlayGiveawayTournament({ ...state, entryCount: 1.5 }), null);
  // §30.3 caps a single-elimination field at 8, so there is no round 4.
  assert.equal(projectOverlayGiveawayTournament({ ...state, tournamentCurrentRound: 4, tournamentTotalRounds: 4 }), null);

  // Either half alone is a perfectly good card.
  const giveawayOnly = {
    schemaVersion: 'v1' as const, entryCount: 12, entryClosesAt: '2026-09-17T11:00:00.000Z',
    tournamentCurrentRound: null, tournamentTotalRounds: null,
    tournamentCompletedMatchesInRound: null, tournamentMatchesInRound: null,
  };
  assert.deepEqual(projectOverlayGiveawayTournament(giveawayOnly), giveawayOnly);
  const tournamentOnly = {
    schemaVersion: 'v1' as const, entryCount: null, entryClosesAt: null,
    tournamentCurrentRound: 1, tournamentTotalRounds: 3,
    tournamentCompletedMatchesInRound: 0, tournamentMatchesInRound: 4,
  };
  assert.deepEqual(projectOverlayGiveawayTournament(tournamentOnly), tournamentOnly);
  // Zero entries with the window still open IS a state worth painting --
  // "a giveaway is open and it closes at 11:00" is the invitation.
  assert.deepEqual(
    projectOverlayGiveawayTournament({ ...giveawayOnly, entryCount: 0 }),
    { ...giveawayOnly, entryCount: 0 },
  );
});

// =====================================================================
// The creator's giveaway routes.
// =====================================================================

test('a missing store is a retryable 503 on every creator giveaway route', async () => {
  const app = await buildCreatorApp(undefined);
  for (const request of [
    { method: 'GET' as const, url: giveawayUrl },
    { method: 'POST' as const, url: giveawayUrl, payload: { entryClosesAt: '2026-09-17T11:00:00.000Z' } },
    { method: 'PATCH' as const, url: `${giveawayUrl}/${giveawayId}`, payload: { entryCount: 4 } },
    { method: 'POST' as const, url: `${giveawayUrl}/${giveawayId}/close` },
  ]) {
    const response = await app.inject({ ...request, headers: authHeaders });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().retryable, true);
  }
  await app.close();
});

test('the creator reads their own giveaway at any tier, and a null giveaway is a valid answer', async () => {
  const app = await buildCreatorApp({ async getCurrentGiveaway() { return null; } });
  const response = await app.inject({ method: 'GET', url: giveawayUrl, headers: authHeaders });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().giveaway, null);
  await app.close();
});

test('opening a giveaway is 201, a second one is 409, a non-member is 404, a past window is 400', async () => {
  const cases: [OpenGiveawayResult, number][] = [
    [{ outcome: 'ok', giveaway }, 201],
    [{ outcome: 'conflict' }, 409],
    [{ outcome: 'forbidden' }, 404],
    [{ outcome: 'invalid' }, 400],
  ];
  for (const [result, expected] of cases) {
    const app = await buildCreatorApp({ async openGiveaway() { return result; } });
    const response = await app.inject({
      method: 'POST', url: giveawayUrl, headers: authHeaders,
      payload: { entryClosesAt: '2026-09-17T11:00:00.000Z' },
    });
    assert.equal(response.statusCode, expected);
    await app.close();
  }
});

test('the open body accepts an entry window and refuses every §17 prohibition', async () => {
  const app = await buildCreatorApp({ async openGiveaway() { return { outcome: 'ok', giveaway }; } });
  const good = await app.inject({
    method: 'POST', url: giveawayUrl, headers: authHeaders,
    payload: { entryClosesAt: '2026-09-17T11:00:00.000Z' },
  });
  assert.equal(good.statusCode, 201);

  for (const extra of [
    // No chance mechanic of any kind (§17.1, decided 2026-09-13; GIV-07).
    { drawMethod: 'seeded' }, { seed: 'abc' }, { odds: 2 }, { weighting: 'supporter' },
    { selectionMode: 'random' }, { shuffle: true },
    // No result, because consent does not exist and a winner is an
    // identifier.
    { winner: 'Riya' }, { winnerUserId: '00000000-0000-4000-8000-0000000000a1' }, { result: 'done' },
    // No prize custody, escrow, fulfilment or claim.
    { prize: 'A mouse' }, { prizeValuePaise: 1 }, { escrow: true },
    { shippingAddress: '12 MG Road' }, { courier: 'BlueDart' }, { claimUrl: 'https://example.invalid' },
    // Never a paid entry.
    { entryFeePaise: 5000 }, { pricePaise: 12900 }, { amountPaise: 1 },
    // Entry methods need an entry path, and there is none.
    { entryMethod: 'follow' }, { requiresFollow: true }, { supporterOnly: true },
    // Participants do not exist.
    { participants: ['Riya'] }, { entrants: 4 },
  ]) {
    const response = await app.inject({
      method: 'POST', url: giveawayUrl, headers: authHeaders,
      payload: { entryClosesAt: '2026-09-17T11:00:00.000Z', ...extra },
    });
    assert.equal(response.statusCode, 400, `${Object.keys(extra)[0]} must be refused on the wire`);
  }
  await app.close();
});

test('reporting the entry count is 200, an unknown giveaway is 404, and a bad count is 400', async () => {
  const ok = await buildCreatorApp({ async updateGiveawayEntryCount() { return { outcome: 'ok', giveaway }; } });
  assert.equal((await ok.inject({ method: 'PATCH', url: `${giveawayUrl}/${giveawayId}`, headers: authHeaders, payload: { entryCount: 143 } })).statusCode, 200);
  // Negative and fractional counts never reach the store.
  assert.equal((await ok.inject({ method: 'PATCH', url: `${giveawayUrl}/${giveawayId}`, headers: authHeaders, payload: { entryCount: -1 } })).statusCode, 400);
  assert.equal((await ok.inject({ method: 'PATCH', url: `${giveawayUrl}/${giveawayId}`, headers: authHeaders, payload: { entryCount: 1.5 } })).statusCode, 400);
  await ok.close();

  const missing = await buildCreatorApp({ async updateGiveawayEntryCount() { return { outcome: 'not_found' }; } });
  assert.equal((await missing.inject({ method: 'PATCH', url: `${giveawayUrl}/${giveawayId}`, headers: authHeaders, payload: { entryCount: 1 } })).statusCode, 404);
  await missing.close();
});

test('closing a giveaway is 204, and an unknown one is 404 — never a 403', async () => {
  const ok = await buildCreatorApp({ async closeGiveaway() { return { outcome: 'ok' }; } });
  assert.equal((await ok.inject({ method: 'POST', url: `${giveawayUrl}/${giveawayId}/close`, headers: authHeaders })).statusCode, 204);
  await ok.close();

  const missing = await buildCreatorApp({ async closeGiveaway() { return { outcome: 'not_found' }; } });
  const response = await missing.inject({ method: 'POST', url: `${giveawayUrl}/${giveawayId}/close`, headers: authHeaders });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().errorCode, 'not_found');
  await missing.close();
});

// =====================================================================
// The creator's tournament routes.
// =====================================================================

test('starting a tournament takes a lobby id and nothing else — §17.2 builds it ON the Lobby Engine', async () => {
  const app = await buildCreatorApp({ async startTournament() { return { outcome: 'ok', tournament }; } });
  const good = await app.inject({ method: 'POST', url: tournamentUrl, headers: authHeaders, payload: { lobbySessionId } });
  assert.equal(good.statusCode, 201);
  assert.equal(good.json().tournament.fieldSize, 8);
  assert.equal(good.json().tournament.lobbySessionId, lobbySessionId);

  // A body missing the lobby is refused: a tournament beside the Lobby
  // Engine is exactly what §17.2 rules out.
  assert.equal((await app.inject({ method: 'POST', url: tournamentUrl, headers: authHeaders, payload: {} })).statusCode, 400);

  for (const extra of [
    // The field size is the referenced lobby's seat count; supplying one
    // here would be the duplication §17.2 forbids.
    { fieldSize: 8 }, { bracketSize: 8 }, { capacity: 8 }, { seats: 8 },
    // Bracket types §30.3 places at Studio, and this slice has one gate.
    { bracketType: 'double_elimination' }, { format: 'round_robin' }, { pointsTable: true },
    // Seeding is TRN-02, and "random with a published seed" is a chance
    // mechanic besides.
    { seeding: 'random' }, { seed: 'abc' },
    // Participants, scores, disputes and sponsors are all out of scope.
    { participants: ['Riya'] }, { teams: 2 }, { scores: [1, 0] },
    { disputeNote: 'contested' }, { sponsor: 'Acme' },
    // No result, and no prize custody.
    { winner: 'Riya' }, { prize: 'A mouse' }, { entryFeePaise: 100 },
  ]) {
    const response = await app.inject({ method: 'POST', url: tournamentUrl, headers: authHeaders, payload: { lobbySessionId, ...extra } });
    assert.equal(response.statusCode, 400, `${Object.keys(extra)[0]} must be refused on the wire`);
  }
  await app.close();
});

test('an unreachable lobby is 404 and a field §30.3 does not allow is 400', async () => {
  const missingLobby = await buildCreatorApp({ async startTournament() { return { outcome: 'not_found' }; } });
  assert.equal((await missingLobby.inject({ method: 'POST', url: tournamentUrl, headers: authHeaders, payload: { lobbySessionId } })).statusCode, 404);
  await missingLobby.close();

  const badField = await buildCreatorApp({ async startTournament() { return { outcome: 'invalid' }; } });
  const response = await badField.inject({ method: 'POST', url: tournamentUrl, headers: authHeaders, payload: { lobbySessionId } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'invalid_bracket_field');
  await badField.close();

  const running = await buildCreatorApp({ async startTournament() { return { outcome: 'conflict' }; } });
  assert.equal((await running.inject({ method: 'POST', url: tournamentUrl, headers: authHeaders, payload: { lobbySessionId } })).statusCode, 409);
  await running.close();

  const stranger = await buildCreatorApp({ async startTournament() { return { outcome: 'forbidden' }; } });
  assert.equal((await stranger.inject({ method: 'POST', url: tournamentUrl, headers: authHeaders, payload: { lobbySessionId } })).statusCode, 404);
  await stranger.close();
});

test('progress carries both values together, bounded by §30.3 up to 8, and nothing else', async () => {
  const app = await buildCreatorApp({ async setTournamentProgress() { return { outcome: 'ok', tournament }; } });
  const url = `${tournamentUrl}/${tournamentId}`;
  assert.equal((await app.inject({ method: 'PATCH', url, headers: authHeaders, payload: { currentRound: 2, completedMatchesInRound: 1 } })).statusCode, 200);

  // One at a time is refused: they are read together on one card, and a
  // partial write would paint a round from one moment beside a match count
  // from another.
  assert.equal((await app.inject({ method: 'PATCH', url, headers: authHeaders, payload: { currentRound: 2 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url, headers: authHeaders, payload: { completedMatchesInRound: 1 } })).statusCode, 400);

  // log2(8) = 3 rounds, and 8/2 = 4 is the largest a round can be.
  assert.equal((await app.inject({ method: 'PATCH', url, headers: authHeaders, payload: { currentRound: 4, completedMatchesInRound: 0 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url, headers: authHeaders, payload: { currentRound: 0, completedMatchesInRound: 0 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url, headers: authHeaders, payload: { currentRound: 1, completedMatchesInRound: 5 } })).statusCode, 400);

  for (const extra of [{ scores: [1, 0] }, { winner: 'Riya' }, { disputeNote: 'x' }, { seed: 'abc' }]) {
    assert.equal(
      (await app.inject({ method: 'PATCH', url, headers: authHeaders, payload: { currentRound: 1, completedMatchesInRound: 0, ...extra } })).statusCode,
      400,
      `${Object.keys(extra)[0]} must be refused on the wire`,
    );
  }
  await app.close();

  const missing = await buildCreatorApp({ async setTournamentProgress() { return { outcome: 'not_found' }; } });
  assert.equal((await missing.inject({ method: 'PATCH', url, headers: authHeaders, payload: { currentRound: 1, completedMatchesInRound: 0 } })).statusCode, 404);
  await missing.close();

  const bad = await buildCreatorApp({ async setTournamentProgress() { return { outcome: 'invalid' }; } });
  const response = await bad.inject({ method: 'PATCH', url, headers: authHeaders, payload: { currentRound: 1, completedMatchesInRound: 0 } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'invalid_tournament_progress');
  await bad.close();
});

test('concluding a tournament is 204 and carries no result body', async () => {
  const app = await buildCreatorApp({ async concludeTournament() { return { outcome: 'ok' }; } });
  const response = await app.inject({ method: 'POST', url: `${tournamentUrl}/${tournamentId}/conclude`, headers: authHeaders });
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  await app.close();

  const missing = await buildCreatorApp({ async concludeTournament() { return { outcome: 'not_found' }; } });
  assert.equal((await missing.inject({ method: 'POST', url: `${tournamentUrl}/${tournamentId}/conclude`, headers: authHeaders })).statusCode, 404);
  await missing.close();
});

test('the creator reads their own tournament at any tier — the tier gate is on the module alone', async () => {
  const app = await buildCreatorApp({ async getCurrentTournament() { return tournament; } });
  const response = await app.inject({ method: 'GET', url: tournamentUrl, headers: authHeaders });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().tournament.totalRounds, 3);
  assert.equal(response.json().tournament.matchesInRound, 2);
  await app.close();
});

test('an unauthenticated request never reaches the store', async () => {
  let touched = false;
  const app = await buildCreatorApp({
    async getCurrentGiveaway() { touched = true; return null; },
    async getCurrentTournament() { touched = true; return null; },
  });
  assert.equal((await app.inject({ method: 'GET', url: giveawayUrl })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: tournamentUrl })).statusCode, 401);
  assert.equal(touched, false);
  await app.close();
});

test('a store failure on a creator route is a retryable 503, never a 200 asserting nothing is running', async () => {
  const app = await buildCreatorApp({
    async getCurrentGiveaway() { throw new Error('boom'); },
    async getCurrentTournament() { throw new Error('boom'); },
  });
  for (const url of [giveawayUrl, tournamentUrl]) {
    const response = await app.inject({ method: 'GET', url, headers: authHeaders });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().retryable, true);
  }
  await app.close();
});
