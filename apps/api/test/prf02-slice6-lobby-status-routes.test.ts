import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerMasterCanvasRoutes } from '../src/routes/master-canvas.js';
import { registerLobbySessionRoutes } from '../src/routes/lobby-session.js';
import {
  projectOverlayLobbyStatus,
  type LobbySession,
  type LobbySessionStore,
  type LobbyStatusOverlayStore,
  type OverlayLobbyStatus,
} from '../src/domain/lobby-status-store.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';

/*
 * PRF-02 slice 6, §6 catalogue module #16 (Lobby Status).
 *
 *   GET   /v1/overlay-widgets/:overlayId/lobby-status   (overlay bearer token)
 *   GET   /v1/channels/:channelId/lobby-session          (creator session)
 *   POST  /v1/channels/:channelId/lobby-session          (creator session)
 *   PATCH /v1/channels/:channelId/lobby-session/:lobbyId (creator session)
 *   POST  .../lobby-session/:lobbyId/close               (creator session)
 *
 * The route layer's own correctness surface and nothing below it. The SQL
 * layer's proof that the overlay read CANNOT return a room code, a
 * password, a seat token, a player identifier, an in-game name, a Discord
 * name, a viewer id, an anonymous identity or a session id -- and that the
 * §30.3 entitlement gates the module rather than the creator's own record
 * -- lives in packages/db/tests/prf02_slice6_lobby_status.sql. This file
 * is the second, independent narrowing: even a store handing up
 * identifying fields must not get them past the route.
 */

const overlayId = '00000000-0000-4000-8000-000000005841';
const overlayUrl = `/v1/overlay-widgets/${overlayId}/lobby-status`;
const channelId = '00000000-0000-4000-8000-000000005811';
const lobbyId = '00000000-0000-4000-8000-000000005851';
const userId = '00000000-0000-4000-8000-000000000001';
const sessionUrl = `/v1/channels/${channelId}/lobby-session`;

const status: OverlayLobbyStatus = { schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 8, queueCount: 12 };

const lobby: LobbySession = {
  schemaVersion: 'v1',
  lobbyId,
  seatCount: 16,
  confirmedSeatCount: 8,
  queueCount: 12,
  openedAt: '2026-09-16T10:00:00.000Z',
  closedAt: null,
  createdAt: '2026-09-16T10:00:00.000Z',
  updatedAt: '2026-09-16T10:05:00.000Z',
};

async function buildOverlayApp(store?: Partial<LobbyStatusOverlayStore>) {
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
    store as LobbyStatusOverlayStore | undefined,
  );
  return app;
}

// The session/terms chain is exercised by its own suites; this file stubs
// it exactly as prf02-safe-mode-routes.test.ts and
// prf02-stream-mission-routes.test.ts do, so its cases are about the lobby
// rather than about auth plumbing. `installAuthState` is still installed,
// so a request with no session takes the real unauthenticated path.
const token = 'a'.repeat(48);
const authHeaders = { authorization: `Bearer ${token}` };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-09-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const account = {
  async hasAcceptedActiveDocuments() { return true; },
} as unknown as AccountStore;

async function buildCreatorApp(store?: Partial<LobbySessionStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerLobbySessionRoutes(app, sessions, store as LobbySessionStore | undefined, account);
  return app;
}

// =====================================================================
// The overlay read.
// =====================================================================

test('a missing bearer token is 401, and a missing store is a retryable 503', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return status; } });
  const noToken = await app.inject({ method: 'GET', url: overlayUrl });
  assert.equal(noToken.statusCode, 401);

  const noStore = await buildOverlayApp(undefined);
  const unavailable = await noStore.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().retryable, true);
  // A 503 rather than a 200 reading `lobbyStatus: null`: "the lobby is
  // unknown" and "no lobby is open" are different answers and collapsing
  // them would tell a viewer nothing is running when nothing checked.
  await app.close();
  await noStore.close();
});

test('a valid read returns three numbers and the schema version, and nothing else', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return status; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['lobbyStatus', 'schemaVersion']);
  assert.deepEqual(Object.keys(body.lobbyStatus).sort(), ['confirmedSeatCount', 'queueCount', 'schemaVersion', 'seatCount']);
  assert.equal(body.lobbyStatus.seatCount, 16);
  assert.equal(body.lobbyStatus.confirmedSeatCount, 8);
  assert.equal(body.lobbyStatus.queueCount, 12);
  await app.close();
});

test('a null status is a 200, not an error -- an unrecognised token, an unentitled channel and a channel with no open lobby are one answer', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return null; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().lobbyStatus, null);
  await app.close();
});

