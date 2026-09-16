import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerMasterCanvasRoutes } from '../src/routes/master-canvas.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import { isMasterCanvasModuleKey, MASTER_CANVAS_MODULE_KEYS } from '../src/domain/master-canvas-store.js';
import type { MasterCanvasModule, MasterCanvasOverlayStore, MasterCanvasStore, UpsertMasterCanvasModuleResult } from '../src/domain/master-canvas-store.js';

// PRF-02.8/PRF-02.9: the server-owned §30.3 module cap and the durable,
// never-deleted configuration it gates. registerMasterCanvasRoutes is
// tested directly against a bare Fastify instance, matching
// l16-goals-routes.test.ts's own convention for a routes file that does
// not itself own app.ts.

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const overlayId = '00000000-0000-4000-8000-000000000091';
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

function fakeModule(overrides: Partial<MasterCanvasModule> = {}): MasterCanvasModule {
  return {
    schemaVersion: 'v1', moduleKey: 'supporter_ticker', enabled: true, active: true, inactiveReason: null,
    createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z', ...overrides,
  };
}

async function buildTestApp(store?: Partial<MasterCanvasStore>, overlayModules?: MasterCanvasOverlayStore) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerMasterCanvasRoutes(app, sessions, store as MasterCanvasStore | undefined, account, overlayModules);
  return app;
}

test('the module catalogue carries all 20 §6 keys, and the guard accepts only those', () => {
  assert.equal(MASTER_CANVAS_MODULE_KEYS.length, 20);
  assert.ok(isMasterCanvasModuleKey('supporter_ticker'));
  assert.ok(isMasterCanvasModuleKey('community_goal_ladder'));
  assert.equal(isMasterCanvasModuleKey('not_a_real_module'), false);
  assert.equal(isMasterCanvasModuleKey(42), false);
});

test('GET the creator-facing list returns the store\'s modules, cap reasons included', async () => {
  const modules = [
    fakeModule({ moduleKey: 'supporter_ticker', active: true, inactiveReason: null }),
    fakeModule({ moduleKey: 'community_goal_ladder', active: true, inactiveReason: null }),
    fakeModule({ moduleKey: 'chat', active: false, inactiveReason: 'tier_module_cap' }),
  ];
  const app = await buildTestApp({ async list() { return modules; } });
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/master-canvas/modules`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.modules.length, 3);
  assert.equal(body.modules[2].inactiveReason, 'tier_module_cap');
  await app.close();
});

test('GET without a store returns 503, never a 200 with fabricated data', async () => {
  const app = await buildTestApp(undefined);
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/master-canvas/modules`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'master_canvas_store_unavailable');
  await app.close();
});

test('GET without a valid session is 401, and the store is never called', async () => {
  let called = false;
  const app = await buildTestApp({ async list() { called = true; return []; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/master-canvas/modules` });
  assert.equal(response.statusCode, 401);
  assert.equal(called, false);
  await app.close();
});

test('PUT toggles a module and returns the recomputed row', async () => {
  const updated = fakeModule({ moduleKey: 'community_goal_ladder', enabled: false, active: false, inactiveReason: 'disabled' });
  const result: UpsertMasterCanvasModuleResult = { outcome: 'ok', module: updated };
  let receivedArgs: unknown[] = [];
  const app = await buildTestApp({
    async upsert(...args) { receivedArgs = args; return result; },
  });
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/master-canvas/modules/community_goal_ladder`,
    headers: { authorization: `Bearer ${token}` },
    payload: { enabled: false },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().moduleKey, 'community_goal_ladder');
  assert.equal(response.json().inactiveReason, 'disabled');
  assert.deepEqual(receivedArgs, [userId, channelId, 'community_goal_ladder', false]);
  await app.close();
});

test('PUT maps a forbidden outcome (non-owner/admin) to 404, never a leaking 403', async () => {
  const app = await buildTestApp({ async upsert() { return { outcome: 'forbidden' }; } });
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/master-canvas/modules/chat`,
    headers: { authorization: `Bearer ${token}` },
    payload: { enabled: true },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('PUT rejects an out-of-catalogue module key at the schema layer before the store is ever called', async () => {
  let called = false;
  const app = await buildTestApp({ async upsert() { called = true; return { outcome: 'invalid' }; } });
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/master-canvas/modules/not_a_real_module`,
    headers: { authorization: `Bearer ${token}` },
    payload: { enabled: true },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('a thrown store error on PUT becomes a retryable 503, never a 500 or a silent 200', async () => {
  const app = await buildTestApp({ async upsert() { throw new Error('boom'); } });
  const response = await app.inject({
    method: 'PUT', url: `/v1/channels/${channelId}/master-canvas/modules/chat`,
    headers: { authorization: `Bearer ${token}` },
    payload: { enabled: true },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});

test('the overlay-facing read has no session auth chain — a missing bearer token is 401', async () => {
  const app = await buildTestApp(undefined, { async listActiveForOverlay() { return []; } });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/master-canvas/modules` });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('the overlay-facing read returns exactly the active module keys, and only those', async () => {
  let receivedToken: string | undefined;
  const app = await buildTestApp(undefined, {
    async listActiveForOverlay(t) { receivedToken = t; return ['community_goal_ladder', 'supporter_ticker']; },
  });
  const response = await app.inject({
    method: 'GET', url: `/v1/overlay-widgets/${overlayId}/master-canvas/modules`,
    headers: { authorization: `Bearer overlay-session-token-xyz` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().moduleKeys, ['community_goal_ladder', 'supporter_ticker']);
  assert.equal(receivedToken, 'overlay-session-token-xyz');
  await app.close();
});

test('the overlay-facing read degrades to a retryable 503 on a thrown store error, never a 500', async () => {
  const app = await buildTestApp(undefined, { async listActiveForOverlay() { throw new Error('db down'); } });
  const response = await app.inject({
    method: 'GET', url: `/v1/overlay-widgets/${overlayId}/master-canvas/modules`,
    headers: { authorization: `Bearer overlay-session-token-xyz` },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});

test('the overlay-facing read without a configured store is a retryable 503, never a 200 with an empty list masquerading as "no active modules"', async () => {
  const app = await buildTestApp(undefined, undefined);
  const response = await app.inject({
    method: 'GET', url: `/v1/overlay-widgets/${overlayId}/master-canvas/modules`,
    headers: { authorization: `Bearer overlay-session-token-xyz` },
  });
  assert.equal(response.statusCode, 503);
  await app.close();
});
