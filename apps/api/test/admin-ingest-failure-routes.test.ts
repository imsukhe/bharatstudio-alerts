import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerAdminRoutes } from '../src/routes/admin.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AdminStore } from '../src/domain/admin.js';
import type { IngestFailureAdminStore, IngestFailureEntry } from '../src/domain/ingest-failure-admin.js';
import type { AdminPasskeyStore } from '../src/domain/admin-passkeys.js';

// This suite builds its own minimal `createTestFastify()` instance (rather than
// apps/api/src/app.ts's buildApp, as admin-routes.test.ts does) because
// app.ts's `dependencies` bag has no `ingestFailureStore` field and this
// pass may not add one there — see routes/admin.ts's header comment on
// registerAdminRoutes. registerAdminRoutes itself is the real unit under
// test either way; this only skips the unrelated cors/helmet/rate-limit
// wiring buildApp also does.
function buildTestApp(sessions: SessionStore, store: AdminStore | undefined, ingestFailureStore: IngestFailureAdminStore | undefined) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  const mfa: AdminPasskeyStore = { async list() { return []; }, async begin() {}, async finishRegistration() {}, async finishAssertion() { return '2026-09-18T00:00:00.000Z'; }, async isVerified() { return true; }, async requestRecovery() { return '00000000-0000-4000-8000-00000000aa01'; }, async listPendingRecoveries() { return []; }, async approveRecovery() { return { status: 'awaiting_second_approval' as const, completedAt: null }; } };
  return registerAdminRoutes(app, sessions, store, ingestFailureStore, undefined, mfa, { rpId: 'admin.test', origins: ['http://localhost:3100'], challengeTtlSeconds: 60, mfaMaxAgeSeconds: 60 }).then(() => app);
}

const adminUserId = '00000000-0000-4000-8000-000000000901';
const nonAdminUserId = '00000000-0000-4000-8000-000000000902';
const failureId = '00000000-0000-4000-8000-000000000971';

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) {
    if (token === 'a'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000003', userId: adminUserId, expiresAt: '2026-08-17T00:00:00.000Z' };
    if (token === 'b'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000004', userId: nonAdminUserId, expiresAt: '2026-08-17T00:00:00.000Z' };
    return null;
  },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

function roleGateStore(): AdminStore {
  return {
    async isPlatformAdmin(userId) { return userId === adminUserId; },
    async listDlq() { return []; },
    async replayDlqDelivery() { return null; },
    async discardDlqDelivery() { return null; },
    async getChannelEntitlement() { return null; },
    async listChannelEntitlementHistory() { return []; },
    async overrideChannelEntitlement() { return null; },
  };
}

const failureEntry: IngestFailureEntry = {
  id: failureId,
  channelId: '00000000-0000-4000-8000-000000000911',
  channelHandle: 'ingest_channel_a',
  sourceId: 'yt-video-abc123',
  sourceEventType: 'superChatEvent',
  sqlstateCode: '23514',
  errorDetail: 'error_detail column check violation: payload exceeded bound',
  createdAt: '2026-08-16T00:00:00.000Z',
};

function ingestFailureStore(overrides: Partial<IngestFailureAdminStore> = {}): IngestFailureAdminStore {
  return {
    async listIngestFailures() { return { entries: [failureEntry], nextCursor: null }; },
    async getIngestFailure() { return failureEntry; },
    async acknowledgeIngestFailure() { return { id: failureId, acknowledgedAt: '2026-08-16T01:00:00.000Z' }; },
    ...overrides,
  };
}

const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
const nonAdminHeaders = { authorization: `Bearer ${'b'.repeat(48)}` };

test('the ingest-failure list is reachable only by a platform admin, never a plain authenticated user or an anonymous caller', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), ingestFailureStore());

  const asAdmin = await app.inject({ method: 'GET', url: '/v1/admin/ingest-failures', headers });
  assert.equal(asAdmin.statusCode, 200);
  assert.deepEqual(asAdmin.json().entries, [failureEntry]);

  const asNonAdmin = await app.inject({ method: 'GET', url: '/v1/admin/ingest-failures', headers: nonAdminHeaders });
  assert.equal(asNonAdmin.statusCode, 403);
  assert.equal(asNonAdmin.json().errorCode, 'platform_admin_required');

  const unauthenticated = await app.inject({ method: 'GET', url: '/v1/admin/ingest-failures' });
  assert.equal(unauthenticated.statusCode, 401);

  await app.close();
});

