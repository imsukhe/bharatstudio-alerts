import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerMasterCanvasRoutes } from '../src/routes/master-canvas.js';
import { registerCanvasLayoutRoutes } from '../src/routes/canvas-layout.js';
import {
  projectOverlayCanvasLayout,
  type CanvasLayoutOverlayStore,
  type CanvasLayoutStore,
  type ChannelCanvasLayout,
  type OverlayCanvasLayout,
} from '../src/domain/canvas-layout-store.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';

/*
 * PRF-02 slice 7, §6 module #14 (Vertical Stream Layout, migration 0147).
 *
 *   GET  /v1/overlay-widgets/:overlayId/canvas-layout   (overlay token)
 *   GET  /v1/channels/:channelId/canvas-layout           (creator session)
 *   PUT  /v1/channels/:channelId/canvas-layout            (creator session)
 *
 * The route layer's own correctness surface and nothing below it. The SQL
 * layer's proof that a layout is not a module (no master_canvas_modules
 * row, no cap slot consumed), that a sub-Pro channel's overlay read
 * receives 'horizontal', and that the four retired keys are rejected,
 * lives in packages/db/tests/prf02_slice7_vertical_layout.sql. This file
 * is the second, independent narrowing: even a store handing up a
 * channel id or a variant field on the overlay path must not get it past
 * the route.
 */

const overlayId = '00000000-0000-4000-8000-000000005e10';
const overlayUrl = `/v1/overlay-widgets/${overlayId}/canvas-layout`;
const channelId = '00000000-0000-4000-8000-000000000011';
const userId = '00000000-0000-4000-8000-000000000001';
const channelUrl = `/v1/channels/${channelId}/canvas-layout`;

const overlayLayout: OverlayCanvasLayout = {
  schemaVersion: 'v1',
  layout: 'vertical',
};

function fakeChannelLayout(overrides: Partial<ChannelCanvasLayout> = {}): ChannelCanvasLayout {
  return {
    schemaVersion: 'v1',
    layout: 'vertical',
    verticalEntitled: true,
    ...overrides,
  };
}

async function buildOverlayApp(store?: Partial<CanvasLayoutOverlayStore>) {
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
    undefined,
    undefined,
    undefined,
    undefined,
    // Position 14: every existing slice's overlay dependency (positions
    // 5-13) is left undefined here since this file exercises only the
    // canvas-layout overlay read. The call is positional, so the gap is
    // written out, same as every other slice-7 route test file already
    // does relative to its own dependency's position.
    store as CanvasLayoutOverlayStore | undefined,
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

async function buildCreatorApp(store?: Partial<CanvasLayoutStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerCanvasLayoutRoutes(app, sessions, store as CanvasLayoutStore | undefined, account);
  return app;
}

// =====================================================================
// The overlay read.
// =====================================================================

test('a missing bearer token is 401, and a missing store is a retryable 503', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return overlayLayout; } });
  const noToken = await app.inject({ method: 'GET', url: overlayUrl });
  assert.equal(noToken.statusCode, 401);
  await app.close();

  const noStore = await buildOverlayApp(undefined);
  const unavailable = await noStore.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().retryable, true);
  await noStore.close();
});

test('a valid read returns exactly layout and the schema version -- nothing else', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return overlayLayout; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['canvasLayout', 'schemaVersion']);
  assert.deepEqual(Object.keys(body.canvasLayout).sort(), ['layout', 'schemaVersion']);
  assert.equal(body.canvasLayout.layout, 'vertical');
  await app.close();
});

test('a sub-Pro channel answers 200 with layout: horizontal, exactly like the SQL layer -- the route never re-derives or overrides the store\'s answer', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return { schemaVersion: 'v1', layout: 'horizontal' }; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().canvasLayout.layout, 'horizontal');
  await app.close();
});

test('an unrecognised, expired or revoked overlay session answers 200 with canvasLayout: null -- never 401', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return null; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer nope' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().canvasLayout, null);
  await app.close();
});

test('a store failure is a retryable 503, not a 200 asserting horizontal', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { throw new Error('boom'); } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});

// =====================================================================
// The route's own narrowing. THIS IS THE PROHIBITION SURFACE.
// =====================================================================

