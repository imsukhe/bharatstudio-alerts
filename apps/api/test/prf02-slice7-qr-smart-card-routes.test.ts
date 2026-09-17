import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerMasterCanvasRoutes } from '../src/routes/master-canvas.js';
import { registerQrSmartCardRoutes } from '../src/routes/qr-smart-card.js';
import {
  projectOverlayQrSmartCard,
  QR_SMART_CARD_TEXT_MAX_LENGTH,
  QR_SMART_CARD_TEXT_MIN_LENGTH,
  type OverlayQrSmartCard,
  type QrSmartCard,
  type QrSmartCardOverlayStore,
  type QrSmartCardStore,
} from '../src/domain/qr-smart-card-store.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';

/*
 * PRF-02 slice 7, §6 catalogue module #10 (QR Smart Card).
 *
 *   GET  /v1/overlay-widgets/:overlayId/qr-smart-card    (overlay token)
 *   GET  /v1/channels/:channelId/qr-smart-card            (creator session)
 *   PUT  /v1/channels/:channelId/qr-smart-card            (creator session)
 *   PUT  /v1/channels/:channelId/qr-smart-card/enabled    (creator session)
 *
 * The route layer's own correctness surface and nothing below it. The SQL
 * layer's proof that the overlay read returns exactly destination/label,
 * that toggling before a card exists is a not-found, and that no
 * scene/scan/view/impression/exposure column exists anywhere, lives in
 * packages/db/tests/prf02_slice7_qr_smart_card.sql. This file is the
 * second, independent narrowing: even a store handing up a scan count or
 * an enabled flag on the overlay path must not get it past the route.
 */

const overlayId = '00000000-0000-4000-8000-000000006610';
const overlayUrl = `/v1/overlay-widgets/${overlayId}/qr-smart-card`;
const channelId = '00000000-0000-4000-8000-000000000011';
const userId = '00000000-0000-4000-8000-000000000001';
const channelUrl = `/v1/channels/${channelId}/qr-smart-card`;
const enabledUrl = `/v1/channels/${channelId}/qr-smart-card/enabled`;

const overlayCard: OverlayQrSmartCard = {
  schemaVersion: 'v1',
  destination: 'https://bharatstudio.in/creator/synthetic-a',
  label: 'Follow on BharatStudio',
};

function fakeCard(overrides: Partial<QrSmartCard> = {}): QrSmartCard {
  return {
    schemaVersion: 'v1',
    destination: 'https://bharatstudio.in/creator/synthetic-a',
    label: 'Follow on BharatStudio',
    isEnabled: true,
    createdAt: '2026-09-17T10:00:00.000Z',
    updatedAt: '2026-09-17T10:05:00.000Z',
    ...overrides,
  };
}

async function buildOverlayApp(store?: Partial<QrSmartCardOverlayStore>) {
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
    undefined,
    // slice-7 merge: positions 10, 11 and 12 are overlayMediaQueue,
    // overlaySafeSoundboard and overlaySponsorCard, so the QR store is
    // 13th. The call is positional, so the gap is written out.
    undefined,
    undefined,
    undefined,
    store as QrSmartCardOverlayStore | undefined,
  );
  return app;
}

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

async function buildCreatorApp(store?: Partial<QrSmartCardStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerQrSmartCardRoutes(app, sessions, store as QrSmartCardStore | undefined, account);
  return app;
}

// =====================================================================
// The overlay read.
// =====================================================================

test('a missing bearer token is 401, and a missing store is a retryable 503', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return overlayCard; } });
  const noToken = await app.inject({ method: 'GET', url: overlayUrl });
  assert.equal(noToken.statusCode, 401);
  await app.close();

  const noStore = await buildOverlayApp(undefined);
  const unavailable = await noStore.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().retryable, true);
  await noStore.close();
});

test('a valid read returns exactly destination, label and the schema version -- nothing else', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return overlayCard; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['qrSmartCard', 'schemaVersion']);
  assert.deepEqual(Object.keys(body.qrSmartCard).sort(), ['destination', 'label', 'schemaVersion']);
  assert.equal(body.qrSmartCard.destination, overlayCard.destination);
  assert.equal(body.qrSmartCard.label, overlayCard.label);
  await app.close();
});

test('an unrecognised token, a never-configured channel, and a disabled card all answer 200 with qrSmartCard: null -- never 401 for the last two', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return null; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer nope' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().qrSmartCard, null);
  await app.close();
});

test('a store failure is a retryable 503, not a 200 asserting no card', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { throw new Error('boom'); } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});

// =====================================================================
// The route's own narrowing. THIS IS THE PROHIBITION SURFACE.
// =====================================================================

