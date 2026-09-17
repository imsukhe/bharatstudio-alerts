import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerMasterCanvasRoutes } from '../src/routes/master-canvas.js';
import { registerSponsorCardRoutes } from '../src/routes/sponsor-card.js';
import {
  projectOverlaySponsorCard,
  type OverlaySponsorCard,
  type SponsorCard,
  type SponsorCardOverlayStore,
  type SponsorCardStore,
} from '../src/domain/sponsor-card-store.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';

/*
 * PRF-02 slice 7, §6 catalogue module #11 (Sponsor Card).
 *
 *   GET /v1/overlay-widgets/:overlayId/sponsor-card (overlay token)
 *   GET /v1/channels/:channelId/sponsor-card         (creator session)
 *   PUT /v1/channels/:channelId/sponsor-card         (creator session)
 *
 * The route layer's own correctness surface and nothing below it. The SQL
 * layer's proof that no counter exists anywhere in the schema or the
 * shipped functions, that the returned column set on the overlay path is
 * exactly three fields, and that enabled/schedule gate visibility, lives
 * in packages/db/tests/prf02_slice7_sponsor_card.sql. This file is the
 * second, independent narrowing: even a store handing up an extra field
 * must not get it past the route.
 */

const overlayId = '00000000-0000-4000-8000-000000005b41';
const overlayUrl = `/v1/overlay-widgets/${overlayId}/sponsor-card`;
const channelId = '00000000-0000-4000-8000-000000005b11';
const userId = '00000000-0000-4000-8000-000000000001';
const sponsorCardUrl = `/v1/channels/${channelId}/sponsor-card`;

const overlayState: OverlaySponsorCard = {
  schemaVersion: 'v1',
  sponsorName: 'Acme Energy Drinks',
  logoMimeType: 'image/png',
  logoStorageKey: `${channelId}/${'ab'.repeat(32)}`,
};

const sponsorCard: SponsorCard = {
  schemaVersion: 'v1',
  sponsorCardId: '00000000-0000-4000-8000-000000005b51',
  sponsorName: 'Acme Energy Drinks',
  logoContentSha256: 'ab'.repeat(32),
  logoMimeType: 'image/png',
  logoByteSize: 4096,
  logoStorageKey: `${channelId}/${'ab'.repeat(32)}`,
  enabled: true,
  scheduleStartsAt: null,
  scheduleEndsAt: null,
  createdAt: '2026-09-17T10:00:00.000Z',
  updatedAt: '2026-09-17T10:05:00.000Z',
};

async function buildOverlayApp(store?: Partial<SponsorCardOverlayStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerMasterCanvasRoutes(
    app, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    store as SponsorCardOverlayStore | undefined,
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

async function buildCreatorApp(store?: Partial<SponsorCardStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerSponsorCardRoutes(app, sessions, store as SponsorCardStore | undefined, account);
  return app;
}

// =====================================================================
// The overlay read.
// =====================================================================

test('a missing bearer token is 401, and a missing store is a retryable 503', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return overlayState; } });
  const noToken = await app.inject({ method: 'GET', url: overlayUrl });
  assert.equal(noToken.statusCode, 401);

  const noStore = await buildOverlayApp(undefined);
  const unavailable = await noStore.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().retryable, true);
  await app.close();
  await noStore.close();
});

test('a valid read returns the sponsor name, the logo reference, the schema version, and nothing else', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return overlayState; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['schemaVersion', 'sponsorCard']);
  assert.deepEqual(Object.keys(body.sponsorCard).sort(), ['logoMimeType', 'logoStorageKey', 'schemaVersion', 'sponsorName']);
  assert.equal(body.sponsorCard.sponsorName, 'Acme Energy Drinks');
  await app.close();
});

test('a card with no logo returns null logo fields, never omitted ones', async () => {
  const nameOnly: OverlaySponsorCard = { schemaVersion: 'v1', sponsorName: 'Text-Only Sponsor', logoMimeType: null, logoStorageKey: null };
  const app = await buildOverlayApp({ async getForOverlay() { return nameOnly; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().sponsorCard, nameOnly);
  await app.close();
});

test('disabled, outside the schedule, or an unrecognised token all answer 200 with a null card, never 401', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return null; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer nope' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().sponsorCard, null);
  await app.close();
});

test('a store failure is a retryable 503, not a 200 asserting the card is off', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { throw new Error('boom'); } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});

// =====================================================================
// The route's own narrowing. THIS IS THE PROHIBITION SURFACE.
// =====================================================================

