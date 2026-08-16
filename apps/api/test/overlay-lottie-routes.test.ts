import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { OverlayBrandingStore, OverlayLottieAssetRef } from '../src/domain/branding.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };
const overlayId = '00000000-0000-4000-8000-000000000061';
const artifactId = '00000000-0000-4000-8000-000000000091';

function fakeOverlayBranding(refs: OverlayLottieAssetRef[], bytes: Buffer | null): OverlayBrandingStore & { seenTokens: string[] } {
  const seenTokens: string[] = [];
  return {
    seenTokens,
    async listForOverlay(token) { seenTokens.push(token); return refs; },
    async getForOverlay(token, _overlayId, _artifactId) { seenTokens.push(token); return bytes ? { bytes, mimeType: 'application/json' } : null; },
  };
}

test('the overlay-lottie list route requires a bearer token and returns the scoped slot list', async () => {
  const refs: OverlayLottieAssetRef[] = [{ displayStyle: 'celebration', artifactId }];
  const store = fakeOverlayBranding(refs, null);
  const app = await buildApp(config, { overlayBranding: store });
  const unauthorized = await app.inject({ method: 'GET', url: `/v1/overlay-lottie/${overlayId}` });
  assert.equal(unauthorized.statusCode, 401);

  const response = await app.inject({ method: 'GET', url: `/v1/overlay-lottie/${overlayId}`, headers: { authorization: 'Bearer synthetic-overlay-token' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items, refs);
  assert.equal(store.seenTokens[0], 'synthetic-overlay-token');
  await app.close();
});

test('the overlay-lottie byte-serving route returns the scoped artifact bytes with private no-store caching', async () => {
  const bytes = Buffer.from(JSON.stringify({ v: '5.0', layers: [] }), 'utf8');
  const store = fakeOverlayBranding([], bytes);
  const app = await buildApp(config, { overlayBranding: store });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-lottie/${overlayId}/${artifactId}`, headers: { authorization: 'Bearer synthetic-overlay-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/json');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(response.rawPayload, bytes);
  await app.close();
});

test('the overlay-lottie byte-serving route returns 404 for an unknown artifact and fails closed without a store', async () => {
  const store = fakeOverlayBranding([], null);
  const app = await buildApp(config, { overlayBranding: store });
  const notFound = await app.inject({ method: 'GET', url: `/v1/overlay-lottie/${overlayId}/${artifactId}`, headers: { authorization: 'Bearer synthetic-overlay-token' } });
  assert.equal(notFound.statusCode, 404);
  await app.close();

  const unavailableApp = await buildApp(config, {});
  const unavailable = await unavailableApp.inject({ method: 'GET', url: `/v1/overlay-lottie/${overlayId}/${artifactId}`, headers: { authorization: 'Bearer synthetic-overlay-token' } });
  assert.equal(unavailable.statusCode, 401);
  await unavailableApp.close();
});