test('a store handing up a scan count, an enabled flag, a card id or a scene id gets none of it past the route', async () => {
  const polluted = {
    ...overlayCard,
    scanCount: 4821,
    viewCount: 4821,
    impressionCount: 4821,
    exposureCount: 4821,
    isEnabled: true,
    cardId: '00000000-0000-4000-8000-000000006699',
    channelId,
    sceneId: '00000000-0000-4000-8000-0000000000ee',
    createdAt: '2026-09-17T10:00:00.000Z',
    updatedAt: '2026-09-17T10:05:00.000Z',
  };
  const app = await buildOverlayApp({ async getForOverlay() { return polluted as unknown as OverlayQrSmartCard; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().qrSmartCard, overlayCard);
  await app.close();
});

test('projectOverlayQrSmartCard refuses everything that is not exactly a bounded destination and label', () => {
  assert.equal(projectOverlayQrSmartCard(null), null);
  assert.equal(projectOverlayQrSmartCard({ schemaVersion: 'v1', destination: '', label: 'ok' } as unknown as OverlayQrSmartCard), null);
  assert.equal(projectOverlayQrSmartCard({ schemaVersion: 'v1', destination: 'a'.repeat(121), label: 'ok' } as unknown as OverlayQrSmartCard), null);
  assert.equal(projectOverlayQrSmartCard({ schemaVersion: 'v1', destination: 'ok', label: '' } as unknown as OverlayQrSmartCard), null);
  assert.equal(projectOverlayQrSmartCard({ schemaVersion: 'v1', destination: 42, label: 'ok' } as unknown as OverlayQrSmartCard), null);
  assert.deepEqual(projectOverlayQrSmartCard(overlayCard), overlayCard);
});

// =====================================================================
// The creator-facing read.
// =====================================================================

test('GET returns the store\'s card, or card: null with no fabrication', async () => {
  const app = await buildCreatorApp({ async getCurrent() { return fakeCard(); } });
  const response = await app.inject({ method: 'GET', url: channelUrl, headers: authHeaders });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().card.destination, overlayCard.destination);
  await app.close();

  const nullApp = await buildCreatorApp({ async getCurrent() { return null; } });
  const nullResponse = await nullApp.inject({ method: 'GET', url: channelUrl, headers: authHeaders });
  assert.equal(nullResponse.statusCode, 200);
  assert.equal(nullResponse.json().card, null);
  await nullApp.close();
});

test('GET without a valid session is 401, and the store is never called', async () => {
  let called = false;
  const app = await buildCreatorApp({ async getCurrent() { called = true; return null; } });
  const response = await app.inject({ method: 'GET', url: channelUrl });
  assert.equal(response.statusCode, 401);
  assert.equal(called, false);
  await app.close();
});

test('GET without a configured store is a retryable 503, never a 200 with fabricated data', async () => {
  const app = await buildCreatorApp(undefined);
  const response = await app.inject({ method: 'GET', url: channelUrl, headers: authHeaders });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'qr_smart_card_store_unavailable');
  assert.equal(response.json().retryable, true);
  await app.close();
});

// =====================================================================
// PUT .../qr-smart-card (upsert destination/label).
// =====================================================================

test('the bound is exactly 1-120, taken from the domain constants (migration 0109 line 67, reused)', () => {
  assert.equal(QR_SMART_CARD_TEXT_MIN_LENGTH, 1);
  assert.equal(QR_SMART_CARD_TEXT_MAX_LENGTH, 120);
});

