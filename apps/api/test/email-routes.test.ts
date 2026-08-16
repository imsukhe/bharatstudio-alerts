import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { EmailOutboxStore } from '../src/domain/email.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-000000000001';

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

function fakeEmailOutbox(): EmailOutboxStore & { enqueuedFor: string[] } {
  const enqueuedFor: string[] = [];
  return {
    enqueuedFor,
    async claimPending() { return []; },
    async complete() { /* not exercised here */ },
    async enqueueDpdpExportEmail(id) { enqueuedFor.push(id); },
  };
}

test('the internal email-outbox drain route requires service identity and fails closed without a configured outbox', async () => {
  const identity = { verify: async (authorization?: string) => authorization === 'Bearer synthetic-internal-token' };
  const app = await buildApp(config, { serviceIdentity: identity });
  const unauthorized = await app.inject({ method: 'POST', url: '/internal/email-outbox/drain', payload: {} });
  const unavailable = await app.inject({ method: 'POST', url: '/internal/email-outbox/drain', headers: { authorization: 'Bearer synthetic-internal-token' }, payload: {} });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unavailable.statusCode, 503);
  await app.close();
});

test('the internal email-outbox drain route runs the drain loop and returns a summary only after identity verification', async () => {
  const store = fakeEmailOutbox();
  const app = await buildApp(config, { serviceIdentity: { verify: async () => true }, emailOutbox: store });
  const response = await app.inject({ method: 'POST', url: '/internal/email-outbox/drain', headers: { authorization: 'Bearer synthetic-internal-token' }, payload: { limit: 10 } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', claimed: 0, sent: 0, disabled: 0, retried: 0 });
  await app.close();
});

test('POST /v1/me/export/email is opt-in, authenticated, and queues a delivery without ever exposing a synchronous export payload', async () => {
  const store = fakeEmailOutbox();
  const app = await buildApp(config, { sessions, emailOutbox: store });
  const response = await app.inject({ method: 'POST', url: '/v1/me/export/email', headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().status, 'queued');
  assert.deepEqual(store.enqueuedFor, [userId]);
  assert.equal('data' in response.json(), false);

  const unauthenticated = await app.inject({ method: 'POST', url: '/v1/me/export/email' });
  assert.equal(unauthenticated.statusCode, 401);
  await app.close();
});

test('POST /v1/me/export/email fails closed as 503 without a configured email outbox', async () => {
  const app = await buildApp(config, { sessions });
  const response = await app.inject({ method: 'POST', url: '/v1/me/export/email', headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'email_outbox_unavailable');
  await app.close();
});
