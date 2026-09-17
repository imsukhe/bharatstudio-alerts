import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerUrlDomainRuleRoutes } from '../src/routes/url-domain-rules.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { CreateUrlDomainRuleResult, DeleteUrlDomainRuleResult, StoredUrlDomainRule, UrlDomainRuleStore } from '../src/domain/url-domain-rule-store.js';

/*
 * SAF-10 (migration 0154). registerUrlDomainRuleRoutes is tested
 * directly against a standalone createTestFastify() instance, mirroring
 * apps/api/test/safety-corpus-routes.test.ts exactly. This file only
 * proves the route layer -- auth required, outcome-to-status mapping, a
 * store failure degrading to a retryable 503, an unwired store staying
 * safe, and schema-level input rejection before the store is ever
 * called. The transform's own correctness (allow/deny/default
 * precedence) is proven in apps/api/test/url-neutralization.test.ts;
 * the database layer's own guarantees are proven in
 * packages/db/tests/saf_url_ssml_pii.sql.
 */

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const ruleId = '00000000-0000-4000-8000-0000000000a1';
const token = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-09-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

function fakeRule(overrides: Partial<StoredUrlDomainRule> = {}): StoredUrlDomainRule {
  return {
    schemaVersion: 'v1', ruleId, domain: 'example.com', rule: 'deny',
    createdAt: '2026-09-17T10:00:00.000Z', ...overrides,
  };
}

async function buildTestApp(store?: Partial<UrlDomainRuleStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerUrlDomainRuleRoutes(app, sessions, store as UrlDomainRuleStore | undefined);
  return app;
}

test('GET lists the domain rules for an authenticated caller', async () => {
  const app = await buildTestApp({ async list() { return [fakeRule(), fakeRule({ ruleId: 'r2', domain: 'allowed.example', rule: 'allow' })]; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/safety/domain-rules`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items.length, 2);
  assert.deepEqual(response.json().items.map((r: StoredUrlDomainRule) => r.rule).sort(), ['allow', 'deny']);
  await app.close();
});

test('GET requires authentication', async () => {
  const app = await buildTestApp({ async list() { return []; } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/safety/domain-rules` });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('POST creates a rule and maps every outcome to the right status', async () => {
  const outcomes: Record<string, CreateUrlDomainRuleResult> = {
    created: { outcome: 'created', rule: fakeRule() },
    forbidden: { outcome: 'forbidden' },
    duplicate: { outcome: 'duplicate' },
    invalid: { outcome: 'invalid' },
  };
  for (const [key, result] of Object.entries(outcomes)) {
    const app = await buildTestApp({ async create() { return result; } });
    const response = await app.inject({
      method: 'POST', url: `/v1/channels/${channelId}/safety/domain-rules`,
      headers: { authorization: `Bearer ${token}` },
      payload: { domain: 'example.com', rule: 'deny' },
    });
    const expected: Record<string, number> = { created: 201, forbidden: 404, duplicate: 409, invalid: 400 };
    assert.equal(response.statusCode, expected[key], `outcome ${key}`);
    await app.close();
  }
});

test('POST passes the exact body through to the store and rejects an invalid rule value / malformed domain at the schema layer', async () => {
  let seen: unknown;
  const app = await buildTestApp({
    async create(_u, _c, input) { seen = input; return { outcome: 'created', rule: fakeRule() }; },
  });
  const ok = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/safety/domain-rules`,
    headers: { authorization: `Bearer ${token}` },
    payload: { domain: 'sub.example.com', rule: 'allow' },
  });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(seen, { domain: 'sub.example.com', rule: 'allow' });

  const badRule = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/safety/domain-rules`,
    headers: { authorization: `Bearer ${token}` },
    payload: { domain: 'example.com', rule: 'block-everything' },
  });
  assert.equal(badRule.statusCode, 400);

  const badDomain = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/safety/domain-rules`,
    headers: { authorization: `Bearer ${token}` },
    payload: { domain: 'not a domain!!', rule: 'deny' },
  });
  assert.equal(badDomain.statusCode, 400);
  await app.close();
});

test('DELETE removes a rule and maps every outcome to the right status', async () => {
  const outcomes: Record<string, DeleteUrlDomainRuleResult> = {
    ok: { outcome: 'ok' },
    forbidden: { outcome: 'forbidden' },
    not_found: { outcome: 'not_found' },
  };
  for (const [key, result] of Object.entries(outcomes)) {
    const app = await buildTestApp({ async remove() { return result; } });
    const response = await app.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/safety/domain-rules/${ruleId}`, headers: { authorization: `Bearer ${token}` } });
    const expected: Record<string, number> = { ok: 204, forbidden: 404, not_found: 404 };
    assert.equal(response.statusCode, expected[key], `outcome ${key}`);
    await app.close();
  }
});

test('a store failure degrades to a retryable 503, never a crash, on every route', async () => {
  const failing: UrlDomainRuleStore = {
    async list() { throw new Error('synthetic db failure'); },
    async create() { throw new Error('synthetic db failure'); },
    async remove() { throw new Error('synthetic db failure'); },
  };
  const app = await buildTestApp(failing);

  const list = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/safety/domain-rules`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(list.statusCode, 503);
  assert.equal(list.json().retryable, true);

  const create = await app.inject({
    method: 'POST', url: `/v1/channels/${channelId}/safety/domain-rules`, headers: { authorization: `Bearer ${token}` },
    payload: { domain: 'example.com', rule: 'deny' },
  });
  assert.equal(create.statusCode, 503);

  const del = await app.inject({ method: 'DELETE', url: `/v1/channels/${channelId}/safety/domain-rules/${ruleId}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(del.statusCode, 503);
  await app.close();
});

test('unavailable-but-safe (503, not a thrown error) when no store is wired', async () => {
  const app = await buildTestApp(undefined);
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/safety/domain-rules`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 503);
  await app.close();
});

test('rejects an invalid channelId at the schema layer before the store is ever called', async () => {
  let called = false;
  const app = await buildTestApp({ async list() { called = true; return []; } });
  const response = await app.inject({ method: 'GET', url: '/v1/channels/not-a-uuid/safety/domain-rules', headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});
