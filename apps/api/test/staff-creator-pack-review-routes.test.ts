import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerAdminRoutes } from '../src/routes/admin.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AdminStore } from '../src/domain/admin.js';
import type {
  CreatorPackReviewDetail,
  PendingCreatorPackEntry,
  StaffCreatorPackReviewStore,
} from '../src/domain/staff-creator-pack-review.js';

// Same shape as admin-ingest-failure-routes.test.ts: registerAdminRoutes
// itself is the unit under test, on a minimal `createTestFastify()` instance rather
// than app.ts's buildApp — this pass does not own app.ts, and this
// store's production wiring there is explicitly out of scope (see
// routes/admin.ts's header comment on staffCreatorPackReviewStore).
function buildTestApp(
  sessions: SessionStore,
  store: AdminStore | undefined,
  staffStore: StaffCreatorPackReviewStore | undefined,
) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  return registerAdminRoutes(app, sessions, store, undefined, staffStore).then(() => app);
}

const staffUserId = '00000000-0000-4000-8000-000000000991';
const channelOwnerUserId = '00000000-0000-4000-8000-000000000992';
const plainUserId = '00000000-0000-4000-8000-000000000993';
const packId = '00000000-0000-4000-8000-000000000981';

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) {
    if (token === 'a'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000003', userId: staffUserId, expiresAt: '2026-08-17T00:00:00.000Z' };
    if (token === 'b'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000004', userId: channelOwnerUserId, expiresAt: '2026-08-17T00:00:00.000Z' };
    if (token === 'c'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000005', userId: plainUserId, expiresAt: '2026-08-17T00:00:00.000Z' };
    return null;
  },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

// A channel owner is authenticated but is NOT a platform admin — the SQL
// layer (0122) proves is_platform_admin() is independent of
// has_channel_role(); this mirrors that at the route layer: only
// staffUserId passes the gate.
function roleGateStore(): AdminStore {
  return {
    async isPlatformAdmin(userId) { return userId === staffUserId; },
    async listDlq() { return []; },
    async replayDlqDelivery() { return null; },
    async discardDlqDelivery() { return null; },
    async getChannelEntitlement() { return null; },
    async listChannelEntitlementHistory() { return []; },
    async overrideChannelEntitlement() { return null; },
  };
}

const pendingEntry: PendingCreatorPackEntry = {
  id: packId,
  channelId: '00000000-0000-4000-8000-000000000971',
  displayName: 'Hype Wave',
  category: 'Reaction',
  byteSize: 48,
  creatorAttested: true,
  createdAt: '2026-09-01T00:00:00.000Z',
};

const reviewDetail: CreatorPackReviewDetail = {
  id: packId,
  channelId: '00000000-0000-4000-8000-000000000971',
  displayName: 'Hype Wave',
  category: 'Reaction',
  assetBase64: Buffer.from('{"v":"1.0","layers":[]}').toString('base64'),
  mimeType: 'application/json',
  byteSize: 48,
  creatorAttested: true,
  status: 'pending_review',
  createdAt: '2026-09-01T00:00:00.000Z',
};

function staffStore(overrides: Partial<StaffCreatorPackReviewStore> = {}): StaffCreatorPackReviewStore {
  return {
    async listPendingCreatorPacks() { return [pendingEntry]; },
    async getCreatorPackForReview() { return reviewDetail; },
    async reviewCreatorPack(_userId, id, approved) {
      return { id, status: approved ? 'active' : 'pending_review', decision: approved ? 'approved' : 'rejected', reviewerId: staffUserId, reviewedAt: '2026-09-01T01:00:00.000Z' };
    },
    async listReviewAudit() {
      return [{ id: '00000000-0000-4000-8000-000000000961', reviewerId: staffUserId, decision: 'rejected', reason: 'external URL reference', reviewedAt: '2026-09-01T00:30:00.000Z' }];
    },
    ...overrides,
  };
}

const staffHeaders = { authorization: `Bearer ${'a'.repeat(48)}` };
const ownerHeaders = { authorization: `Bearer ${'b'.repeat(48)}` };
const plainHeaders = { authorization: `Bearer ${'c'.repeat(48)}` };

test('a non-staff authenticated user is rejected from every creator-pack review route', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), staffStore());

  const list = await app.inject({ method: 'GET', url: '/v1/admin/creator-packs/pending', headers: plainHeaders });
  assert.equal(list.statusCode, 403);
  assert.equal(list.json().errorCode, 'platform_admin_required');

  const get = await app.inject({ method: 'GET', url: `/v1/admin/creator-packs/${packId}`, headers: plainHeaders });
  assert.equal(get.statusCode, 403);

  const review = await app.inject({ method: 'POST', url: `/v1/admin/creator-packs/${packId}/review`, headers: plainHeaders, payload: { approved: true } });
  assert.equal(review.statusCode, 403);

  const audit = await app.inject({ method: 'GET', url: `/v1/admin/creator-packs/${packId}/audit`, headers: plainHeaders });
  assert.equal(audit.statusCode, 403);

  const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/creator-packs/pending' });
  assert.equal(anonymous.statusCode, 401);

  await app.close();
});

test('a channel owner cannot reach a staff creator-pack review route by any path', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), staffStore());

  const list = await app.inject({ method: 'GET', url: '/v1/admin/creator-packs/pending', headers: ownerHeaders });
  assert.equal(list.statusCode, 403);
  assert.equal(list.json().errorCode, 'platform_admin_required');

  const get = await app.inject({ method: 'GET', url: `/v1/admin/creator-packs/${packId}`, headers: ownerHeaders });
  assert.equal(get.statusCode, 403);

  const review = await app.inject({ method: 'POST', url: `/v1/admin/creator-packs/${packId}/review`, headers: ownerHeaders, payload: { approved: true } });
  assert.equal(review.statusCode, 403);

  await app.close();
});

