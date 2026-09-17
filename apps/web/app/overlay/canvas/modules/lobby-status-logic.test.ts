import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLobbyStatusLabel,
  formatQueueLabel,
  formatSeatsLabel,
  hasSomethingToShow,
  isLobbyStatus,
  lobbyFillRatio,
  type LobbyStatus,
} from './lobby-status-logic';

/*
 * §6 catalogue module #16 (Lobby Status). Pure-logic cases; the renderer's
 * own cases are in ./lobby-status-module.test.ts and the SQL layer's proof
 * that the read CANNOT return a code, a password or a player identifier is
 * in packages/db/tests/prf02_slice6_lobby_status.sql.
 */

const status: LobbyStatus = { schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 8, queueCount: 12 };

test('the guard accepts exactly the four declared keys', () => {
  assert.equal(isLobbyStatus(status), true);
  assert.equal(isLobbyStatus({ schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 0, queueCount: 0 }), true);
  assert.equal(isLobbyStatus({ schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 16, queueCount: 0 }), true);
});

test('§16: an extra key is REJECTED, not ignored — a room code, a password, a player identifier or a Discord name fails the guard outright', () => {
  // This is the point of the exact-keys check. Ignoring an unexpected
  // field would leave it one careless refactor away from being rendered.
  for (const [key, value] of [
    ['roomCode', 'BGMI-4417'],
    ['roomPassword', 'hunter2'],
    ['password', 'hunter2'],
    ['seatToken', 'st_9f2c'],
    ['playerId', '00000000-0000-4000-8000-0000000000a1'],
    ['playerName', 'Riya'],
    ['inGameName', 'RIYA_OP'],
    ['discordName', 'riya#1234'],
    ['viewerId', '00000000-0000-4000-8000-0000000000a2'],
    ['anonymousIdentityId', '00000000-0000-4000-8000-0000000000a3'],
    ['sessionId', '00000000-0000-4000-8000-0000000000a4'],
    ['lobbyId', '00000000-0000-4000-8000-000000005851'],
    ['ipAddress', '203.0.113.7'],
    // Permitted by §16, out of scope by owner decision: they need an
    // opt-in mechanism that does not exist.
    ['initials', 'RS'],
    ['avatarUrl', 'https://cdn.example.invalid/a.png'],
    ['participants', [{ name: 'Riya' }]],
    ['waitlist', ['Riya']],
    // The Lobby Engine's own state. Phase 3.
    ['readyCheck', true],
    ['selectionPolicy', 'fifo'],
    ['nextRound', 2],
  ] as [string, unknown][]) {
    assert.equal(isLobbyStatus({ ...status, [key]: value }), false, `${key} must fail the guard`);
  }
});

test('the guard rejects a missing key, a wrong schema version and a non-object', () => {
  assert.equal(isLobbyStatus({ schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 8 }), false);
  assert.equal(isLobbyStatus({ ...status, schemaVersion: 'v0' }), false);
  assert.equal(isLobbyStatus(null), false);
  assert.equal(isLobbyStatus(undefined), false);
  assert.equal(isLobbyStatus([status]), false);
  assert.equal(isLobbyStatus('8/16'), false);
});

test('the seat arithmetic is a guard condition, not a rendering detail', () => {
  // 0140's own check constraint means the database cannot produce "9/8
  // seats confirmed", so a payload that says so is evidence something
  // upstream is wrong -- and a nonsense figure on a live broadcast is
  // worse than an absent card.
  assert.equal(isLobbyStatus({ ...status, confirmedSeatCount: 17 }), false);
  assert.equal(isLobbyStatus({ ...status, seatCount: 0 }), false);
  assert.equal(isLobbyStatus({ ...status, seatCount: -1 }), false);
  assert.equal(isLobbyStatus({ ...status, confirmedSeatCount: -1 }), false);
  assert.equal(isLobbyStatus({ ...status, confirmedSeatCount: 1.5 }), false);
  assert.equal(isLobbyStatus({ ...status, queueCount: -1 }), false);
  assert.equal(isLobbyStatus({ ...status, queueCount: 1.5 }), false);
});

test('§16\'s own words and §16\'s own shape: "8/16 seats confirmed"', () => {
  assert.equal(formatSeatsLabel(status), '8/16 seats confirmed');
  assert.equal(formatSeatsLabel({ ...status, confirmedSeatCount: 0 }), '0/16 seats confirmed');
  assert.equal(formatSeatsLabel({ ...status, confirmedSeatCount: 16 }), '16/16 seats confirmed');
  // "seats", never "players": a seat is a thing the lobby has, a player is
  // a person, and this card never counts people.
  assert.ok(!formatSeatsLabel(status).includes('player'));
});

test('the queue half is singular at one and absent at zero', () => {
  assert.equal(formatQueueLabel(status), '12 in queue');
  assert.equal(formatQueueLabel({ ...status, queueCount: 1 }), '1 in queue');
  // An empty queue is not news, and a permanent zero beside a live seat
  // figure is chrome.
  assert.equal(formatQueueLabel({ ...status, queueCount: 0 }), '');
});

test('the whole line leads with seats and drops the queue half when it is empty', () => {
  assert.equal(formatLobbyStatusLabel(status), '8/16 seats confirmed · 12 in queue');
  assert.equal(formatLobbyStatusLabel({ ...status, queueCount: 0 }), '8/16 seats confirmed');
  assert.equal(formatLobbyStatusLabel(null), '');
});

test('the card shows whenever a lobby is open, including at zero confirmed — that is the invitation, not an empty state', () => {
  assert.equal(hasSomethingToShow(status), true);
  assert.equal(hasSomethingToShow({ schemaVersion: 'v1', seatCount: 16, confirmedSeatCount: 0, queueCount: 0 }), true);
  // null is every "nothing to say" case at once: an unrecognised, expired,
  // revoked or foreign token, no open lobby, and no entitlement.
  assert.equal(hasSomethingToShow(null), false);
});

test('the fill ratio is clamped at both ends', () => {
  assert.equal(lobbyFillRatio(status), 0.5);
  assert.equal(lobbyFillRatio({ ...status, confirmedSeatCount: 0 }), 0);
  assert.equal(lobbyFillRatio({ ...status, confirmedSeatCount: 16 }), 1);
  assert.equal(lobbyFillRatio({ schemaVersion: 'v1', seatCount: 3, confirmedSeatCount: 1, queueCount: 0 }), 1 / 3);
});

test('no label this module can produce contains a name, a code or a password', () => {
  // A property over the whole output surface rather than a spot check: the
  // only things that can reach a label are the three integers.
  for (const seatCount of [1, 5, 16, 100]) {
    for (const confirmed of [0, 1, seatCount]) {
      for (const queue of [0, 1, 7]) {
        const label = formatLobbyStatusLabel({ schemaVersion: 'v1', seatCount, confirmedSeatCount: confirmed, queueCount: queue });
        assert.ok(/^[0-9/ a-z·]*$/.test(label), `label "${label}" must be digits and fixed words only`);
      }
    }
  }
});