test('a store handing up a channel id, a variant id or an unrecognised layout value gets none of it past the route', async () => {
  const polluted = {
    schemaVersion: 'v1',
    layout: 'vertical',
    channelId,
    variantId: 'v2',
    aspectRatio: '9:16',
  };
  const app = await buildOverlayApp({ async getForOverlay() { return polluted as unknown as OverlayCanvasLayout; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().canvasLayout, overlayLayout);
  await app.close();
});

test('projectOverlayCanvasLayout refuses everything that is not exactly horizontal or vertical', () => {
  assert.equal(projectOverlayCanvasLayout(null), null);
  assert.equal(projectOverlayCanvasLayout({ schemaVersion: 'v1', layout: 'square' } as unknown as OverlayCanvasLayout), null);
  assert.equal(projectOverlayCanvasLayout({ schemaVersion: 'v1', layout: 42 } as unknown as OverlayCanvasLayout), null);
  assert.deepEqual(projectOverlayCanvasLayout(overlayLayout), overlayLayout);
});

// =====================================================================
// The creator-facing read.
// =====================================================================

test('GET returns the store\'s layout, or canvasLayout: null with no fabrication', async () => {
  const app = await buildCreatorApp({ async getCurrent() { return fakeChannelLayout(); } });
  const response = await app.inject({ method: 'GET', url: channelUrl, headers: authHeaders });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().canvasLayout.layout, 'vertical');
  assert.equal(response.json().canvasLayout.verticalEntitled, true);
  await app.close();

  const nullApp = await buildCreatorApp({ async getCurrent() { return null; } });
  const nullResponse = await nullApp.inject({ method: 'GET', url: channelUrl, headers: authHeaders });
  assert.equal(nullResponse.statusCode, 200);
  assert.equal(nullResponse.json().canvasLayout, null);
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
  assert.equal(response.json().errorCode, 'canvas_layout_store_unavailable');
  assert.equal(response.json().retryable, true);
  await app.close();
});

// =====================================================================
// PUT .../canvas-layout (set the layout).
// =====================================================================

test('PUT passes layout through unchanged and returns 200 with the saved layout', async () => {
  let receivedArgs: unknown[] = [];
  const app = await buildCreatorApp({
    async set(...args) { receivedArgs = args; return { outcome: 'ok', channelLayout: fakeChannelLayout({ layout: 'vertical' }) }; },
  });
  const response = await app.inject({
    method: 'PUT', url: channelUrl, headers: authHeaders,
    payload: { layout: 'vertical' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().canvasLayout.layout, 'vertical');
  assert.deepEqual(receivedArgs, [userId, channelId, 'vertical']);
  await app.close();
});

test('PUT rejects any value other than exactly "horizontal" or "vertical" at the schema layer, before the store is ever called -- no variant, no aspect ratio, no scene id', async () => {
  let called = 0;
  const app = await buildCreatorApp({
    async set() { called += 1; return { outcome: 'ok', channelLayout: fakeChannelLayout() }; },
  });
  for (const payload of [
    { layout: 'square' },
    { layout: '9:16' },
    { layout: 'vertical-v2' },
    { layout: '' },
    { layout: null },
    {},
    { layout: 'vertical', variantId: 'v2' },
    { layout: 'vertical', sceneId: '00000000-0000-4000-8000-0000000000ee' },
  ]) {
    const response = await app.inject({ method: 'PUT', url: channelUrl, headers: authHeaders, payload });
    assert.equal(response.statusCode, 400, `${JSON.stringify(payload)} must be rejected by the route schema`);
  }
  assert.equal(called, 0, 'no rejected body may ever reach the store');
  await app.close();
});

test('PUT accepts exactly "horizontal" and "vertical"', async () => {
  let called = 0;
  const app = await buildCreatorApp({
    async set() { called += 1; return { outcome: 'ok', channelLayout: fakeChannelLayout() }; },
  });
  for (const layout of ['horizontal', 'vertical']) {
    const response = await app.inject({ method: 'PUT', url: channelUrl, headers: authHeaders, payload: { layout } });
    assert.equal(response.statusCode, 200, `${layout} must be accepted`);
  }
  assert.equal(called, 2);
  await app.close();
});

test('PUT maps a forbidden outcome (non-owner/admin) to 404, never a leaking 403', async () => {
  const app = await buildCreatorApp({ async set() { return { outcome: 'forbidden' }; } });
  const response = await app.inject({
    method: 'PUT', url: channelUrl, headers: authHeaders,
    payload: { layout: 'vertical' },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().errorCode, 'not_found');
  await app.close();
});

test('PUT maps an invalid outcome to 400 and a thrown store error to a retryable 503, never a 500', async () => {
  const invalidApp = await buildCreatorApp({ async set() { return { outcome: 'invalid' }; } });
  const invalid = await invalidApp.inject({
    method: 'PUT', url: channelUrl, headers: authHeaders,
    payload: { layout: 'vertical' },
  });
  assert.equal(invalid.statusCode, 400);
  await invalidApp.close();

  const throwingApp = await buildCreatorApp({ async set() { throw new Error('db down'); } });
  const thrown = await throwingApp.inject({
    method: 'PUT', url: channelUrl, headers: authHeaders,
    payload: { layout: 'vertical' },
  });
  assert.equal(thrown.statusCode, 503);
  assert.equal(thrown.json().retryable, true);
  await throwingApp.close();
});

test('PUT is not reachable without a valid session', async () => {
  const app = await buildCreatorApp({
    async set() { return { outcome: 'ok', channelLayout: fakeChannelLayout() }; },
  });
  const put = await app.inject({ method: 'PUT', url: channelUrl, payload: { layout: 'vertical' } });
  assert.equal(put.statusCode, 401);
  await app.close();
});