test('a store handing up a count, an impression, a schedule or an id gets none of it past the route', async () => {
  const polluted = {
    ...overlayState,
    // The whole point of the 2026-09-17 decision: nothing is counted.
    impressionCount: 4021,
    exposureCount: 4021,
    viewCount: 4021,
    shownAt: '2026-09-17T10:00:00.000Z',
    displayedAt: '2026-09-17T10:00:00.000Z',
    durationMs: 5000,
    // Fields that exist on the CREATOR projection but must never reach
    // the overlay: an id, the schedule, the enabled flag, timestamps.
    sponsorCardId: '00000000-0000-4000-8000-000000005b51',
    enabled: true,
    scheduleStartsAt: '2026-09-17T09:00:00.000Z',
    scheduleEndsAt: '2026-09-17T11:00:00.000Z',
    createdAt: '2026-09-17T10:00:00.000Z',
    updatedAt: '2026-09-17T10:05:00.000Z',
  };
  const app = await buildOverlayApp({ async getForOverlay() { return polluted as unknown as OverlaySponsorCard; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().sponsorCard, overlayState);
  await app.close();
});

test('projectOverlaySponsorCard refuses everything that is not the exact three-field shape', () => {
  assert.equal(projectOverlaySponsorCard(null), null);
  assert.equal(projectOverlaySponsorCard('nope'), null);
  assert.equal(projectOverlaySponsorCard({ ...overlayState, schemaVersion: 'v2' }), null);
  // An extra key -- a count, an id, a schedule -- is never read, which is
  // what keeps it from reaching the response; it does not reject the
  // whole payload, matching projectOverlayGiveawayTournament's own shape.
  assert.deepEqual(projectOverlaySponsorCard({ ...overlayState, impressionCount: 99 }), overlayState);
  assert.equal(projectOverlaySponsorCard({ schemaVersion: 'v1', sponsorName: 'x' }), null); // missing keys
  assert.equal(projectOverlaySponsorCard({ ...overlayState, sponsorName: '' }), null);
  assert.equal(projectOverlaySponsorCard({ ...overlayState, sponsorName: 'x'.repeat(121) }), null);
  // Logo mime type and storage key are all-or-nothing.
  assert.equal(projectOverlaySponsorCard({ ...overlayState, logoStorageKey: null }), null);
  assert.equal(projectOverlaySponsorCard({ ...overlayState, logoMimeType: null }), null);
  assert.deepEqual(projectOverlaySponsorCard(overlayState), overlayState);
  const noLogo: OverlaySponsorCard = { schemaVersion: 'v1', sponsorName: 'Text-Only Sponsor', logoMimeType: null, logoStorageKey: null };
  assert.deepEqual(projectOverlaySponsorCard(noLogo), noLogo);
});

// =====================================================================
// The creator's own read/write.
// =====================================================================

test('GET with no session is 401; with a session and no store is a retryable 503', async () => {
  const app = await buildCreatorApp({ async getCurrent() { return sponsorCard; } });
  const noAuth = await app.inject({ method: 'GET', url: sponsorCardUrl });
  assert.equal(noAuth.statusCode, 401);

  const noStore = await buildCreatorApp(undefined);
  const unavailable = await noStore.inject({ method: 'GET', url: sponsorCardUrl, headers: authHeaders });
  assert.equal(unavailable.statusCode, 503);
  await app.close();
  await noStore.close();
});

test('GET returns the current sponsor card, or null when none exists', async () => {
  const app = await buildCreatorApp({ async getCurrent() { return sponsorCard; } });
  const response = await app.inject({ method: 'GET', url: sponsorCardUrl, headers: authHeaders });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().sponsorCard, sponsorCard);
  await app.close();

  const emptyApp = await buildCreatorApp({ async getCurrent() { return null; } });
  const emptyResponse = await emptyApp.inject({ method: 'GET', url: sponsorCardUrl, headers: authHeaders });
  assert.equal(emptyResponse.statusCode, 200);
  assert.equal(emptyResponse.json().sponsorCard, null);
  await emptyApp.close();
});

const validPutBody = {
  sponsorName: 'Acme Energy Drinks',
  enabled: true,
  logoContentSha256: null,
  logoMimeType: null,
  logoByteSize: null,
  scheduleStartsAt: null,
  scheduleEndsAt: null,
};

test('PUT upserts and returns the sponsor card', async () => {
  const app = await buildCreatorApp({ async upsert() { return { outcome: 'ok', sponsorCard }; } });
  const response = await app.inject({ method: 'PUT', url: sponsorCardUrl, headers: authHeaders, payload: validPutBody });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().sponsorCard, sponsorCard);
  await app.close();
});

test('a non-owner/admin channel is 404 on PUT, never a leaking 403', async () => {
  const app = await buildCreatorApp({ async upsert() { return { outcome: 'forbidden' }; } });
  const response = await app.inject({ method: 'PUT', url: sponsorCardUrl, headers: authHeaders, payload: validPutBody });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('an invalid write is 400', async () => {
  const app = await buildCreatorApp({ async upsert() { return { outcome: 'invalid' }; } });
  const response = await app.inject({ method: 'PUT', url: sponsorCardUrl, headers: authHeaders, payload: validPutBody });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test('a body carrying an impression, exposure, count, view or shown/displayed field is a 400 before the store is ever called', async () => {
  let called = false;
  const app = await buildCreatorApp({ async upsert() { called = true; return { outcome: 'ok', sponsorCard }; } });
  for (const pollutedField of ['impressionCount', 'exposureCount', 'viewCount', 'shownAt', 'displayedAt', 'durationMs']) {
    const response = await app.inject({
      method: 'PUT', url: sponsorCardUrl, headers: authHeaders,
      payload: { ...validPutBody, [pollutedField]: 1 },
    });
    assert.equal(response.statusCode, 400, `expected 400 for a body carrying "${pollutedField}"`);
  }
  assert.equal(called, false);
  await app.close();
});

test('a sponsor name outside 1-120 characters is a 400 at the schema layer', async () => {
  const app = await buildCreatorApp({ async upsert() { return { outcome: 'ok', sponsorCard }; } });
  const empty = await app.inject({ method: 'PUT', url: sponsorCardUrl, headers: authHeaders, payload: { ...validPutBody, sponsorName: '' } });
  assert.equal(empty.statusCode, 400);
  const tooLong = await app.inject({ method: 'PUT', url: sponsorCardUrl, headers: authHeaders, payload: { ...validPutBody, sponsorName: 'x'.repeat(121) } });
  assert.equal(tooLong.statusCode, 400);
  await app.close();
});

test('a malformed logo sha256 is a 400 at the schema layer', async () => {
  const app = await buildCreatorApp({ async upsert() { return { outcome: 'ok', sponsorCard }; } });
  const response = await app.inject({
    method: 'PUT', url: sponsorCardUrl, headers: authHeaders,
    payload: { ...validPutBody, logoContentSha256: 'not-a-hash', logoMimeType: 'image/png', logoByteSize: 1024 },
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});
