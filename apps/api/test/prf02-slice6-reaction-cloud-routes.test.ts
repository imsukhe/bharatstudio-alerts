import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerMasterCanvasRoutes } from '../src/routes/master-canvas.js';
import { registerPublicRoutes } from '../src/routes/public.js';
import {
  projectReactionCloud,
  type ReactionCloudEntry,
  type ReactionCloudOverlayStore,
  type ReactionSendOutcome,
  type ReactionSendStore,
} from '../src/domain/reaction-cloud-store.js';
import type { PublicChannelRepository } from '../src/domain/public-channel.js';
import type { PublicAbuseGuard } from '../src/domain/public-abuse.js';

/*
 * PRF-02 slice 6 / PRF-06, §6 catalogue module #5 (Reaction Cloud).
 * Handler-level cases for both halves of the slice:
 *
 *   GET  /v1/overlay-widgets/:overlayId/reaction-cloud   (overlay bearer token)
 *   POST /v1/public/channels/:handle/reactions           (public, unauthenticated)
 *
 * The route layer's own correctness surface and nothing below it. The SQL
 * layer's proof that the read CANNOT return anything identifying, that
 * sampling happens in the query, and that the rate limit is the creator's
 * own one-minute figure lives in
 * packages/db/tests/prf02_slice6_reaction_cloud.sql. This file is the
 * second, independent narrowing: even a store handing up identifying
 * fields must not get them past the route.
 */

const overlayId = '00000000-0000-4000-8000-000000005741';
const overlayUrl = `/v1/overlay-widgets/${overlayId}/reaction-cloud`;
const sendUrl = '/v1/public/channels/reaction_a/reactions';
const channelId = '00000000-0000-4000-8000-000000005711';
const catalogueEntryId = '00000000-0000-4000-8000-000000005721';

const cloud: ReactionCloudEntry[] = [
  { entrySource: 'catalogue', entryId: catalogueEntryId, displayName: 'Clap', reactionCount: 12 },
  { entrySource: 'creator_pack', entryId: '00000000-0000-4000-8000-000000005731', displayName: 'Pack Star', reactionCount: 3 },
];

async function buildOverlayApp(store?: Partial<ReactionCloudOverlayStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerMasterCanvasRoutes(
    app,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    store as ReactionCloudOverlayStore | undefined,
  );
  return app;
}

const channelRepository: PublicChannelRepository = {
  async findByHandle(handle) {
    return handle === 'reaction_a'
      ? {
        channelId,
        handle: 'reaction_a',
        displayName: 'Reaction A',
        acceptingTips: true,
        minimumTipPaise: 1000,
        publicConfigVersion: 1,
      }
      : null;
  },
  async listFeatured() { return []; },
};

async function buildSendApp(options: {
  store?: Partial<ReactionSendStore>;
  turnstileRequired?: boolean;
  abuseGuard?: PublicAbuseGuard;
  repository?: PublicChannelRepository;
} = {}) {
  const app = createTestFastify();
  await registerPublicRoutes(
    app,
    options.repository === undefined ? channelRepository : options.repository,
    undefined,
    'test',
    undefined,
    options.abuseGuard,
    options.turnstileRequired ?? false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.store as ReactionSendStore | undefined,
  );
  return app;
}

function sendBody(overrides: Record<string, unknown> = {}) {
  return { entrySource: 'catalogue', entryId: catalogueEntryId, ...overrides };
}

// A 43-character base64url token, the exact shape the route's own cookie
// reader accepts -- and the SHA-256 hex hash the route must derive from it.
// Both are computed here the way the two public checkout POSTs compute them,
// so the assertions below fail if the reaction route ever grows a second,
// divergent identity mechanism instead of reusing the existing one.
const senderToken = 'a'.repeat(43);
const senderTokenHash = createHash('sha256').update(senderToken, 'utf8').digest('hex');
const senderCookie = `__Host-bsa-anonymous=${senderToken}`;

// =====================================================================
// S6.30 -- the overlay read's auth surface
// =====================================================================

