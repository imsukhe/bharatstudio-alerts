import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { CapabilityStore, ResolvedCapabilities } from '../src/domain/capability-store.js';

/*
 * CTL phase 1 (migration 0149). GET /v1/channels/:channelId/capabilities
 * is the plane's only phase-1 route. The route layer's own correctness
 * surface and nothing below it -- the SQL layer's proof of CTL-01
 * (versioned/audited), CTL-02 (resolution order), CTL-03 (resolved
 * blob, cached, never per-capability), CTL-14 (durable-record guard)
 * and CTL-15 (no per-tier retention field) all live in
 * packages/db/tests/ctl_capability_registry.sql. This file only proves
 * the route: auth required, the store's null both maps to 404 (channel
 * not found AND non-member -- no membership-enumeration distinction,
 * the same posture routes/insights.ts already takes), a store failure
 * degrades to a retryable 503 rather than a crash, and an unwired
 * store is unavailable-but-safe.
 */

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4102, appOrigin: 'http://localhost:3102', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const headers = { authorization: `Bearer ${'a'.repeat(48)}` };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-09-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); }, async list() { return []; }, async revoke() { return false; },
};

const resolved: ResolvedCapabilities = {
  schemaVersion: 'v1',
  generation: 7,
  resolvedAt: '2026-09-17T10:05:00.000Z',
  capabilities: { team_seat_extra_producer: true, ai_usage_higher_quota: false },
};

test('capabilities: returns the resolved blob for an authenticated member, 404 for not-found/non-member, 401 unauthenticated', async () => {
  let current: ResolvedCapabilities | null = resolved;
  let seenArgs: { userId: string; channelId: string } | null = null;
  const store: CapabilityStore = {
    async getResolvedCapabilities(u, c) {
      seenArgs = { userId: u, channelId: c };
      return current;
    },
  };
  const app = await buildApp(config, { sessions, capabilities: store });

  const ok = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/capabilities`, headers });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), resolved);
  assert.deepEqual(seenArgs, { userId, channelId });

  // CTL-03: a single call, a single blob -- no capability-keyed field is
  // requested separately, and the response body carries every
  // registered capability's flag in one object, never a narrower shape.
  assert.deepEqual(Object.keys(ok.json().capabilities).sort(), ['ai_usage_higher_quota', 'team_seat_extra_producer']);

  current = null;
  const notFound = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/capabilities`, headers });
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.json().errorCode, 'channel_not_found');

  const unauthenticated = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/capabilities` });
  assert.equal(unauthenticated.statusCode, 401);
  await app.close();
});

test('capabilities: a store failure degrades to a clean, retryable 503, never a crash', async () => {
  const store: CapabilityStore = {
    async getResolvedCapabilities() { throw new Error('synthetic db failure'); },
  };
  const app = await buildApp(config, { sessions, capabilities: store });
  const failure = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/capabilities`, headers });
  assert.equal(failure.statusCode, 503);
  assert.equal(failure.json().retryable, true);
  assert.equal(failure.json().errorCode, 'capability_store_unavailable');
  await app.close();
});

test('capabilities: unavailable-but-safe (503, not a thrown error) when no store is wired', async () => {
  const app = await buildApp(config, { sessions });
  const unavailable = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/capabilities`, headers });
  assert.equal(unavailable.statusCode, 503);
  await app.close();
});

test('capabilities: rejects an invalid channelId (schema-level, before the store is ever called)', async () => {
  let called = false;
  const store: CapabilityStore = {
    async getResolvedCapabilities() { called = true; return resolved; },
  };
  const app = await buildApp(config, { sessions, capabilities: store });
  const bad = await app.inject({ method: 'GET', url: '/v1/channels/not-a-uuid/capabilities', headers });
  assert.equal(bad.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});
