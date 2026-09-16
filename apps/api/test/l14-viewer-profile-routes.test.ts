import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { registerViewerRoutes } from '../src/routes/viewer.js';
import type { ViewerSessionPrincipal, ViewerStore } from '../src/domain/viewer-store.js';
import type { ViewerProfileStore } from '../src/domain/viewer-profile-store.js';
import type { ViewerPlatformIdentityVerifier } from '../src/domain/viewer-platform-identity-verifier.js';

const TOKEN_A = 'a'.repeat(48);
const VIEWER_A = '00000000-0000-4000-8000-0000000000a1';
const VIEWER_B = '00000000-0000-4000-8000-0000000000b1';
const SESSION_A: ViewerSessionPrincipal = { sessionId: 's1', viewerAccountId: VIEWER_A, expiresAt: '2026-10-01T00:00:00.000Z' };

function fakeProfileStore(overrides: Partial<ViewerProfileStore> = {}): ViewerProfileStore {
  return {
    async mintReceipt() {
      return { minted: false };
    },
    async resolveReceipt() {
      return null;
    },
    async claimPlatformIdentity() {
      return { viewerIdentityId: 'id-1', result: 'claimed' };
    },
    async getChannelBadges() {
      return { netTipCount: '0', netLifetimeAmountPaise: '0', firstSupportedAt: null, currentStreakDays: 0, badges: [] };
    },
    async searchPublicProfiles() {
      return [];
    },
    async getPublicProfile() {
      return null;
    },
    async setProfileVisibility() {
      return { visibility: 'private', slug: null };
    },
    ...overrides,
  };
}

function fakeStore(profile?: ViewerProfileStore): ViewerStore {
  return {
    async signup() {
      return { accessToken: TOKEN_A, viewerAccountId: VIEWER_A, expiresAt: '2026-10-01T00:00:00.000Z' };
    },
    async login() {
      return null;
    },
    async lookup(token) {
      return token === TOKEN_A ? SESSION_A : null;
    },
    async listSessions() {
      return [];
    },
    async revokeSession() {
      return true;
    },
    async getDashboard() {
      return [];
    },
    async requestDeletion() {
      return { schemaVersion: 'v1', erased: [], retained: [], legalDispositionOpen: true };
    },
    async requestPasswordReset() {},
    async resetPassword() {
      return true;
    },
    profile,
  };
}

async function buildApp(viewer: ViewerStore, platformIdentityVerifier?: ViewerPlatformIdentityVerifier) {
  const app = createTestFastify();
  await registerViewerRoutes(app, { viewer, platformIdentityVerifier });
  return app;
}

test('receipt page works with NO viewer account/auth and reveals nothing from an unknown token', async () => {
  const profile = fakeProfileStore({
    async resolveReceipt(token) {
      if (token !== 'REAL-TOKEN') return null;
      return {
        channelHandle: 'chan',
        channelDisplayName: 'Chan',
        grossAmountPaise: '20000',
        refundedAmountPaise: '0',
        netAmountPaise: '20000',
        currency: 'INR',
        donorDisplayName: 'Ravi',
        message: null,
        paymentStatus: 'captured',
        paidAt: '2026-09-01T00:00:00.000Z',
      };
    },
  });
  const app = await buildApp(fakeStore(profile));

  // No Authorization header anywhere in this request.
  const ok = await app.inject({ method: 'GET', url: '/v1/public/receipts/REAL-TOKEN' });
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.payload).receipt.netAmountPaise, '20000');

  const unknown = await app.inject({ method: 'GET', url: '/v1/public/receipts/GUESSED-TOKEN' });
  assert.equal(unknown.statusCode, 404);
  assert.ok(!unknown.payload.includes('20000'), 'an unknown/guessed token must never leak any amount');
});

test('receipt mint is idempotent: a second mint for an already-minted payment returns 409, not a second token', async () => {
  let calls = 0;
  const profile = fakeProfileStore({
    async mintReceipt() {
      calls += 1;
      return calls === 1 ? { minted: true, token: 'TOKEN1' } : { minted: false };
    },
  });
  const app = await buildApp(fakeStore(profile));

  const first = await app.inject({ method: 'POST', url: '/v1/public/receipts', payload: { intentId: '00000000-0000-4000-8000-000000000f01' } });
  assert.equal(first.statusCode, 201);
  assert.equal(JSON.parse(first.payload).token, 'TOKEN1');

  const second = await app.inject({ method: 'POST', url: '/v1/public/receipts', payload: { intentId: '00000000-0000-4000-8000-000000000f01' } });
  assert.equal(second.statusCode, 409);
});