test('overlay reaction-cloud rejects a request with no bearer token', async () => {
  const app = await buildOverlayApp({ async listForOverlay() { return cloud; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().errorCode, 'overlay_unauthorized');
  assert.equal(typeof response.json().traceId, 'string');
  await app.close();
});

test('overlay reaction-cloud rejects a malformed authorization header, never a 500', async () => {
  const app = await buildOverlayApp({ async listForOverlay() { return cloud; } });
  for (const header of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer   ', 'overlay-token-only']) {
    const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: header } });
    assert.equal(response.statusCode, 401, `header ${JSON.stringify(header)} must be rejected`);
    assert.equal(response.json().errorCode, 'overlay_unauthorized');
  }
  await app.close();
});

test('overlay reaction-cloud forwards the exact bearer token and overlay id to the store', async () => {
  let seen: { token?: string; overlayId?: string } = {};
  const app = await buildOverlayApp({
    async listForOverlay(token, id) { seen = { token, overlayId: id }; return cloud; },
  });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer overlay-token-value' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, { token: 'overlay-token-value', overlayId });
  await app.close();
});

test('overlay reaction-cloud fails closed as a retryable 503 when the store is unwired', async () => {
  const app = await buildOverlayApp(undefined);
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer t' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'master_canvas_store_unavailable');
  assert.equal(response.json().retryable, true);
  await app.close();
});