test('§16: a store that hands up a room code, a password, a seat token or a player identifier gets none of it past the route', async () => {
  // The SQL function cannot produce any of these -- its declared result
  // type is three integer columns and the schema has no such column. This
  // is the SECOND, independent narrowing, so the guarantee does not rest
  // on one layer holding.
  const leaking = {
    ...status,
    roomCode: 'BGMI-4417',
    password: 'hunter2',
    seatToken: 'st_9f2c',
    playerId: '00000000-0000-4000-8000-0000000000a1',
    playerName: 'Riya',
    inGameName: 'RIYA_OP',
    discordName: 'riya#1234',
    viewerId: '00000000-0000-4000-8000-0000000000a2',
    anonymousIdentityId: '00000000-0000-4000-8000-0000000000a3',
    sessionId: '00000000-0000-4000-8000-0000000000a4',
    ipAddress: '203.0.113.7',
    initials: 'RS',
    avatarUrl: 'https://cdn.example.invalid/a.png',
    participants: [{ name: 'Riya' }],
  } as unknown as OverlayLobbyStatus;

  const app = await buildOverlayApp({ async getForOverlay() { return leaking; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  const keys = Object.keys(response.json().lobbyStatus);
  assert.deepEqual(keys.sort(), ['confirmedSeatCount', 'queueCount', 'schemaVersion', 'seatCount']);
  const raw = response.body;
  for (const forbidden of ['roomCode', 'password', 'seatToken', 'playerId', 'playerName', 'inGameName', 'discordName', 'viewerId', 'anonymousIdentityId', 'sessionId', 'ipAddress', 'initials', 'avatarUrl', 'participants', 'BGMI-4417', 'hunter2', 'Riya']) {
    assert.ok(!raw.includes(forbidden), `${forbidden} must not appear anywhere in the overlay response body`);
  }
  await app.close();
});

test('an internally inconsistent status is dropped to null rather than painted', async () => {
  // 0140's own check constraint means the database cannot produce any of
  // these, so a value that fails here is evidence something upstream is
  // wrong -- and a nonsense figure on a broadcast overlay is worse than an
  // absent card.
  for (const bad of [
    { schemaVersion: 'v1', seatCount: 8, confirmedSeatCount: 9, queueCount: 0 },
    { schemaVersion: 'v1', seatCount: 0, confirmedSeatCount: 0, queueCount: 0 },
    { schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: -1, queueCount: 0 },
    { schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 1.5, queueCount: 0 },
    { schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 1, queueCount: -3 },
    { schemaVersion: 'v0', seatCount: 16, confirmedSeatCount: 1, queueCount: 1 },
  ] as unknown as OverlayLobbyStatus[]) {
    const app = await buildOverlayApp({ async getForOverlay() { return bad; } });
    const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().lobbyStatus, null, `${JSON.stringify(bad)} must not be rendered`);
    await app.close();
  }
});

test('a throwing store is a retryable 503, never a partial answer', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { throw new Error('boom'); } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});

test('projectOverlayLobbyStatus is the narrowing, and it is total', () => {
  assert.equal(projectOverlayLobbyStatus(null), null);
  assert.equal(projectOverlayLobbyStatus(undefined), null);
  assert.equal(projectOverlayLobbyStatus('16/8'), null);
  assert.equal(projectOverlayLobbyStatus([status]), null);
  assert.deepEqual(projectOverlayLobbyStatus(status), status);
  // A lobby with every seat confirmed and an empty queue is a perfectly
  // ordinary, valid state -- 16/16 with nobody waiting.
  assert.deepEqual(
    projectOverlayLobbyStatus({ schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 16, queueCount: 0 }),
    { schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 16, queueCount: 0 },
  );
});

// =====================================================================
// The creator routes. NEVER TIER-GATED (§12.6) -- there is no tier check
// in routes/lobby-session.ts at all, and these cases run without any
// entitlement anywhere in the harness.
// =====================================================================

test('the creator reads their own current lobby, and a missing store is a 503 rather than a false "no lobby"', async () => {
  const app = await buildCreatorApp({ async getCurrent() { return lobby; } });
  const response = await app.inject({ method: 'GET', url: sessionUrl, headers: authHeaders });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().lobby.lobbyId, lobbyId);

  const noStore = await buildCreatorApp(undefined);
  const unavailable = await noStore.inject({ method: 'GET', url: sessionUrl, headers: authHeaders });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().retryable, true);
  await app.close();
  await noStore.close();
});

