import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerViewerRoutes } from '../src/routes/viewer.js';
import type { ViewerDashboardRow, ViewerDeletionResult, ViewerStore } from '../src/domain/viewer-store.js';

// Route-level coverage for POST /v1/viewer/password/forgot and
// /v1/viewer/password/reset. The real single-use/expiry/enumeration
// enforcement lives in migration 0088's SQL functions and is proven there
// (packages/db/tests/l14_viewer_password_reset.sql) — this file proves the
// route wiring: one fixed response shape regardless of what the store
// found, and correct pass-through of the store's boolean result.
async function buildViewerApp(overrides: Partial<ViewerStore> = {}) {
  const requestedEmails: string[] = [];
  const store: ViewerStore = {
    async signup() { return { accessToken: 'a'.repeat(48), viewerAccountId: 'v1', expiresAt: '2026-10-01T00:00:00.000Z' }; },
    async login() { return null; },
    async lookup() { return null; },
    async listSessions() { return []; },
    async revokeSession() { return false; },
    async getDashboard(): Promise<ViewerDashboardRow[]> { return []; },
    async requestDeletion(): Promise<ViewerDeletionResult> {
      return { schemaVersion: 'v1', erased: [], retained: [], legalDispositionOpen: true };
    },
    async requestPasswordReset(email) { requestedEmails.push(email); },
    async resetPassword() { return true; },
    ...overrides,
  };
  const app = Fastify();
  await registerViewerRoutes(app, { viewer: store });
  return { app, requestedEmails };
}

test('forgot-password returns the identical response for a registered and an unregistered email', async () => {
  const { app } = await buildViewerApp();
  const known = await app.inject({ method: 'POST', url: '/v1/viewer/password/forgot', payload: { email: 'known@example.com' } });
  const unknown = await app.inject({ method: 'POST', url: '/v1/viewer/password/forgot', payload: { email: 'unknown@example.com' } });
  assert.equal(known.statusCode, 202);
  assert.equal(unknown.statusCode, 202);
  assert.deepEqual(known.json(), unknown.json());
  await app.close();
});

test('forgot-password still returns the generic response even if the store rejects', async () => {
  const { app } = await buildViewerApp({ async requestPasswordReset() { throw new Error('boom'); } });
  const response = await app.inject({ method: 'POST', url: '/v1/viewer/password/forgot', payload: { email: 'anything@example.com' } });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().status, 'requested');
  await app.close();
});

test('forgot-password calls the store with the submitted email', async () => {
  const { app, requestedEmails } = await buildViewerApp();
  await app.inject({ method: 'POST', url: '/v1/viewer/password/forgot', payload: { email: 'someone@example.com' } });
  assert.deepEqual(requestedEmails, ['someone@example.com']);
  await app.close();
});

test('reset-password succeeds when the store confirms the token', async () => {
  const { app } = await buildViewerApp({ async resetPassword() { return true; } });
  const response = await app.inject({ method: 'POST', url: '/v1/viewer/password/reset', payload: { token: 'a'.repeat(32), newPassword: 'correct-horse-battery' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'reset');
  await app.close();
});

test('reset-password rejects an invalid/used/expired token with one generic shape', async () => {
  const { app } = await buildViewerApp({ async resetPassword() { return false; } });
  const response = await app.inject({ method: 'POST', url: '/v1/viewer/password/reset', payload: { token: 'a'.repeat(32), newPassword: 'correct-horse-battery' } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'invalid_reset_token');
  await app.close();
});

test('reset-password fails closed (503) when no viewer store is configured', async () => {
  const app = Fastify();
  await registerViewerRoutes(app, {});
  const response = await app.inject({ method: 'POST', url: '/v1/viewer/password/reset', payload: { token: 'a'.repeat(32), newPassword: 'correct-horse-battery' } });
  assert.equal(response.statusCode, 503);
  await app.close();
});

test('reset-password validates password length via the shared schema', async () => {
  const { app } = await buildViewerApp();
  const response = await app.inject({ method: 'POST', url: '/v1/viewer/password/reset', payload: { token: 'a'.repeat(32), newPassword: 'short' } });
  assert.equal(response.statusCode, 400);
  await app.close();
});