test('overlay reaction-cloud answers 503, never 500 or 401, when the store throws', async () => {
  const app = await buildOverlayApp({ async listForOverlay() { throw new Error('connection reset by peer at 10.0.0.4'); } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer t' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'master_canvas_store_unavailable');
  // A database error string must never reach a broadcast surface.
  assert.ok(!JSON.stringify(response.json()).includes('10.0.0.4'));
  await app.close();
});

test('overlay reaction-cloud returns the entries it was given', async () => {
  const app = await buildOverlayApp({ async listForOverlay() { return cloud; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer t' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().entries, cloud);
  await app.close();
});

test('overlay reaction-cloud answers 200 with an empty list when the token is not recognised', async () => {
  // An unrecognised/expired/revoked/foreign token makes the SQL function
  // return zero rows. An empty cloud and an unauthorised read both mean
  // "paint nothing", so they are deliberately the same answer here.
  const app = await buildOverlayApp({ async listForOverlay() { return []; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer nope' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().entries, []);
  await app.close();
});

// =====================================================================
// S6.31 -- the route narrows a SECOND, independent time
// =====================================================================

test('overlay reaction-cloud strips identifying fields a store somehow hands up', async () => {
  const polluted = [{
    entrySource: 'catalogue',
    entryId: catalogueEntryId,
    displayName: 'Clap',
    reactionCount: 12,
    viewerId: '00000000-0000-4000-8000-0000000000a1',
    anonymousIdentityId: 'anon-token-hash',
    sessionId: 'sess-1',
    ipAddress: '203.0.113.7',
    createdAt: '2026-09-16T10:00:00.000Z',
  }] as unknown as ReactionCloudEntry[];
  const app = await buildOverlayApp({ async listForOverlay() { return polluted; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer t' } });
  assert.equal(response.statusCode, 200);
  const body = JSON.stringify(response.json());
  for (const leak of ['viewerId', 'anonymousIdentityId', 'sessionId', 'ipAddress', 'createdAt', '203.0.113.7', 'anon-token-hash']) {
    assert.ok(!body.includes(leak), `${leak} must not survive the route's projection`);
  }
  assert.deepEqual(response.json().entries, [{ entrySource: 'catalogue', entryId: catalogueEntryId, displayName: 'Clap', reactionCount: 12 }]);
  await app.close();
});

test('projectReactionCloud drops entries that are not renderable, rather than rendering them', async () => {
  const mixed = [
    { entrySource: 'catalogue', entryId: catalogueEntryId, displayName: 'Clap', reactionCount: 12 },
    { entrySource: 'emoji', entryId: catalogueEntryId, displayName: 'Nope', reactionCount: 1 },
    { entrySource: 'catalogue', entryId: catalogueEntryId, displayName: 'Zero', reactionCount: 0 },
    { entrySource: 'catalogue', entryId: catalogueEntryId, displayName: 'Negative', reactionCount: -4 },
    { entrySource: 'catalogue', entryId: catalogueEntryId, displayName: 'Fractional', reactionCount: 1.5 },
    { entrySource: 'catalogue', entryId: '', displayName: 'No id', reactionCount: 2 },
    { entrySource: 'catalogue', entryId: catalogueEntryId, displayName: '', reactionCount: 2 },
  ] as unknown as ReactionCloudEntry[];
  assert.deepEqual(projectReactionCloud(mixed), [
    { entrySource: 'catalogue', entryId: catalogueEntryId, displayName: 'Clap', reactionCount: 12 },
  ]);
  assert.deepEqual(projectReactionCloud(null), []);
  assert.deepEqual(projectReactionCloud(undefined), []);
  assert.deepEqual(projectReactionCloud('not an array' as unknown as ReactionCloudEntry[]), []);
});

test('the route does NOT re-apply a display ceiling of its own', async () => {
  // §19.5's sampling happens once, in the query. A second cap here would
  // make it ambiguous where sampling happens; its absence is the proof
  // that the real one is server-side. Forty entries in, forty entries out.
  const many: ReactionCloudEntry[] = Array.from({ length: 40 }, (_, index) => ({
    entrySource: 'catalogue' as const,
    entryId: `00000000-0000-4000-8000-0000000057${String(index).padStart(2, '0')}`,
    displayName: `Entry ${index}`,
    reactionCount: 40 - index,
  }));
  const app = await buildOverlayApp({ async listForOverlay() { return many; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer t' } });
  assert.equal(response.json().entries.length, 40);
  await app.close();
});

// =====================================================================
// S6.24 - S6.27 -- the public send path's outcomes
// =====================================================================

function storeReturning(outcome: ReactionSendOutcome): Partial<ReactionSendStore> {
  return { async record() { return outcome; } };
}

test('a recorded reaction answers 201', async () => {
  const app = await buildSendApp({ store: storeReturning('recorded') });
  const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody() });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().outcome, 'recorded');
  await app.close();
});

test('the resolved channel id, entry source and entry id reach the store unchanged', async () => {
  let seen: unknown[] = [];
  const app = await buildSendApp({ store: { async record(...args) { seen = args; return 'recorded'; } } });
  await app.inject({
    method: 'POST',
    url: sendUrl,
    payload: sendBody({ entrySource: 'creator_pack' }),
    headers: { cookie: senderCookie },
  });
  assert.deepEqual(seen, [channelId, 'creator_pack', catalogueEntryId, senderTokenHash]);
  await app.close();
});

// =====================================================================
// S6.50 / S6.51 / S6.52 -- the sender fingerprint: obtained the way the
// existing checkout flow obtains it, and used for admission control only
// =====================================================================

test('an existing __Host-bsa-anonymous cookie is reused, hashed, and never echoed back', async () => {
  let seen: unknown[] = [];
  const app = await buildSendApp({ store: { async record(...args) { seen = args; return 'recorded'; } } });
  const response = await app.inject({
    method: 'POST',
    url: sendUrl,
    payload: sendBody(),
    headers: { cookie: senderCookie },
  });

  // Only the SHA-256 hex hash crosses the boundary; the raw token does not.
  assert.equal(seen[3], senderTokenHash);
  assert.match(String(seen[3]), /^[0-9a-f]{64}$/);
  assert.notEqual(seen[3], senderToken);

  // A cookie that already exists is NOT reissued.
  assert.equal(response.headers['set-cookie'], undefined);

  // S6.52: the fingerprint appears in no response body.
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', outcome: 'recorded' });
  assert.equal(response.body.includes(senderTokenHash), false);
  assert.equal(response.body.includes(senderToken), false);
  await app.close();
});

test('with no cookie the route mints one exactly as the checkout POSTs do', async () => {
  let seen: unknown[] = [];
  const app = await buildSendApp({ store: { async record(...args) { seen = args; return 'recorded'; } } });
  const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody() });

  const setCookie = String(response.headers['set-cookie']);
  const minted = /^__Host-bsa-anonymous=([A-Za-z0-9_-]{43});/.exec(setCookie);
  assert.notEqual(minted, null);
  // __Host- cookies are only valid with Secure + Path=/ and no Domain, and
  // the 30-day Max-Age is the existing flow's, not a new one.
  assert.equal(setCookie.includes('Path=/'), true);
  assert.equal(setCookie.includes('HttpOnly'), true);
  assert.equal(setCookie.includes('Secure'), true);
  assert.equal(setCookie.includes('Max-Age=2592000'), true);
  assert.equal(setCookie.includes('Domain='), false);

  // The hash the store received is the hash OF THE MINTED TOKEN -- the route
  // does not mint one value and key the limit on another.
  assert.equal(seen[3], createHash('sha256').update(String(minted?.[1]), 'utf8').digest('hex'));
  await app.close();
});

test('a malformed cookie is not trusted: the route mints a fresh token rather than keying on rubbish', async () => {
  let seen: unknown[] = [];
  const app = await buildSendApp({ store: { async record(...args) { seen = args; return 'recorded'; } } });
  const response = await app.inject({
    method: 'POST',
    url: sendUrl,
    payload: sendBody(),
    headers: { cookie: '__Host-bsa-anonymous=not-a-valid-token' },
  });
  assert.notEqual(response.headers['set-cookie'], undefined);
  assert.match(String(seen[3]), /^[0-9a-f]{64}$/);
  assert.notEqual(seen[3], createHash('sha256').update('not-a-valid-token', 'utf8').digest('hex'));
  await app.close();
});

test('an unresolvable sender is REFUSED with 400, never accepted and never downgraded to a weaker limit', async () => {
  const app = await buildSendApp({ store: storeReturning('sender_unidentified') });
  const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody() });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'reaction_sender_unidentified');
  assert.equal(response.json().retryable, false);
  await app.close();
});

test('the sender fingerprint is never written to a log line', async () => {
  const logged: string[] = [];
  const app = await buildSendApp({ store: { async record() { throw new Error('boom'); } } });
  app.log.error = ((...args: unknown[]) => { logged.push(JSON.stringify(args)); }) as typeof app.log.error;
  const response = await app.inject({
    method: 'POST',
    url: sendUrl,
    payload: sendBody(),
    headers: { cookie: senderCookie },
  });
  assert.equal(response.statusCode, 503);
  for (const line of logged) {
    assert.equal(line.includes(senderTokenHash), false);
    assert.equal(line.includes(senderToken), false);
  }
  await app.close();
});

test('a sender at its per-minute ceiling answers a retryable 429', async () => {
  const app = await buildSendApp({ store: storeReturning('rate_limited') });
  const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody() });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().errorCode, 'reaction_rate_limited');
  assert.equal(response.json().retryable, true);
  await app.close();
});

test('an unknown entry answers 400 and an unavailable one answers 403', async () => {
  const unknown = await buildSendApp({ store: storeReturning('unknown_entry') });
  const unknownResponse = await unknown.inject({ method: 'POST', url: sendUrl, payload: sendBody() });
  assert.equal(unknownResponse.statusCode, 400);
  assert.equal(unknownResponse.json().errorCode, 'unknown_reaction_entry');
  await unknown.close();

  const unavailable = await buildSendApp({ store: storeReturning('not_available') });
  const unavailableResponse = await unavailable.inject({ method: 'POST', url: sendUrl, payload: sendBody() });
  assert.equal(unavailableResponse.statusCode, 403);
  assert.equal(unavailableResponse.json().errorCode, 'reaction_entry_not_available');
  await unavailable.close();
});

test('an unknown handle answers 404 and never reaches the store', async () => {
  let called = false;
  const app = await buildSendApp({ store: { async record() { called = true; return 'recorded'; } } });
  const response = await app.inject({ method: 'POST', url: '/v1/public/channels/nobody/reactions', payload: sendBody() });
  assert.equal(response.statusCode, 404);
  assert.equal(called, false);
  await app.close();
});

test('an unwired store fails closed as a retryable 503', async () => {
  const app = await buildSendApp({ store: undefined });
  const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody() });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'reaction_unavailable');
  assert.equal(response.json().retryable, true);
  await app.close();
});

