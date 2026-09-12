import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { CompanionPairingStore, DevicePairingTokenResult } from '../src/domain/companion-pairing.js';
import type { CompanionControlSession } from '../src/domain/alert-store.js';

const config: RuntimeConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 4100,
  appOrigin: 'http://localhost:3100',
};

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CHANNEL_ID = '00000000-0000-4000-8000-000000000010';
const CLIENT_INSTANCE_ID = 'desktop-instance-0001';
const VALID_TOKEN = 'a'.repeat(48);

function fakeSessions(): SessionStore {
  return {
    async create() { throw new Error('not used'); },
    async lookup(token) {
      return token === VALID_TOKEN
        ? { sessionId: '00000000-0000-4000-8000-000000000041', userId: USER_ID, expiresAt: '2026-09-13T10:00:00Z' }
        : null;
    },
    async getCurrentUser(userId) { return { schemaVersion: 'v1', userId, displayName: 'Synthetic Creator', channels: [] }; },
    async list() { return []; },
    async revoke() { return true; },
  };
}

const session: CompanionControlSession = {
  schemaVersion: 'v1',
  sessionId: '00000000-0000-4000-8000-000000000401',
  channelId: CHANNEL_ID,
  clientType: 'desktop',
  clientInstanceId: CLIENT_INSTANCE_ID,
  leaseUntil: '2026-09-06T10:05:00Z',
  createdAt: '2026-09-06T10:00:00Z',
  reused: false,
};

// A small, controllable in-memory model of the real state machine
// (pending -> approved -> consumed, or -> denied/expired) so route-layer
// behavior (status codes, error mapping, auth) can be asserted without a
// database. The real transitions and their atomicity are proven separately
// against Postgres in packages/db/tests/l07_companion_device_pairing.sql.
type Row = {
  userCode: string;
  deviceCode: string;
  clientLabel: string;
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  channelId: string | null;
  lastPolledAt: number | null;
  expiresAt: number;
};

function fakePairingStore(nowFn: () => number = Date.now): { store: CompanionPairingStore; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  let counter = 0;
  const store: CompanionPairingStore = {
    async startDevicePairing(clientType, clientInstanceId, clientLabel) {
      counter += 1;
      // Must satisfy the real ^[A-HJ-NP-Z2-9]{8}$ user_code shape (no 0/O/1/I).
      const userCode = `PARCDEF${'2345678923456789'[counter]}`;
      const deviceCode = `device-secret-${counter}-${'x'.repeat(16)}`;
      rows.set(deviceCode, { userCode, deviceCode, clientLabel, state: 'pending', channelId: null, lastPolledAt: null, expiresAt: nowFn() + 10 * 60 * 1000 });
      rows.set(userCode, rows.get(deviceCode) as Row);
      return { schemaVersion: 'v1', userCode, deviceCode, expiresIn: 600, interval: 5, verificationUri: 'http://localhost:3100/companion/pair' };
    },
    async pollDeviceToken(deviceCode): Promise<DevicePairingTokenResult> {
      const row = rows.get(deviceCode);
      if (!row) return { schemaVersion: 'v1', status: 'expired_token' };
      if (row.state === 'consumed') return { schemaVersion: 'v1', status: 'expired_token' };
      if (nowFn() > row.expiresAt) { row.state = 'expired'; return { schemaVersion: 'v1', status: 'expired_token' }; }
      if (row.state === 'denied') return { schemaVersion: 'v1', status: 'access_denied' };
      if (row.state === 'pending') {
        if (row.lastPolledAt !== null && nowFn() - row.lastPolledAt < 5000) return { schemaVersion: 'v1', status: 'slow_down' };
        row.lastPolledAt = nowFn();
        return { schemaVersion: 'v1', status: 'authorization_pending' };
      }
      if (row.state === 'approved') {
        row.state = 'consumed';
        return { schemaVersion: 'v1', status: 'approved', session };
      }
      return { schemaVersion: 'v1', status: 'expired_token' };
    },
    async getPairingRequest(_userId, userCode) {
      const row = rows.get(userCode);
      if (!row || (row.state !== 'pending' && row.state !== 'approved') || nowFn() > row.expiresAt) return null;
      return { schemaVersion: 'v1', userCode: row.userCode, clientType: 'desktop', clientLabel: row.clientLabel, state: row.state, createdAt: '2026-09-06T10:00:00Z', expiresAt: new Date(row.expiresAt).toISOString() };
    },
    async approvePairing(_userId, userCode, channelId) {
      const row = rows.get(userCode);
      if (!row || row.state !== 'pending' || nowFn() > row.expiresAt) return false;
      row.state = 'approved';
      row.channelId = channelId;
      return true;
    },
    async denyPairing(_userId, userCode) {
      const row = rows.get(userCode);
      if (!row || row.state !== 'pending' || nowFn() > row.expiresAt) return false;
      row.state = 'denied';
      return true;
    },
  };
  return { store, rows };
}

