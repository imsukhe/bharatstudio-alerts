import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerStickerRoutes } from '../src/routes/stickers.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import type {
  PublicStickerCatalogueStore, SetStickerEnabledResult, StickerCatalogueStore,
  StickerSelectionStore, StickerSummary,
} from '../src/domain/sticker-catalogue.js';

// registerStickerRoutes is tested directly against a bare Fastify instance
// rather than through buildApp/app.ts — this lane owns routes/stickers.ts
// but deliberately does not edit app.ts (see the task's ownership
// boundary); app.ts wiring is applied at review.

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const stickerId = '00000000-0000-4000-8000-000000000091';
const orderId = '00000000-0000-4000-8000-000000000092';
const token = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const account = {
  async hasAcceptedActiveDocuments() { return true; },
} as unknown as AccountStore;

function fakeSummary(overrides: Partial<StickerSummary> = {}): StickerSummary {
  return {
    id: stickerId, externalKey: 'BSA-STK-001', displayName: 'Confetti Pop',
    category: 'Celebration', minTier: 'free', byteSize: 42, enabled: true,
    updatedAt: '2026-09-01T00:00:00.000Z', ...overrides,
  };
}

async function buildTestApp(
  store?: Partial<StickerCatalogueStore>,
  publicStore?: Partial<PublicStickerCatalogueStore>,
  selections?: Partial<StickerSelectionStore>,
) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerStickerRoutes(
    app, sessions, store as StickerCatalogueStore | undefined, account,
    publicStore as PublicStickerCatalogueStore | undefined, selections as StickerSelectionStore | undefined,
  );
  return app;
}

test('GET (creator) returns the stickers the store hands back for the channel', async () => {
  const items = [fakeSummary(), fakeSummary({ externalKey: 'BSA-STK-002', minTier: 'studio', enabled: false })];
  const app = await buildTestApp({ async listForChannel() { return items; } });
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/stickers`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items, items);
  await app.close();
});

test('GET (creator) rejects an unauthenticated caller', async () => {
  const app = await buildTestApp({ async listForChannel() { return []; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/stickers` });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('creator and public sticker-list store outages return redacted retryable 503', async () => {
  const outage = async () => { throw new Error('synthetic database outage'); };
  const app = await buildTestApp({ listForChannel: outage }, { listEnabledForChannel: outage });
  const responses = await Promise.all([
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/stickers`, headers: { authorization: `Bearer ${token}` } }),
    app.inject({ method: 'GET', url: `/v1/public/channels/${channelId}/stickers` }),
  ]);
  for (const response of responses) {
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().errorCode, 'sticker_store_unavailable');
    assert.equal(response.json().retryable, true);
    assert.equal(JSON.stringify(response.json()).includes('database outage'), false);
  }
  await app.close();
});

test('PATCH turns a sticker off and reports the new state', async () => {
  const result: SetStickerEnabledResult = { outcome: 'ok', enabled: false };
  const app = await buildTestApp({ async setEnabled() { return result; } });
  const response = await app.inject({
    method: 'PATCH', url: `/v1/channels/${channelId}/stickers/${stickerId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { enabled: false },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().enabled, false);
  await app.close();
});

test('PATCH surfaces not_found as 404 for an unknown sticker id', async () => {
  const app = await buildTestApp({ async setEnabled() { return { outcome: 'not_found' }; } });
  const response = await app.inject({
    method: 'PATCH', url: `/v1/channels/${channelId}/stickers/${stickerId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { enabled: false },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('GET (public) returns the viewer-facing list with no auth required', async () => {
  const app = await buildTestApp(undefined, {
    async listEnabledForChannel() { return [{ id: stickerId, displayName: 'Confetti Pop', category: 'Celebration' }]; },
  });
  const response = await app.inject({ method: 'GET', url: `/v1/public/channels/${channelId}/stickers` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items[0].displayName, 'Confetti Pop');
  await app.close();
});

test('POST selections attaches a valid sticker to a paid order', async () => {
  const app = await buildTestApp(undefined, undefined, {
    async attach(cid, oid, sid) {
      assert.equal(cid, channelId); assert.equal(oid, orderId); assert.equal(sid, stickerId);
      return { outcome: 'attached', selectionId: '00000000-0000-4000-8000-000000000099' };
    },
  });
  const response = await app.inject({
    method: 'POST', url: `/v1/public/channels/${channelId}/stickers/selections`,
    payload: { orderId, stickerId },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().selectionId, '00000000-0000-4000-8000-000000000099');
  await app.close();
});

test('POST selections rejects an unknown sticker id with 400, never silently drops it', async () => {
  const app = await buildTestApp(undefined, undefined, {
    async attach() { return { outcome: 'unknown_sticker' }; },
  });
  const response = await app.inject({
    method: 'POST', url: `/v1/public/channels/${channelId}/stickers/selections`,
    payload: { orderId, stickerId },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'unknown_sticker');
  await app.close();
});

test('POST selections rejects a sticker the creator disabled', async () => {
  const app = await buildTestApp(undefined, undefined, {
    async attach() { return { outcome: 'not_available' }; },
  });
  const response = await app.inject({
    method: 'POST', url: `/v1/public/channels/${channelId}/stickers/selections`,
    payload: { orderId, stickerId },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'sticker_not_available');
  await app.close();
});

test('POST selections rejects a malformed body before reaching the store', async () => {
  const app = await buildTestApp(undefined, undefined, {
    async attach() { throw new Error('must not be called'); },
  });
  const response = await app.inject({
    method: 'POST', url: `/v1/public/channels/${channelId}/stickers/selections`,
    payload: { orderId: 'not-a-uuid', stickerId },
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test('GET (creator) returns 503 when no store is wired', async () => {
  const app = await buildTestApp(undefined);
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/stickers`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'sticker_store_unavailable');
  await app.close();
});