test('a throwing store answers 503 and leaks no error string', async () => {
  const app = await buildSendApp({ store: { async record() { throw new Error('relation "channel_reaction_sends" does not exist'); } } });
  const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody() });
  assert.equal(response.statusCode, 503);
  assert.ok(!JSON.stringify(response.json()).includes('channel_reaction_sends'));
  await app.close();
});

// =====================================================================
// S6.28 -- the EXISTING abuse guard, reused. No new authentication model.
// =====================================================================

test('with Turnstile required, a missing or failing token answers the existing 403 envelope', async () => {
  const failing: PublicAbuseGuard = { async verify() { return false; } };
  const app = await buildSendApp({ store: storeReturning('recorded'), turnstileRequired: true, abuseGuard: failing });
  const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody() });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'bot_verification_required');
  assert.equal(response.json().retryable, false);
  await app.close();
});

test('with Turnstile required and no guard wired at all, the send is refused rather than allowed', async () => {
  const app = await buildSendApp({ store: storeReturning('recorded'), turnstileRequired: true, abuseGuard: undefined });
  const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody(), });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().errorCode, 'bot_verification_required');
  await app.close();
});

test('with Turnstile required, a passing token reaches the store and the token is forwarded with the caller address', async () => {
  let seenToken: string | undefined;
  const passing: PublicAbuseGuard = { async verify(token) { seenToken = token; return true; } };
  const app = await buildSendApp({ store: storeReturning('recorded'), turnstileRequired: true, abuseGuard: passing });
  const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody({ turnstileToken: 'tk-123' }) });
  assert.equal(response.statusCode, 201);
  assert.equal(seenToken, 'tk-123');
  await app.close();
});

