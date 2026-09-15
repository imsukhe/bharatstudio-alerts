import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerTemplateRoutes } from '../src/routes/templates.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { TemplateCatalogueStore, TemplateSummary } from '../src/domain/template-catalogue.js';

// registerTemplateRoutes is tested directly against a bare Fastify
// instance rather than through buildApp/app.ts — this lane owns
// routes/templates.ts but deliberately does not edit app.ts (see the
// task's ownership boundary); app.ts wiring is applied at review.

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const token = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

function fakeSummary(overrides: Partial<TemplateSummary> = {}): TemplateSummary {
  return {
    id: '00000000-0000-4000-8000-0000000000a1', externalKey: 'BSA-001', displayName: 'Minimal Clean Tip',
    category: 'Minimal Clean', minTier: 'free', byteSize: 42, updatedAt: '2026-09-01T00:00:00.000Z', ...overrides,
  };
}

async function buildTestApp(store?: Partial<TemplateCatalogueStore>) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerTemplateRoutes(app, sessions, store as TemplateCatalogueStore | undefined);
  return app;
}

test('GET returns the templates the store hands back for the channel', async () => {
  const items = [fakeSummary(), fakeSummary({ externalKey: 'BSA-002', minTier: 'studio' })];
  let calledWith: [string, string] | undefined;
  const app = await buildTestApp({
    async listForChannel(uid, cid) { calledWith = [uid, cid]; return items; },
  });
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/templates`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items, items);
  assert.deepEqual(calledWith, [userId, channelId]);
  await app.close();
});

test('GET rejects an unauthenticated caller', async () => {
  const app = await buildTestApp({ async listForChannel() { return []; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/templates` });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('GET rejects a malformed channelId before reaching the store', async () => {
  const app = await buildTestApp({ async listForChannel() { throw new Error('must not be called'); } });
  const response = await app.inject({
    method: 'GET', url: '/v1/channels/not-a-uuid/templates',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test('GET returns 503 when no store is wired', async () => {
  const app = await buildTestApp(undefined);
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/templates`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'template_store_unavailable');
  await app.close();
});

test('GET redacts a template store rejection as a retryable 503', async () => {
  const app = await buildTestApp({
    async listForChannel() { throw new Error('postgres://user:secret@host unavailable'); },
  });
  const response = await app.inject({
    method: 'GET', url: `/v1/channels/${channelId}/templates`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'template_store_unavailable');
  assert.equal(response.json().retryable, true);
  assert.equal(JSON.stringify(response.json()).includes('secret'), false);
  await app.close();
});