test('staff can list pending packs, inspect one, and read the audit trail', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), staffStore());

  const list = await app.inject({ method: 'GET', url: '/v1/admin/creator-packs/pending', headers: staffHeaders });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().entries, [pendingEntry]);

  const get = await app.inject({ method: 'GET', url: `/v1/admin/creator-packs/${packId}`, headers: staffHeaders });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().id, packId);

  const audit = await app.inject({ method: 'GET', url: `/v1/admin/creator-packs/${packId}/audit`, headers: staffHeaders });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().entries[0].reviewerId, staffUserId);

  await app.close();
});

test('approve makes a pending sticker visible (active); reject keeps it non-visible (pending_review) — both attributed to the reviewer', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), staffStore());

  const approve = await app.inject({ method: 'POST', url: `/v1/admin/creator-packs/${packId}/review`, headers: staffHeaders, payload: { approved: true } });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().status, 'active');
  assert.equal(approve.json().decision, 'approved');
  assert.equal(approve.json().reviewerId, staffUserId);

  const reject = await app.inject({ method: 'POST', url: `/v1/admin/creator-packs/${packId}/review`, headers: staffHeaders, payload: { approved: false, reason: 'fails brand-safety review' } });
  assert.equal(reject.statusCode, 200);
  assert.equal(reject.json().status, 'pending_review');
  assert.equal(reject.json().decision, 'rejected');
  assert.equal(reject.json().reviewerId, staffUserId);

  await app.close();
});

test('a rejection requires a non-empty reason: refused with 400 before the store is ever called', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), staffStore({
    async reviewCreatorPack() { throw new Error('store must not be called when the reason is missing'); },
  }));

  const missingReason = await app.inject({ method: 'POST', url: `/v1/admin/creator-packs/${packId}/review`, headers: staffHeaders, payload: { approved: false } });
  assert.equal(missingReason.statusCode, 400);
  assert.equal(missingReason.json().errorCode, 'reason_required');

  const blankReason = await app.inject({ method: 'POST', url: `/v1/admin/creator-packs/${packId}/review`, headers: staffHeaders, payload: { approved: false, reason: '   ' } });
  assert.equal(blankReason.statusCode, 400);

  await app.close();
});

test('reviewing an id that does not exist or is not pending review maps to 404, not a 500', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), staffStore({ async reviewCreatorPack() { return null; } }));
  const response = await app.inject({ method: 'POST', url: `/v1/admin/creator-packs/${packId}/review`, headers: staffHeaders, payload: { approved: true } });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().errorCode, 'not_reviewable');
  await app.close();
});

test('a missing creator-pack inspect returns 404, not a 500', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), staffStore({ async getCreatorPackForReview() { return null; } }));
  const response = await app.inject({ method: 'GET', url: `/v1/admin/creator-packs/${packId}`, headers: staffHeaders });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().errorCode, 'not_found');
  await app.close();
});

test('the creator-pack review routes fail closed as 503 without a configured staff store, even for an authenticated platform admin', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), undefined);

  const list = await app.inject({ method: 'GET', url: '/v1/admin/creator-packs/pending', headers: staffHeaders });
  assert.equal(list.statusCode, 503);
  assert.equal(list.json().errorCode, 'admin_unavailable');

  const get = await app.inject({ method: 'GET', url: `/v1/admin/creator-packs/${packId}`, headers: staffHeaders });
  assert.equal(get.statusCode, 503);

  const review = await app.inject({ method: 'POST', url: `/v1/admin/creator-packs/${packId}/review`, headers: staffHeaders, payload: { approved: true } });
  assert.equal(review.statusCode, 503);

  await app.close();
});

test('review-detail and pending-list responses carry no viewer/supporter PII — assert the exact key set', async () => {
  const app = await buildTestApp(sessions, roleGateStore(), staffStore());

  const list = await app.inject({ method: 'GET', url: '/v1/admin/creator-packs/pending', headers: staffHeaders });
  assert.deepEqual(
    Object.keys(list.json().entries[0]).sort(),
    ['byteSize', 'category', 'channelId', 'createdAt', 'creatorAttested', 'displayName', 'id'].sort(),
  );

  const get = await app.inject({ method: 'GET', url: `/v1/admin/creator-packs/${packId}`, headers: staffHeaders });
  const detailBody = get.json();
  assert.deepEqual(
    Object.keys(detailBody).sort(),
    ['assetBase64', 'byteSize', 'category', 'channelId', 'createdAt', 'creatorAttested', 'displayName', 'id', 'mimeType', 'schemaVersion', 'status'].sort(),
  );
  for (const forbiddenKey of ['viewerEmail', 'viewerDisplayName', 'tipperId', 'supporterName', 'orderId', 'payerName']) {
    assert.ok(!(forbiddenKey in detailBody), `response must never carry a ${forbiddenKey} field`);
  }

  await app.close();
});

test('a store failure never leaks provider/database detail through the creator-pack review routes', async () => {
  const store = staffStore({
    async listPendingCreatorPacks() { throw new Error('connection string contains a secret: postgres://user:pw@host'); },
  });
  const app = await buildTestApp(sessions, roleGateStore(), store);
  const response = await app.inject({ method: 'GET', url: '/v1/admin/creator-packs/pending', headers: staffHeaders });
  assert.equal(response.statusCode, 503);
  const body = JSON.stringify(response.json());
  assert.ok(!body.includes('postgres://'), 'response body must never include a raw connection string');
  assert.ok(!body.includes('secret'), 'response body must never include the raw error message');
  await app.close();
});