test('platform claim requires viewer auth, ignores browser identity fields, and uses only the trusted verifier', async () => {
  const seenProviderIds: string[] = [];
  const profile = fakeProfileStore({
    async claimPlatformIdentity(viewerAccountId, _provider, providerUserId) {
      seenProviderIds.push(providerUserId);
      if (viewerAccountId === VIEWER_B) return { viewerIdentityId: 'id-1', result: 'rejected_contested' };
      return { viewerIdentityId: 'id-1', result: 'claimed' };
    },
  });
  const app = await buildApp(fakeStore(profile), {
    async getVerifiedIdentity(viewerAccountId, provider) {
      assert.equal(viewerAccountId, VIEWER_A);
      assert.equal(provider, 'youtube');
      return { providerUserId: 'UC_SERVER_VERIFIED', displayName: 'Verified channel' };
    },
  });

  const noAuth = await app.inject({ method: 'POST', url: '/v1/viewer/platform-claims', payload: { provider: 'youtube' } });
  assert.equal(noAuth.statusCode, 401);

  // CORRECTED 2026-09-16 (review: 2026-09-16-api-test-harness-validation-divergence).
  // This block previously asserted `statusCode === 201` here: that a browser-
  // injected `providerUserId` was ACCEPTED and silently dropped before the
  // handler. That was the bare-`Fastify()` harness default
  // (`removeAdditional: true`) talking, not this API. The route's body schema
  // is `additionalProperties: false` and this app sets
  // `removeAdditional: false` (src/fastify-ajv-options.ts), so the injected
  // field is REJECTED outright with 400 and the handler never runs. The
  // security property the test exists to prove is unchanged and in fact
  // stricter — the attacker-controlled value still never reaches
  // claimPlatformIdentity — but the status code and the mechanism were wrong.
  const injectedIdentity = await app.inject({
    method: 'POST', url: '/v1/viewer/platform-claims',
    headers: { authorization: `Bearer ${TOKEN_A}` },
    payload: { provider: 'youtube', providerUserId: 'UC_ATTACKER_CONTROLLED' },
  });
  assert.equal(injectedIdentity.statusCode, 400);
  assert.equal(JSON.parse(injectedIdentity.payload).code, 'FST_ERR_VALIDATION');
  assert.deepEqual(seenProviderIds, []);

  const claimed = await app.inject({
    method: 'POST',
    url: '/v1/viewer/platform-claims',
    headers: { authorization: `Bearer ${TOKEN_A}` },
    payload: { provider: 'youtube' },
  });
  assert.equal(claimed.statusCode, 201);
  assert.equal(JSON.parse(claimed.payload).result, 'claimed');
  assert.deepEqual(seenProviderIds, ['UC_SERVER_VERIFIED']);
});

