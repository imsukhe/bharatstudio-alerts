import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { BrandingStore, LottieAssetSummary, StoreLottieAssetResult } from '../src/domain/branding.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const validLottie = { v: '5.7.4', layers: [] };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

function fakeBranding(storeResult: StoreLottieAssetResult, list: LottieAssetSummary[] = [], deleteResult = true): BrandingStore & { storeCalls: { channelId: string; displayStyle: string }[] } {
  const storeCalls: { channelId: string; displayStyle: string }[] = [];
  return {
    storeCalls,
    async listAssets() { return list; },
    async storeAsset(_userId, channel, displayStyle) { storeCalls.push({ channelId: channel, displayStyle }); return storeResult; },
    async deleteAsset() { return deleteResult; },
  };
}

test('GET lists the channel\'s uploaded slots for an authenticated caller', async () => {
  const items: LottieAssetSummary[] = [{ displayStyle: 'celebration', artifactId: '00000000-0000-4000-8000-000000000091', byteSize: 128, updatedAt: '2026-08-16T10:00:00.000Z' }];
  const store = fakeBranding({ outcome: 'stored', artifactId: '00000000-0000-4000-8000-000000000091' }, items);
  const app = await buildApp(config, { sessions, branding: store });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/branding/lottie`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items, items);
  await app.close();
});

test('PUT stores a valid animation and returns its artifact id', async () => {
  const store = fakeBranding({ outcome: 'stored', artifactId: '00000000-0000-4000-8000-000000000091' });
  const app = await buildApp(config, { sessions, branding: store });
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/branding/lottie/celebration`,
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: validLottie,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().artifactId, '00000000-0000-4000-8000-000000000091');
  assert.equal(store.storeCalls[0]?.displayStyle, 'celebration');
  await app.close();
});

test('PUT rejects a structurally invalid document before ever calling the store', async () => {
  const store = fakeBranding({ outcome: 'stored', artifactId: '00000000-0000-4000-8000-000000000091' });
  const app = await buildApp(config, { sessions, branding: store });
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/branding/lottie/celebration`,
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: { v: '5.0', layers: [{ expr: 'evil()' }] },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'invalid_lottie_document');
  assert.equal(store.storeCalls.length, 0);
  await app.close();
});

test('PUT reports 403 studio_tier_required for a non-Studio channel', async () => {
  const store = fakeBranding({ outcome: 'tier_required' });
  const app = await buildApp(config, { sessions, branding: store });
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/branding/lottie/celebration`,
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: validLottie,
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'studio_tier_required');
  await app.close();
});

test('PUT reports 404 for a channel the caller does not belong to', async () => {
  const store = fakeBranding({ outcome: 'forbidden' });
  const app = await buildApp(config, { sessions, branding: store });
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/branding/lottie/celebration`,
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: validLottie,
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('PUT rejects an unknown displayStyle at the route schema layer', async () => {
  const store = fakeBranding({ outcome: 'stored', artifactId: '00000000-0000-4000-8000-000000000091' });
  const app = await buildApp(config, { sessions, branding: store });
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/branding/lottie/not_a_real_style`,
    headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    payload: validLottie,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(store.storeCalls.length, 0);
  await app.close();
});

test('DELETE removes an existing slot and reports 404 for an absent one', async () => {
  const app = await buildApp(config, { sessions, branding: fakeBranding({ outcome: 'stored', artifactId: '00000000-0000-4000-8000-000000000091' }, [], true) });
  const response = await app.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/branding/lottie/celebration`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 204);
  await app.close();

  const notFoundApp = await buildApp(config, { sessions, branding: fakeBranding({ outcome: 'stored', artifactId: '00000000-0000-4000-8000-000000000091' }, [], false) });
  const notFound = await notFoundApp.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/branding/lottie/celebration`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(notFound.statusCode, 404);
  await notFoundApp.close();
});

test('all branding routes reject unauthenticated callers and fail closed without a store', async () => {
  const app = await buildApp(config, { sessions });
  const unauthGet = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/branding/lottie` });
  assert.equal(unauthGet.statusCode, 401);
  const unauthPut = await app.inject({ method: 'PUT', url: `/v1/channels/${channelId}/branding/lottie/celebration`, payload: validLottie });
  assert.equal(unauthPut.statusCode, 401);

  const unavailable = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/branding/lottie`, headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().errorCode, 'branding_store_unavailable');
  await app.close();
});
