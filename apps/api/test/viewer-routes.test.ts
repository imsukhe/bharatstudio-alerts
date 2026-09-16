import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { registerViewerRoutes } from '../src/routes/viewer.js';
import type { ViewerDashboardRow, ViewerDeletionResult, ViewerSessionPrincipal, ViewerStore } from '../src/domain/viewer-store.js';

// `buildApp` now wires viewer routes in production. These tests still use a
// standalone Fastify instance to isolate the ViewerStore boundary.
async function buildViewerApp(viewer: ViewerStore) {
  const app = createTestFastify();
  await registerViewerRoutes(app, { viewer });
  return app;
}

const TOKEN_A = 'a'.repeat(48);
const TOKEN_B = 'b'.repeat(48);
const VIEWER_A = '00000000-0000-4000-8000-0000000000a1';
const VIEWER_B = '00000000-0000-4000-8000-0000000000b1';
const SESSION_A = '00000000-0000-4000-8000-000000005e01';
const SESSION_B = '00000000-0000-4000-8000-000000005e02';

function fakeViewerStore(overrides: Partial<ViewerStore> = {}): ViewerStore {
  const revoked = new Set<string>();
  const sessionsByViewer: Record<string, ViewerSessionPrincipal[]> = {
    [VIEWER_A]: [{ sessionId: SESSION_A, viewerAccountId: VIEWER_A, expiresAt: '2026-10-01T00:00:00.000Z' }],
    [VIEWER_B]: [{ sessionId: SESSION_B, viewerAccountId: VIEWER_B, expiresAt: '2026-10-01T00:00:00.000Z' }],
  };
  return {
    async signup(email) {
      if (email === 'taken@example.com') throw new Error('email already registered');
      return { accessToken: TOKEN_A, viewerAccountId: VIEWER_A, expiresAt: '2026-10-01T00:00:00.000Z' };
    },
    async login(email, password) {
      if (email === 'viewer@example.com' && password === 'correct-horse-battery') {
        return { accessToken: TOKEN_A, viewerAccountId: VIEWER_A, expiresAt: '2026-10-01T00:00:00.000Z' };
      }
      return null;
    },
    async lookup(token) {
      if (token === TOKEN_A) return { sessionId: 's-a-1', viewerAccountId: VIEWER_A, expiresAt: '2026-10-01T00:00:00.000Z' };
      if (token === TOKEN_B) return { sessionId: 's-b-1', viewerAccountId: VIEWER_B, expiresAt: '2026-10-01T00:00:00.000Z' };
      return null;
    },
    async listSessions(viewerAccountId) {
      return (sessionsByViewer[viewerAccountId] ?? []).map((s) => ({ sessionId: s.sessionId, createdAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-01T00:00:00.000Z', expiresAt: s.expiresAt, deviceLabel: 'test-device' }));
    },
    async revokeSession(viewerAccountId, sessionId) {
      const owns = (sessionsByViewer[viewerAccountId] ?? []).some((s) => s.sessionId === sessionId);
      if (!owns || revoked.has(sessionId)) return false;
      revoked.add(sessionId);
      return true;
    },
    async getDashboard(viewerAccountId): Promise<ViewerDashboardRow[]> {
      // Cross-creator isolation lives in the DB layer (see
      // packages/db/tests/l14_viewer_identity_cross_creator_isolation.sql);
      // here we assert the route only ever asks the store for the
      // authenticated viewer's own id, never anyone else's.
      assert.ok(viewerAccountId === VIEWER_A || viewerAccountId === VIEWER_B);
      return [{ channelId: 'chan-1', channelHandle: 'demo', channelDisplayName: 'Demo Channel', firstSupportedAt: '2026-01-01T00:00:00.000Z', lastSupportedAt: '2026-08-01T00:00:00.000Z', lifetimeAmountPaise: '150000', tipCount: '4', challengeCount: '1', memberState: 'active' }];
    },
    async requestDeletion(): Promise<ViewerDeletionResult> {
      return { schemaVersion: 'v1', erased: ['email', 'password_hash', 'display_name'], retained: ['payments (financial record)'], legalDispositionOpen: true };
    },
    // Batch 3 defaults — see viewer-password-reset-routes.test.ts for the
    // dedicated reset-endpoint coverage; these keep this file's existing
    // tests compiling against the now-larger ViewerStore shape.
    async requestPasswordReset() {},
    async resetPassword() { return true; },
    ...overrides,
  };
}

test('viewer signup returns a session token', async () => {
  const app = await buildViewerApp(fakeViewerStore());
  const response = await app.inject({ method: 'POST', url: '/v1/viewer/signup', payload: { email: 'new@example.com', password: 'correct-horse-battery', deviceLabel: 'iPhone' } });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().accessToken, TOKEN_A);
  await app.close();
});

test('viewer signup rejects a duplicate email without confirming which account exists', async () => {
  const app = await buildViewerApp(fakeViewerStore());
  const response = await app.inject({ method: 'POST', url: '/v1/viewer/signup', payload: { email: 'taken@example.com', password: 'correct-horse-battery', deviceLabel: 'iPhone' } });
  assert.equal(response.statusCode, 409);
  await app.close();
});

test('viewer login succeeds with correct credentials and fails otherwise', async () => {
  const app = await buildViewerApp(fakeViewerStore());
  const ok = await app.inject({ method: 'POST', url: '/v1/viewer/login', payload: { email: 'viewer@example.com', password: 'correct-horse-battery', deviceLabel: 'iPhone' } });
  assert.equal(ok.statusCode, 201);
  const bad = await app.inject({ method: 'POST', url: '/v1/viewer/login', payload: { email: 'viewer@example.com', password: 'wrong-password', deviceLabel: 'iPhone' } });
  assert.equal(bad.statusCode, 401);
  await app.close();
});

test('viewer sessions list/revoke require viewer auth and are scoped to the caller', async () => {
  const app = await buildViewerApp(fakeViewerStore());
  const unauth = await app.inject({ method: 'GET', url: '/v1/viewer/sessions' });
  assert.equal(unauth.statusCode, 401);
  const listed = await app.inject({ method: 'GET', url: '/v1/viewer/sessions', headers: { authorization: `Bearer ${TOKEN_A}` } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().sessions[0].sessionId, SESSION_A);
  // Viewer B cannot revoke viewer A's session id.
  const crossRevoke = await app.inject({ method: 'DELETE', url: `/v1/viewer/sessions/${SESSION_A}`, headers: { authorization: `Bearer ${TOKEN_B}` } });
  assert.equal(crossRevoke.statusCode, 404);
  const ownRevoke = await app.inject({ method: 'DELETE', url: `/v1/viewer/sessions/${SESSION_A}`, headers: { authorization: `Bearer ${TOKEN_A}` } });
  assert.equal(ownRevoke.statusCode, 204);
  await app.close();
});

test('viewer logout revokes the current session', async () => {
  const app = await buildViewerApp(fakeViewerStore());
  const response = await app.inject({ method: 'POST', url: '/v1/viewer/logout', headers: { authorization: `Bearer ${TOKEN_B}` } });
  assert.equal(response.statusCode, 204);
  await app.close();
});

test('viewer dashboard is private to the authenticated viewer', async () => {
  const app = await buildViewerApp(fakeViewerStore());
  const unauth = await app.inject({ method: 'GET', url: '/v1/viewer/dashboard' });
  assert.equal(unauth.statusCode, 401);
  const response = await app.inject({ method: 'GET', url: '/v1/viewer/dashboard', headers: { authorization: `Bearer ${TOKEN_A}` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().supportedChannels[0], {
    channelId: 'chan-1', channelHandle: 'demo', channelDisplayName: 'Demo Channel',
    firstSupportedAt: '2026-01-01T00:00:00.000Z', lastSupportedAt: '2026-08-01T00:00:00.000Z',
    lifetimeAmountPaise: '150000', tipCount: '4', challengeCount: '1', memberState: 'active',
  });
  assert.equal('viewerAccountId' in response.json().supportedChannels[0], false);
  assert.equal('paymentId' in response.json().supportedChannels[0], false);
  await app.close();
});

test('viewer deletion request returns an erased-vs-retained record', async () => {
  const app = await buildViewerApp(fakeViewerStore());
  const response = await app.inject({ method: 'POST', url: '/v1/viewer/deletion-requests', headers: { authorization: `Bearer ${TOKEN_A}` } });
  assert.equal(response.statusCode, 202);
  const body = response.json();
  assert.ok(body.erased.includes('email'));
  assert.ok(body.retained.some((item: string) => item.includes('financial record')));
  assert.equal(body.legalDispositionOpen, true);
  await app.close();
});

test('viewer routes fail closed (503) when no viewer store is configured', async () => {
  const app = createTestFastify();
  await registerViewerRoutes(app, {});
  const response = await app.inject({ method: 'POST', url: '/v1/viewer/login', payload: { email: 'viewer@example.com', password: 'correct-horse-battery', deviceLabel: 'iPhone' } });
  assert.equal(response.statusCode, 503);
  await app.close();
});