test('platform claim fails closed while no trusted L15 verifier is wired', async () => {
  const app = await buildApp(fakeStore(fakeProfileStore()));
  const result = await app.inject({
    method: 'POST', url: '/v1/viewer/platform-claims',
    headers: { authorization: `Bearer ${TOKEN_A}` }, payload: { provider: 'youtube' },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(JSON.parse(result.payload).errorCode, 'platform_identity_unavailable');
});

test('public profile search never returns a profile a store implementation marks private', async () => {
  // The DB layer is the structural guarantee (see packages/db/tests/
  // l14-receipts-claims-badges-profiles.sql); this proves the route never
  // adds a second, looser path to the same data — it only ever forwards
  // whatever the store already filtered.
  const profile = fakeProfileStore({
    async searchPublicProfiles(query) {
      // A well-behaved store never returns viewer B (private); simulate
      // that contract and assert the route passes it through unmodified.
      if (query === 'viewer') return [{ displayName: 'Public Ravi', profileSlug: 'ravi' }];
      return [];
    },
    async getPublicProfile(slug) {
      return slug === 'ravi' ? { displayName: 'Public Ravi', profileSlug: 'ravi' } : null;
    },
  });
  const app = await buildApp(fakeStore(profile));

  const res = await app.inject({ method: 'GET', url: '/v1/public/viewer-profiles?q=viewer' });
  const body = JSON.parse(res.payload);
  assert.equal(body.profiles.length, 1);
  assert.deepEqual(body.profiles[0], { displayName: 'Public Ravi', profileSlug: 'ravi' });
  assert.equal('viewerAccountId' in body.profiles[0], false, 'public profile must not disclose a durable account identifier');

  const lookup = await app.inject({ method: 'GET', url: '/v1/public/viewer-profiles/ravi' });
  assert.equal(lookup.statusCode, 200);
  assert.deepEqual(JSON.parse(lookup.payload).profile, { displayName: 'Public Ravi', profileSlug: 'ravi' });
});

test('badges endpoint is viewer-auth-scoped, never a creator-facing route', async () => {
  const profile = fakeProfileStore({
    async getChannelBadges(viewerAccountId, channelId) {
      assert.equal(viewerAccountId, VIEWER_A);
      assert.equal(channelId, '00000000-0000-4000-8000-000000000c01');
      return { netTipCount: '2', netLifetimeAmountPaise: '5000', firstSupportedAt: null, currentStreakDays: 1, badges: ['supporter_since_2026'], viewerAccountId: VIEWER_A, paymentId: '00000000-0000-4000-8000-000000000d01', providerUserId: 'provider-private' } as ReturnType<ViewerProfileStore['getChannelBadges']> extends Promise<infer Result> ? Result : never;
    },
  });
  const app = await buildApp(fakeStore(profile));

  const noAuth = await app.inject({ method: 'GET', url: '/v1/viewer/channels/00000000-0000-4000-8000-000000000c01/badges' });
  assert.equal(noAuth.statusCode, 401);

  const ok = await app.inject({
    method: 'GET',
    url: '/v1/viewer/channels/00000000-0000-4000-8000-000000000c01/badges',
    headers: { authorization: `Bearer ${TOKEN_A}` },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.payload), {
    schemaVersion: 'v1',
    badges: { netTipCount: '2', netLifetimeAmountPaise: '5000', firstSupportedAt: null, currentStreakDays: 1, badges: ['supporter_since_2026'] },
  });
});

test('profile visibility request enforces a coherent slug, returns a narrow projection, and classifies failures correctly', async () => {
  const profile = fakeProfileStore({
    async setProfileVisibility(viewerAccountId, visibility, slug) {
      assert.equal(viewerAccountId, VIEWER_A);
      if (slug === 'taken') throw Object.assign(new Error('duplicate'), { code: '23505' });
      if (slug === 'offline') throw new Error('database unavailable');
      return { visibility, slug: visibility === 'public' ? slug : null, viewerAccountId: VIEWER_A } as { visibility: 'private' | 'public'; slug: string | null };
    },
  });
  const app = await buildApp(fakeStore(profile));
  const headers = { authorization: `Bearer ${TOKEN_A}` };

  const noAuth = await app.inject({ method: 'PUT', url: '/v1/viewer/profile-visibility', payload: { visibility: 'private' } });
  assert.equal(noAuth.statusCode, 401);
  const missingPublicSlug = await app.inject({ method: 'PUT', url: '/v1/viewer/profile-visibility', headers, payload: { visibility: 'public' } });
  assert.equal(missingPublicSlug.statusCode, 400);
  const privateSlug = await app.inject({ method: 'PUT', url: '/v1/viewer/profile-visibility', headers, payload: { visibility: 'private', slug: 'ignored' } });
  assert.equal(privateSlug.statusCode, 400);

  const ok = await app.inject({ method: 'PUT', url: '/v1/viewer/profile-visibility', headers, payload: { visibility: 'public', slug: 'viewer-a' } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.payload), { schemaVersion: 'v1', visibility: 'public', slug: 'viewer-a' });

  const conflict = await app.inject({ method: 'PUT', url: '/v1/viewer/profile-visibility', headers, payload: { visibility: 'public', slug: 'taken' } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(JSON.parse(conflict.payload).errorCode, 'profile_slug_taken');
  const unavailable = await app.inject({ method: 'PUT', url: '/v1/viewer/profile-visibility', headers, payload: { visibility: 'public', slug: 'offline' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(JSON.parse(unavailable.payload).errorCode, 'viewer_auth_unavailable');
});

test('viewer routes without a `profile` store still compile/run (back-compat) and fail closed 503', async () => {
  const app = await buildApp(fakeStore(undefined));
  const res = await app.inject({ method: 'GET', url: '/v1/public/receipts/anything' });
  assert.equal(res.statusCode, 503);
  const badges = await app.inject({ method: 'GET', url: '/v1/viewer/channels/00000000-0000-4000-8000-000000000c01/badges', headers: { authorization: `Bearer ${TOKEN_A}` } });
  assert.equal(badges.statusCode, 503);
  const visibility = await app.inject({ method: 'PUT', url: '/v1/viewer/profile-visibility', headers: { authorization: `Bearer ${TOKEN_A}` }, payload: { visibility: 'private' } });
  assert.equal(visibility.statusCode, 503);
});