test('happy path: start, approve, poll returns the reused control-session shape', async () => {
  const { store } = fakePairingStore();
  const app = await buildApp(config, { sessions: fakeSessions(), companionPairing: store });

  const start = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device', payload: { clientType: 'desktop', clientInstanceId: CLIENT_INSTANCE_ID, clientLabel: 'Living Room PC' } });
  assert.equal(start.statusCode, 201);
  const { userCode, deviceCode } = start.json();

  const view = await app.inject({ method: 'GET', url: `/v1/companion/pairing/${userCode}`, headers: { authorization: `Bearer ${VALID_TOKEN}` } });
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().state, 'pending');
  assert.equal(view.json().clientLabel, 'Living Room PC');

  const pending = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device/token', payload: { deviceCode } });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.json().status, 'authorization_pending');

  const approve = await app.inject({ method: 'POST', url: `/v1/companion/pairing/${userCode}/approve`, headers: { authorization: `Bearer ${VALID_TOKEN}` }, payload: { channelId: CHANNEL_ID } });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().approved, true);

  const redeemed = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device/token', payload: { deviceCode } });
  assert.equal(redeemed.statusCode, 200);
  assert.equal(redeemed.json().status, 'approved');
  assert.equal(redeemed.json().session.sessionId, session.sessionId);
  assert.equal(redeemed.json().session.channelId, CHANNEL_ID);

  await app.close();
});

test('single-use: a second redemption of the same deviceCode never returns a session again', async () => {
  const { store, rows } = fakePairingStore();
  const app = await buildApp(config, { sessions: fakeSessions(), companionPairing: store });
  const start = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device', payload: { clientType: 'desktop', clientInstanceId: CLIENT_INSTANCE_ID, clientLabel: 'Studio Rig' } });
  const { userCode, deviceCode } = start.json();
  (rows.get(userCode) as { state: string }).state = 'approved';

  const first = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device/token', payload: { deviceCode } });
  assert.equal(first.json().status, 'approved');

  const second = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device/token', payload: { deviceCode } });
  assert.equal(second.json().status, 'expired_token');
  assert.equal(second.json().session, undefined);
  await app.close();
});

test('expiry: a poll past expiresAt reports expired_token and never a session, even if approved', async () => {
  let now = Date.now();
  const { store, rows } = fakePairingStore(() => now);
  const app = await buildApp(config, { sessions: fakeSessions(), companionPairing: store });
  const start = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device', payload: { clientType: 'desktop', clientInstanceId: CLIENT_INSTANCE_ID, clientLabel: 'Stream Deck' } });
  const { userCode, deviceCode } = start.json();
  (rows.get(userCode) as { state: string }).state = 'approved';

  now += 11 * 60 * 1000; // past the 10-minute TTL
  const polled = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device/token', payload: { deviceCode } });
  assert.equal(polled.json().status, 'expired_token');

  const view = await app.inject({ method: 'GET', url: `/v1/companion/pairing/${userCode}`, headers: { authorization: `Bearer ${VALID_TOKEN}` } });
  assert.equal(view.statusCode, 404);
  await app.close();
});