test('PUT passes destination and label through unchanged and returns 200 with the saved card', async () => {
  let receivedArgs: unknown[] = [];
  const app = await buildCreatorApp({
    async upsert(...args) { receivedArgs = args; return { outcome: 'ok', card: fakeCard({ destination: 'https://x.io/new', label: 'New label' }) }; },
  });
  const response = await app.inject({
    method: 'PUT', url: channelUrl, headers: authHeaders,
    payload: { destination: 'https://x.io/new', label: 'New label' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().card.destination, 'https://x.io/new');
  assert.equal(response.json().card.label, 'New label');
  assert.deepEqual(receivedArgs, [userId, channelId, 'https://x.io/new', 'New label']);
  await app.close();
});

test('PUT accepts a 120-character destination/label and rejects 121 characters or empty, at the schema layer, before the store is ever called', async () => {
  let called = 0;
  const app = await buildCreatorApp({
    async upsert() { called += 1; return { outcome: 'ok', card: fakeCard() }; },
  });

  const atBound = await app.inject({
    method: 'PUT', url: channelUrl, headers: authHeaders,
    payload: { destination: 'a'.repeat(120), label: 'b'.repeat(120) },
  });
  assert.equal(atBound.statusCode, 200);
  assert.equal(called, 1);

  const overBound = await app.inject({
    method: 'PUT', url: channelUrl, headers: authHeaders,
    payload: { destination: 'a'.repeat(121), label: 'ok' },
  });
  assert.equal(overBound.statusCode, 400);
  assert.equal(called, 1, 'a 121-character destination must never reach the store');

  const empty = await app.inject({
    method: 'PUT', url: channelUrl, headers: authHeaders,
    payload: { destination: '', label: 'ok' },
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(called, 1, 'an empty destination must never reach the store');
  await app.close();
});

test('PUT rejects a body carrying a scan count, an allow-list, a short-link flag or a scene id -- this module holds no such concept', async () => {
  let called = 0;
  const app = await buildCreatorApp({ async upsert() { called += 1; return { outcome: 'ok', card: fakeCard() }; } });
  for (const extra of [
    { scanCount: 0 }, { allowedDestinations: ['https://x.io'] }, { shortLink: true }, { sceneId: '00000000-0000-4000-8000-0000000000ee' },
  ]) {
    const response = await app.inject({
      method: 'PUT', url: channelUrl, headers: authHeaders,
      payload: { destination: 'https://x.io/ok', label: 'OK', ...extra },
    });
    assert.equal(response.statusCode, 400, `${Object.keys(extra)[0]} must be rejected by the route schema`);
  }
  assert.equal(called, 0, 'a body carrying an unauthorised field must never reach the store');
  await app.close();
});

test('PUT maps a forbidden outcome (non-owner/admin) to 404, never a leaking 403', async () => {
  const app = await buildCreatorApp({ async upsert() { return { outcome: 'forbidden' }; } });
  const response = await app.inject({
    method: 'PUT', url: channelUrl, headers: authHeaders,
    payload: { destination: 'https://x.io/ok', label: 'Not my channel' },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().errorCode, 'not_found');
  await app.close();
});

test('PUT maps an invalid outcome to 400 and a thrown store error to a retryable 503, never a 500', async () => {
  const invalidApp = await buildCreatorApp({ async upsert() { return { outcome: 'invalid' }; } });
  const invalid = await invalidApp.inject({
    method: 'PUT', url: channelUrl, headers: authHeaders,
    payload: { destination: 'https://x.io/ok', label: 'Valid on the wire' },
  });
  assert.equal(invalid.statusCode, 400);
  await invalidApp.close();

  const throwingApp = await buildCreatorApp({ async upsert() { throw new Error('db down'); } });
  const thrown = await throwingApp.inject({
    method: 'PUT', url: channelUrl, headers: authHeaders,
    payload: { destination: 'https://x.io/ok', label: 'Valid on the wire' },
  });
  assert.equal(thrown.statusCode, 503);
  assert.equal(thrown.json().retryable, true);
  await throwingApp.close();
});

// =====================================================================
// PUT .../qr-smart-card/enabled (the single toggle).
// =====================================================================

test('PUT /enabled passes the value through unchanged and returns 200 with the card', async () => {
  let receivedArgs: unknown[] = [];
  const app = await buildCreatorApp({
    async setEnabled(...args) { receivedArgs = args; return { outcome: 'ok', card: fakeCard({ isEnabled: false }) }; },
  });
  const response = await app.inject({
    method: 'PUT', url: enabledUrl, headers: authHeaders, payload: { enabled: false },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().card.isEnabled, false);
  assert.deepEqual(receivedArgs, [userId, channelId, false]);
  await app.close();
});

test('PUT /enabled rejects a non-boolean/missing value at the schema layer', async () => {
  let called = 0;
  const app = await buildCreatorApp({ async setEnabled() { called += 1; return { outcome: 'ok', card: fakeCard() }; } });
  for (const payload of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }]) {
    const response = await app.inject({ method: 'PUT', url: enabledUrl, headers: authHeaders, payload });
    assert.equal(response.statusCode, 400, `${JSON.stringify(payload)} must be rejected`);
  }
  assert.equal(called, 0);
  await app.close();
});

test('PUT /enabled maps not_found (never configured, or non-owner/admin) to 404 -- never an implicit create', async () => {
  const app = await buildCreatorApp({ async setEnabled() { return { outcome: 'not_found' }; } });
  const response = await app.inject({ method: 'PUT', url: enabledUrl, headers: authHeaders, payload: { enabled: true } });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().errorCode, 'not_found');
  await app.close();
});

test('PUT /enabled degrades to a retryable 503 on a thrown store error', async () => {
  const app = await buildCreatorApp({ async setEnabled() { throw new Error('db down'); } });
  const response = await app.inject({ method: 'PUT', url: enabledUrl, headers: authHeaders, payload: { enabled: true } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});

test('neither write route is reachable without a valid session', async () => {
  const app = await buildCreatorApp({
    async upsert() { return { outcome: 'ok', card: fakeCard() }; },
    async setEnabled() { return { outcome: 'ok', card: fakeCard() }; },
  });
  const put = await app.inject({ method: 'PUT', url: channelUrl, payload: { destination: 'https://x.io/ok', label: 'OK' } });
  assert.equal(put.statusCode, 401);
  const toggle = await app.inject({ method: 'PUT', url: enabledUrl, payload: { enabled: true } });
  assert.equal(toggle.statusCode, 401);
  await app.close();
});