test('inspect-one and acknowledge are also platform-admin only', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), ingestFailureStore());

  const getAsNonAdmin = await app.inject({ method: 'GET', url: `/v1/admin/ingest-failures/${failureId}`, headers: nonAdminHeaders });
  assert.equal(getAsNonAdmin.statusCode, 403);

  const ackAsNonAdmin = await app.inject({ method: 'POST', url: `/v1/admin/ingest-failures/${failureId}/acknowledge`, headers: nonAdminHeaders, payload: { note: 'reviewed' } });
  assert.equal(ackAsNonAdmin.statusCode, 403);

  const getAsAdmin = await app.inject({ method: 'GET', url: `/v1/admin/ingest-failures/${failureId}`, headers });
  assert.equal(getAsAdmin.statusCode, 200);
  assert.equal(getAsAdmin.json().id, failureId);

  const ackAsAdmin = await app.inject({ method: 'POST', url: `/v1/admin/ingest-failures/${failureId}/acknowledge`, headers, payload: { note: 'poller mapping fixed, follow-up filed' } });
  assert.equal(ackAsAdmin.statusCode, 200);
  assert.equal(ackAsAdmin.json().id, failureId);

  await app.close();
});

test('acknowledge requires a non-empty note and maps an already-acknowledged/missing id to 404, not a 500', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), ingestFailureStore());
  const missingNote = await app.inject({ method: 'POST', url: `/v1/admin/ingest-failures/${failureId}/acknowledge`, headers, payload: {} });
  assert.equal(missingNote.statusCode, 400);
  await app.close();

  const notAcknowledgeableStore = ingestFailureStore({ async acknowledgeIngestFailure() { return null; } });
  const notAcknowledgeableApp = await buildTestApp(sessions, roleGateStore(), notAcknowledgeableStore);
  const notFound = await notAcknowledgeableApp.inject({ method: 'POST', url: `/v1/admin/ingest-failures/${failureId}/acknowledge`, headers, payload: { note: 'already handled' } });
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.json().errorCode, 'not_acknowledgeable');
  await notAcknowledgeableApp.close();
});

test('a missing ingest failure inspect returns 404, not a 500', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), ingestFailureStore({ async getIngestFailure() { return null; } }));
  const response = await app.inject({ method: 'GET', url: `/v1/admin/ingest-failures/${failureId}`, headers });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().errorCode, 'not_found');
  await app.close();
});

test('the ingest-failure routes fail closed as 503 without a configured ingestFailureStore, never letting an authenticated admin through unchecked, even though the DLQ store IS configured', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), undefined);
  const list = await app.inject({ method: 'GET', url: '/v1/admin/ingest-failures', headers });
  assert.equal(list.statusCode, 503);
  assert.equal(list.json().errorCode, 'admin_unavailable');

  const get = await app.inject({ method: 'GET', url: `/v1/admin/ingest-failures/${failureId}`, headers });
  assert.equal(get.statusCode, 503);

  const ack = await app.inject({ method: 'POST', url: `/v1/admin/ingest-failures/${failureId}/acknowledge`, headers, payload: { note: 'x' } });
  assert.equal(ack.statusCode, 503);
  await app.close();
});

test('a store failure never leaks provider/database detail through the ingest-failure routes', async () => {
  const store = ingestFailureStore({
    async listIngestFailures() { throw new Error('connection string contains a secret: postgres://user:pw@host'); },
  });
  const app = await buildTestApp(sessions, roleGateStore(), store);
  const response = await app.inject({ method: 'GET', url: '/v1/admin/ingest-failures', headers });
  assert.equal(response.statusCode, 503);
  const body = JSON.stringify(response.json());
  assert.ok(!body.includes('postgres://'), 'response body must never include a raw connection string');
  assert.ok(!body.includes('secret'), 'response body must never include the raw error message');
  await app.close();
});

test('no ingest-failure response shape carries stored OAuth token material or a raw connector payload — only the fields this admin surface deliberately projects', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), ingestFailureStore());

  const list = await app.inject({ method: 'GET', url: '/v1/admin/ingest-failures', headers });
  const listEntry = list.json().entries[0];
  assert.deepEqual(
    Object.keys(listEntry).sort(),
    ['channelHandle', 'channelId', 'createdAt', 'errorDetail', 'id', 'sourceEventType', 'sourceId', 'sqlstateCode'].sort(),
  );

  const detail = await app.inject({ method: 'GET', url: `/v1/admin/ingest-failures/${failureId}`, headers });
  const detailBody = detail.json();
  for (const forbiddenKey of ['payload', 'accessToken', 'refreshToken', 'oauthToken', 'token', 'viewerEmail', 'viewerDisplayName']) {
    assert.ok(!(forbiddenKey in detailBody), `response must never carry a ${forbiddenKey} field`);
  }
  const serialized = JSON.stringify(detailBody).toLowerCase();
  for (const forbiddenSubstring of ['bearer ', 'refresh_token', 'access_token', 'oauth']) {
    assert.ok(!serialized.includes(forbiddenSubstring), `response body must never contain "${forbiddenSubstring}"`);
  }

  await app.close();
});
