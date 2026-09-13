import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerStickerRoutes } from '../src/routes/stickers.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import type {
  CreatorPackSelectionStore, CreatorPackStickerSummary, CreatorPackStore, PublicCreatorPackStore,
} from '../src/domain/sticker-creator-pack.js';

// L22 gap-fill: creator-pack routes tested directly against a bare
// Fastify instance, same rationale as l22-stickers-routes.test.ts — this
// lane owns routes/stickers.ts but deliberately does not edit app.ts.

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const packStickerId = '00000000-0000-4000-8000-000000000091';
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

function fakeSummary(overrides: Partial<CreatorPackStickerSummary> = {}): CreatorPackStickerSummary {
  return {
    id: packStickerId, displayName: 'My Wave', category: 'Reaction', byteSize: 42,
    enabled: true, status: 'active', creatorAttested: true,
    updatedAt: '2026-09-01T00:00:00.000Z', ...overrides,
  };
}

const validLottie = { v: '1.0', layers: [] };

async function buildTestApp(
  creatorPack?: Partial<CreatorPackStore>,
  publicCreatorPack?: Partial<PublicCreatorPackStore>,
  creatorPackSelections?: Partial<CreatorPackSelectionStore>,
) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerStickerRoutes(
    app, sessions, undefined, account, undefined, undefined,
    creatorPack as CreatorPackStore | undefined,
    publicCreatorPack as PublicCreatorPackStore | undefined,
    creatorPackSelections as CreatorPackSelectionStore | undefined,
  );
  return app;
}

test('GET sticker-pack (creator) returns the pack the store hands back', async () => {
  const items = [fakeSummary(), fakeSummary({ id: '00000000-0000-4000-8000-000000000092', status: 'pending_review' })];
  const app = await buildTestApp({ async listForChannel() { return items; } });
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/sticker-pack`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items, items);
  await app.close();
});

test('GET sticker-pack (creator) rejects an unauthenticated caller', async () => {
  const app = await buildTestApp({ async listForChannel() { return []; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/sticker-pack` });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('POST sticker-pack uploads a valid asset and reports its status', async () => {
  const app = await buildTestApp({
    async upload(uid, cid, name, category, assetBytes, attested) {
      assert.equal(uid, userId); assert.equal(cid, channelId);
      assert.equal(name, 'My Wave'); assert.equal(category, 'Reaction'); assert.equal(attested, true);
      assert.equal(JSON.parse(assetBytes.toString('utf8')).v, '1.0');
      return { outcome: 'created', id: packStickerId, status: 'active' };
    },
  });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/sticker-pack`,
    headers: { authorization: `Bearer ${token}` },
    payload: { displayName: 'My Wave', category: 'Reaction', renderDocument: validLottie, creatorAttested: true },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().status, 'active');
  await app.close();
});

test('POST sticker-pack rejects an unsafe render document before reaching the store', async () => {
  const app = await buildTestApp({ async upload() { throw new Error('must not be called'); } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/sticker-pack`,
    headers: { authorization: `Bearer ${token}` },
    payload: { displayName: 'Bad', category: 'Reaction', renderDocument: { v: '1.0', layers: [], expr: 'evil()' }, creatorAttested: true },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'invalid_creator_pack_asset');
  await app.close();
});

test('POST sticker-pack surfaces tier_not_eligible as 403', async () => {
  const app = await buildTestApp({ async upload() { return { outcome: 'tier_not_eligible' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/sticker-pack`,
    headers: { authorization: `Bearer ${token}` },
    payload: { displayName: 'My Wave', category: 'Reaction', renderDocument: validLottie, creatorAttested: true },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'creator_pack_not_available');
  await app.close();
});

test('POST sticker-pack surfaces attestation_required as 403', async () => {
  const app = await buildTestApp({ async upload() { return { outcome: 'attestation_required' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/sticker-pack`,
    headers: { authorization: `Bearer ${token}` },
    payload: { displayName: 'My Wave', category: 'Reaction', renderDocument: validLottie, creatorAttested: false },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'attestation_required');
  await app.close();
});

test('POST sticker-pack surfaces limit_reached as 403 for the next-item-over-limit case', async () => {
  const app = await buildTestApp({ async upload() { return { outcome: 'limit_reached' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/sticker-pack`,
    headers: { authorization: `Bearer ${token}` },
    payload: { displayName: 'One Too Many', category: 'Reaction', renderDocument: validLottie, creatorAttested: true },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'creator_pack_limit_reached');
  await app.close();
});

test('PATCH sticker-pack turns a pack sticker off and reports the new state', async () => {
  const app = await buildTestApp({ async setEnabled() { return { outcome: 'ok', enabled: false }; } });
  const response = await app.inject({
    method: 'PATCH', url: `/v1/channels/${channelId}/sticker-pack/${packStickerId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { enabled: false },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().enabled, false);
  await app.close();
});

test('GET public sticker-pack returns the viewer-facing list with no auth required', async () => {
  const app = await buildTestApp(undefined, {
    async listEnabledForChannel() { return [{ id: packStickerId, displayName: 'My Wave', category: 'Reaction' }]; },
  });
  const response = await app.inject({ method: 'GET', url: `/v1/public/channels/${channelId}/sticker-pack` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items[0].displayName, 'My Wave');
  await app.close();
});

test('POST sticker-pack selections attaches a valid pack sticker to a paid order', async () => {
  const app = await buildTestApp(undefined, undefined, {
    async attach(cid, oid, sid) {
      assert.equal(cid, channelId); assert.equal(oid, orderId); assert.equal(sid, packStickerId);
      return { outcome: 'attached', selectionId: '00000000-0000-4000-8000-000000000099' };
    },
  });
  const response = await app.inject({
    method: 'POST', url: `/v1/public/channels/${channelId}/sticker-pack/selections`,
    payload: { orderId, packStickerId },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().selectionId, '00000000-0000-4000-8000-000000000099');
  await app.close();
});

test('POST sticker-pack selections rejects an unknown pack sticker id with 400, never silently drops it', async () => {
  const app = await buildTestApp(undefined, undefined, { async attach() { return { outcome: 'unknown_pack_sticker' }; } });
  const response = await app.inject({
    method: 'POST', url: `/v1/public/channels/${channelId}/sticker-pack/selections`,
    payload: { orderId, packStickerId },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'unknown_sticker');
  await app.close();
});

test('creator-pack routes return redacted retryable 503 on store outage, and 503 when unwired', async () => {
  const outage = async () => { throw new Error('synthetic database outage'); };
  const app = await buildTestApp({ listForChannel: outage }, { listEnabledForChannel: outage });
  const responses = await Promise.all([
    app.inject({ method: 'GET', url: `/v1/channels/${channelId}/sticker-pack`, headers: { authorization: `Bearer ${token}` } }),
    app.inject({ method: 'GET', url: `/v1/public/channels/${channelId}/sticker-pack` }),
  ]);
  for (const response of responses) {
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().errorCode, 'sticker_store_unavailable');
    assert.equal(JSON.stringify(response.json()).includes('database outage'), false);
  }
  const unwired = await buildTestApp(undefined);
  const unwiredResponse = await unwired.inject({ method: 'GET', url: `/v1/channels/${channelId}/sticker-pack`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(unwiredResponse.statusCode, 503);
  await app.close();
  await unwired.close();
});