test('with Turnstile NOT required, no guard is consulted -- the flag is the existing one, unchanged', async () => {
  let consulted = false;
  const guard: PublicAbuseGuard = { async verify() { consulted = true; return true; } };
  const app = await buildSendApp({ store: storeReturning('recorded'), turnstileRequired: false, abuseGuard: guard });
  const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody() });
  assert.equal(response.statusCode, 201);
  assert.equal(consulted, false);
  await app.close();
});

// =====================================================================
// S6.29 -- the request body is validated under the SERVER's own AJV rules
// =====================================================================

test('an undeclared body property is REJECTED, not silently stripped', async () => {
  // createTestFastify imports src/app.ts's own fastifyAjvOptions(), so this
  // 400 is the production rule rather than a harness default. A bare
  // Fastify() would strip `viewerId` and pass.
  const app = await buildSendApp({ store: storeReturning('recorded') });
  const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody({ viewerId: '00000000-0000-4000-8000-0000000000a1' }) });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test('an unrecognised entry source is rejected at the boundary, never passed to SQL', async () => {
  let called = false;
  const app = await buildSendApp({ store: { async record() { called = true; return 'recorded'; } } });
  for (const entrySource of ['emoji', 'audio', '', 'CATALOGUE']) {
    const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody({ entrySource }) });
    assert.equal(response.statusCode, 400, `entrySource ${JSON.stringify(entrySource)} must be rejected`);
  }
  assert.equal(called, false);
  await app.close();
});

test('a non-uuid entry id is rejected at the boundary', async () => {
  const app = await buildSendApp({ store: storeReturning('recorded') });
  const response = await app.inject({ method: 'POST', url: sendUrl, payload: sendBody({ entryId: 'not-a-uuid' }) });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test('a missing body field is rejected at the boundary', async () => {
  const app = await buildSendApp({ store: storeReturning('recorded') });
  for (const payload of [{}, { entrySource: 'catalogue' }, { entryId: catalogueEntryId }]) {
    const response = await app.inject({ method: 'POST', url: sendUrl, payload });
    assert.equal(response.statusCode, 400);
  }
  await app.close();
});