test('wrong code: an unknown userCode 404s and an unknown deviceCode polls as expired_token, never authorization_pending', async () => {
  const { store } = fakePairingStore();
  const app = await buildApp(config, { sessions: fakeSessions(), companionPairing: store });

  const view = await app.inject({ method: 'GET', url: '/v1/companion/pairing/ZZZZZZZZ', headers: { authorization: `Bearer ${VALID_TOKEN}` } });
  assert.equal(view.statusCode, 404);

  const poll = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device/token', payload: { deviceCode: 'never-issued-device-code' } });
  assert.equal(poll.statusCode, 200);
  assert.equal(poll.json().status, 'expired_token');
  await app.close();
});

test('deny path: denied pairing polls as access_denied and never yields a session', async () => {
  const { store } = fakePairingStore();
  const app = await buildApp(config, { sessions: fakeSessions(), companionPairing: store });
  const start = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device', payload: { clientType: 'desktop', clientInstanceId: CLIENT_INSTANCE_ID, clientLabel: 'Laptop' } });
  const { userCode, deviceCode } = start.json();

  const deny = await app.inject({ method: 'POST', url: `/v1/companion/pairing/${userCode}/deny`, headers: { authorization: `Bearer ${VALID_TOKEN}` } });
  assert.equal(deny.statusCode, 200);
  assert.equal(deny.json().denied, true);

  const poll = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device/token', payload: { deviceCode } });
  assert.equal(poll.json().status, 'access_denied');
  assert.equal(poll.json().session, undefined);
  await app.close();
});

test('slow_down: polling faster than the advertised interval is throttled without consuming the code', async () => {
  let now = Date.now();
  const { store } = fakePairingStore(() => now);
  const app = await buildApp(config, { sessions: fakeSessions(), companionPairing: store });
  const start = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device', payload: { clientType: 'desktop', clientInstanceId: CLIENT_INSTANCE_ID, clientLabel: 'Fast Poller' } });
  const { deviceCode } = start.json();

  const first = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device/token', payload: { deviceCode } });
  assert.equal(first.json().status, 'authorization_pending');

  now += 1000; // well under the 5s interval
  const second = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device/token', payload: { deviceCode } });
  assert.equal(second.json().status, 'slow_down');
  await app.close();
});

test('unapproved deviceCode never returns a session, and pairing routes require auth or a store', async () => {
  const { store } = fakePairingStore();
  const app = await buildApp(config, { sessions: fakeSessions(), companionPairing: store });
  const start = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device', payload: { clientType: 'desktop', clientInstanceId: CLIENT_INSTANCE_ID, clientLabel: 'Untouched' } });
  const { deviceCode } = start.json();

  for (let i = 0; i < 3; i += 1) {
    const poll = await app.inject({ method: 'POST', url: '/v1/companion/pairing/device/token', payload: { deviceCode } });
    assert.notEqual(poll.json().status, 'approved');
    assert.equal(poll.json().session, undefined);
  }

  const unauthenticatedApprove = await app.inject({ method: 'POST', url: '/v1/companion/pairing/ZZZZZZZZ/approve', payload: { channelId: CHANNEL_ID } });
  assert.equal(unauthenticatedApprove.statusCode, 401);

  const unavailableApp = await buildApp(config, { sessions: fakeSessions() });
  const unavailable = await unavailableApp.inject({ method: 'POST', url: '/v1/companion/pairing/device', payload: { clientType: 'desktop', clientInstanceId: CLIENT_INSTANCE_ID, clientLabel: 'No store' } });
  assert.equal(unavailable.statusCode, 503);
  await unavailableApp.close();

  await app.close();
});
