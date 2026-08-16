import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-000000000001';
const hash = 'a'.repeat(64);
const sessions: SessionStore = { async create() { throw new Error('not used'); }, async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; }, async getCurrentUser() { throw new Error('not used'); }, async list() { return []; }, async revoke() { return false; } };

function accountStore(): AccountStore {
  let accepted: string[] = [];
  return {
    async listActiveDocuments() { return [{ documentKey: 'terms_of_service', version: '2026-08-01', contentHash: hash, publishedAt: '2026-08-01T00:00:00.000Z' }, { documentKey: 'privacy_notice', version: '2026-08-01', contentHash: hash, publishedAt: '2026-08-01T00:00:00.000Z' }]; },
    async acceptDocument(_user, key, version) { accepted.push(`${key}:${version}`); return true; },
    async hasAcceptedActiveDocuments() { return accepted.length === 2; },
    async createPrivacyRequest(_user, requestType, details) { return { requestId: '00000000-0000-4000-8000-000000000111', requestType, details, status: 'open', createdAt: '2026-08-16T00:00:00.000Z' }; },
    async listPrivacyRequests() { return []; },
    async exportAccount() { return { schemaVersion: 'v1', user: { userId } }; },
    async closeAccount() { return '2026-08-16T00:01:00.000Z'; },
  };
}

test('account routes support document acceptance, export, privacy request and soft closure', async () => {
  const app = await buildApp(config, { sessions, account: accountStore() });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
  const terms = await app.inject({ method: 'GET', url: '/v1/me/terms', headers });
  assert.equal(terms.statusCode, 200);
  const accepted = await app.inject({ method: 'POST', url: '/v1/me/terms/accept', headers, payload: { documentKey: 'terms_of_service', version: '2026-08-01', contentHash: hash } });
  assert.equal(accepted.statusCode, 200);
  const request = await app.inject({ method: 'POST', url: '/v1/me/privacy/requests', headers, payload: { requestType: 'access', details: 'Please provide my account export.' } });
  assert.equal(request.statusCode, 201);
  const exportResponse = await app.inject({ method: 'GET', url: '/v1/me/export', headers });
  assert.equal(exportResponse.json().schemaVersion, 'v1');
  const close = await app.inject({ method: 'POST', url: '/v1/me/close', headers, payload: { reason: 'Synthetic test closure' } });
  assert.equal(close.json().status, 'deactivated');
  await app.close();
});

test('privacy request details and account closure reason are bounded', async () => {
  const app = await buildApp(config, { sessions, account: accountStore() });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
  const response = await app.inject({ method: 'POST', url: '/v1/me/privacy/requests', headers, payload: { requestType: 'privacy_concern', details: 'x'.repeat(2001) } });
  assert.equal(response.statusCode, 400);
  await app.close();
});