test('opening a lobby is a 201; a second one is a 409, never a silent supersede', async () => {
  const opened = await buildCreatorApp({ async open() { return { outcome: 'ok', lobby }; } });
  const created = await opened.inject({ method: 'POST', url: sessionUrl, headers: authHeaders, payload: { seatCount: 16 } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().lobby.seatCount, 16);

  const conflicting = await buildCreatorApp({ async open() { return { outcome: 'conflict' }; } });
  const conflict = await conflicting.inject({ method: 'POST', url: sessionUrl, headers: authHeaders, payload: { seatCount: 8 } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().errorCode, 'lobby_session_already_open');
  await opened.close();
  await conflicting.close();
});

test('a non-owner/admin gets 404, never a leaking 403', async () => {
  const app = await buildCreatorApp({ async open() { return { outcome: 'forbidden' }; } });
  const response = await app.inject({ method: 'POST', url: sessionUrl, headers: authHeaders, payload: { seatCount: 16 } });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().errorCode, 'not_found');
  await app.close();
});

test('§16 and owner decision 4: a body carrying a room code, a password, a seat token, a player name or a ready check is a 400 before the store is reached', async () => {
  let storeCalls = 0;
  const app = await buildCreatorApp({ async open() { storeCalls += 1; return { outcome: 'ok', lobby }; } });
  for (const extra of [
    { roomCode: 'BGMI-4417' },
    { password: 'hunter2' },
    { seatToken: 'st_9f2c' },
    { playerName: 'Riya' },
    { inGameName: 'RIYA_OP' },
    { discordName: 'riya#1234' },
    { viewerId: '00000000-0000-4000-8000-0000000000a1' },
    { participants: ['Riya'] },
    { initials: 'RS' },
    { avatarUrl: 'https://cdn.example.invalid/a.png' },
    // The Lobby Engine's own knobs. Phase 3, and refused here so nothing
    // can introduce them through a body.
    { readyCheck: true },
    { selectionPolicy: 'fifo' },
    { queuePolicy: 'creator_pick' },
    { reserveSeats: 4 },
    { durationSeconds: 900 },
    { expiresAt: '2026-09-16T11:00:00.000Z' },
  ]) {
    const response = await app.inject({ method: 'POST', url: sessionUrl, headers: authHeaders, payload: { seatCount: 16, ...extra } });
    assert.equal(response.statusCode, 400, `${Object.keys(extra)[0]} must be refused by the schema`);
  }
  assert.equal(storeCalls, 0, 'not one of those bodies may reach the store');
  await app.close();
});

test('a seat count below 1, fractional, or outside the column range is a 400 at the schema layer', async () => {
  let storeCalls = 0;
  const app = await buildCreatorApp({ async open() { storeCalls += 1; return { outcome: 'ok', lobby }; } });
  for (const seatCount of [0, -1, 1.5, 2147483648]) {
    const response = await app.inject({ method: 'POST', url: sessionUrl, headers: authHeaders, payload: { seatCount } });
    assert.equal(response.statusCode, 400, `seatCount ${seatCount} must be refused`);
  }
  const missing = await app.inject({ method: 'POST', url: sessionUrl, headers: authHeaders, payload: {} });
  assert.equal(missing.statusCode, 400);
  assert.equal(storeCalls, 0);
  await app.close();
});

test('the counts are written together, and more confirmed seats than the lobby has is a 400', async () => {
  const ok = await buildCreatorApp({ async updateCounts() { return { outcome: 'ok', lobby }; } });
  const updated = await ok.inject({
    method: 'PATCH', url: `${sessionUrl}/${lobbyId}`, headers: authHeaders, payload: { confirmedSeatCount: 8, queueCount: 12 },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().lobby.confirmedSeatCount, 8);

  // One count alone is refused: they are read together on one card, so a
  // partial write would paint a seat figure from one moment beside a queue
  // figure from another.
  for (const partial of [{ confirmedSeatCount: 8 }, { queueCount: 12 }]) {
    const response = await ok.inject({ method: 'PATCH', url: `${sessionUrl}/${lobbyId}`, headers: authHeaders, payload: partial });
    assert.equal(response.statusCode, 400);
  }

  const invalid = await buildCreatorApp({ async updateCounts() { return { outcome: 'invalid' }; } });
  const refused = await invalid.inject({
    method: 'PATCH', url: `${sessionUrl}/${lobbyId}`, headers: authHeaders, payload: { confirmedSeatCount: 99, queueCount: 0 },
  });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().errorCode, 'invalid_lobby_counts');
  await ok.close();
  await invalid.close();
});

test('an unknown, closed, other-channel or unauthorised lobby is one indistinguishable 404 on both write paths', async () => {
  const app = await buildCreatorApp({
    async updateCounts() { return { outcome: 'not_found' }; },
    async close() { return { outcome: 'not_found' }; },
  });
  const patched = await app.inject({
    method: 'PATCH', url: `${sessionUrl}/${lobbyId}`, headers: authHeaders, payload: { confirmedSeatCount: 1, queueCount: 1 },
  });
  assert.equal(patched.statusCode, 404);
  const closed = await app.inject({ method: 'POST', url: `${sessionUrl}/${lobbyId}/close`, headers: authHeaders });
  assert.equal(closed.statusCode, 404);
  await app.close();
});

test('closing is a 204 and returns no body -- the durable record is not deleted, and nothing is claimed about it here', async () => {
  const app = await buildCreatorApp({ async close() { return { outcome: 'ok' }; } });
  const response = await app.inject({ method: 'POST', url: `${sessionUrl}/${lobbyId}/close`, headers: authHeaders });
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  await app.close();
});
