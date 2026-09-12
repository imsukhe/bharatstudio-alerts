import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Sql } from 'postgres';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerInteractionRoutes } from '../src/routes/interactions.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import type { PaidVoteOverlayStore, PaidVoteTally, PaidSupportVoteStore } from '../src/domain/vote-payment-types.js';

// L16 gap closure (0108): the two new paid-vote routes plus the four new
// widget overlay reads (recent-tips/top-supporters/supporter-ticker/
// mega-tip-banner). These handler-level cases are complemented by
// l16-runtime-composition.test.ts, which verifies buildApp wiring.

const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000011';
const definitionId = '00000000-0000-4000-8000-000000000091';
const overlayId = '00000000-0000-4000-8000-000000000095';
const token = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};
const account = { async hasAcceptedActiveDocuments() { return true; } } as unknown as AccountStore;

// Mirrors apps/api/test/l09-metrics-routes.test.ts's mockSql helper exactly.
function mockSql(rows: unknown[]): Sql {
  const fn = ((...args: unknown[]) => {
    const first = args[0] as { raw?: unknown } | unknown[];
    const isTaggedTemplateCall = first !== null && typeof first === 'object' && 'raw' in (first as object);
    if (isTaggedTemplateCall) return Promise.resolve(rows);
    return first;
  }) as unknown as Sql;
  return fn;
}

async function buildTestApp(deps: {
  paidVotes?: Partial<PaidSupportVoteStore>;
  paidVoteOverlay?: Partial<PaidVoteOverlayStore>;
  widgetOverlaySql?: Sql;
} = {}) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerInteractionRoutes(
    app, sessions, account,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    deps.paidVotes as PaidSupportVoteStore | undefined,
    deps.paidVoteOverlay as PaidVoteOverlayStore | undefined,
    deps.widgetOverlaySql,
  );
  return app;
}

const sampleTally: PaidVoteTally = {
  schemaVersion: 'v1', votingMode: 'paid',
  options: [{ optionKey: 'a', label: 'A', amountPaise: 300000 }, { optionKey: 'b', label: 'B', amountPaise: 100000 }],
  resolved: false, resolvedOptionKey: null,
};

// --- dashboard: paid-vote-tally --------------------------------------------

test('GET paid-vote-tally returns the money-derived tally for an authenticated caller', async () => {
  const app = await buildTestApp({ paidVotes: { async tally() { return sampleTally; } } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/interactions/${definitionId}/paid-vote-tally`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().tally, sampleTally);
  await app.close();
});

test('GET paid-vote-tally fails closed (503) when no store is wired', async () => {
  const app = await buildTestApp({});
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/interactions/${definitionId}/paid-vote-tally`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 503);
  await app.close();
});

test('GET paid-vote-tally maps a durable store rejection to redacted retryable 503', async () => {
  const app = await buildTestApp({ paidVotes: { async tally() { throw new Error('synthetic database outage'); } } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/interactions/${definitionId}/paid-vote-tally`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'interaction_store_unavailable');
  assert.equal(JSON.stringify(response.json()).includes('database outage'), false);
  await app.close();
});

test('GET paid-vote-tally requires authentication', async () => {
  const app = await buildTestApp({ paidVotes: { async tally() { return sampleTally; } } });
  const response = await app.inject({ method: 'GET', url: `/v1/channels/${channelId}/interactions/${definitionId}/paid-vote-tally` });
  assert.equal(response.statusCode, 401);
  await app.close();
});

// --- overlay: paid votes + the four widgets ---------------------------------

test('overlay paid-votes rejects a request with no bearer token', async () => {
  const app = await buildTestApp({ paidVoteOverlay: { async getPaidVoteTally() { return sampleTally; } } });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/paid-votes/${definitionId}` });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().errorCode, 'overlay_unauthorized');
  await app.close();
});

test('overlay paid-votes returns the tally for a valid bearer token', async () => {
  let seenToken: string | undefined;
  const app = await buildTestApp({ paidVoteOverlay: { async getPaidVoteTally(t) { seenToken = t; return sampleTally; } } });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/paid-votes/${definitionId}`, headers: { authorization: 'Bearer overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().tally, sampleTally);
  assert.equal(seenToken, 'overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  await app.close();
});

test('overlay paid-votes reports an unwired or failed store as retryable 503, never 401, and strips sensitive fields', async () => {
  const url = `/v1/overlay-widgets/${overlayId}/paid-votes/${definitionId}`;
  const noStore = await buildTestApp({});
  const unavailable = await noStore.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().errorCode, 'interaction_store_unavailable');
  assert.equal(unavailable.json().retryable, true);
  await noStore.close();

  const polluted = {
    ...sampleTally,
    channelId, accountId: userId, providerSecret: 'private', refundId: 'refund-private',
    options: [{ ...sampleTally.options[0], paymentId: 'payment-private', instrumentId: 'instrument-private' }],
  } as unknown as PaidVoteTally;
  const app = await buildTestApp({ paidVoteOverlay: { async getPaidVoteTally() { return polluted; } } });
  const response = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', tally: { schemaVersion: 'v1', votingMode: 'paid', options: [{ optionKey: 'a', label: 'A', amountPaise: 300000 }], resolved: false, resolvedOptionKey: null } });
  await app.close();

  const failed = await buildTestApp({ paidVoteOverlay: { async getPaidVoteTally() { throw new Error('synthetic database outage'); } } });
  const failedResponse = await failed.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  assert.equal(failedResponse.statusCode, 503);
  assert.equal(failedResponse.json().errorCode, 'interaction_store_unavailable');
  await failed.close();
});

for (const route of ['recent-tips', 'top-supporters', 'supporter-ticker', 'mega-tip-banner']) {
  test(`overlay ${route} rejects a request with no bearer token, never a 500`, async () => {
    const app = await buildTestApp({ widgetOverlaySql: mockSql([]) });
    const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/${route}` });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().errorCode, 'overlay_unauthorized');
    await app.close();
  });

  test(`overlay ${route} degrades to empty data with no rows, never throws`, async () => {
    const app = await buildTestApp({ widgetOverlaySql: mockSql([]) });
    const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/${route}`, headers: { authorization: 'Bearer overlay-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } });
    assert.equal(response.statusCode, 200);
    await app.close();
  });

  test(`overlay ${route} reports an unwired sql dependency as retryable 503, not 401`, async () => {
    const app = await buildTestApp({});
    const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/${route}`, headers: { authorization: 'Bearer overlay-token-cccccccccccccccccccccccccccccccc' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().errorCode, 'interaction_store_unavailable');
    assert.equal(response.json().retryable, true);
    await app.close();
  });
}

test('each SQL-backed overlay tip widget maps a query failure to a redacted retryable 503', async () => {
  const failingSql = (() => Promise.reject(new Error('synthetic database outage'))) as unknown as Sql;
  for (const route of ['recent-tips', 'top-supporters', 'supporter-ticker', 'mega-tip-banner']) {
    const app = await buildTestApp({ widgetOverlaySql: failingSql });
    const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/${route}`, headers: { authorization: 'Bearer overlay-token-cccccccccccccccccccccccccccccccc' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().errorCode, 'interaction_store_unavailable');
    assert.equal(JSON.stringify(response.json()).includes('database outage'), false);
    await app.close();
  }
});

test('overlay recent-tips shapes rows into the expected tip list (full data state)', async () => {
  const rows = [{ display_name: 'Amit', amount_paise: 300000, message: 'Great stream!', created_at: new Date('2026-09-07T00:00:00.000Z') }];
  const app = await buildTestApp({ widgetOverlaySql: mockSql(rows) });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/recent-tips`, headers: { authorization: 'Bearer overlay-token-dddddddddddddddddddddddddddddddd' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().tips, [{ displayName: 'Amit', amountPaise: 300000, message: 'Great stream!', createdAt: '2026-09-07T00:00:00.000Z' }]);
  await app.close();
});

test('overlay recent-tips with no rows returns an empty array, not null or an error (partial/empty data state)', async () => {
  const app = await buildTestApp({ widgetOverlaySql: mockSql([]) });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/recent-tips`, headers: { authorization: 'Bearer overlay-token-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().tips, []);
  await app.close();
});

test('overlay top-supporters shapes rows into rank/viewerRef/tierLabel, never an amount field', async () => {
  const rows = [{ rank: 1, viewer_ref: 'viewer_abcd1234', tier_label: 'gold' }];
  const app = await buildTestApp({ widgetOverlaySql: mockSql(rows) });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/top-supporters`, headers: { authorization: 'Bearer overlay-token-ffffffffffffffffffffffffffffffff' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.supporters, [{ rank: 1, viewerRef: 'viewer_abcd1234', tierLabel: 'gold' }]);
  assert.equal(JSON.stringify(body).includes('amountPaise'), false);
  await app.close();
});

test('overlay supporter-ticker shapes rows into viewerRef/tierLabel/supportedAt, never an amount field', async () => {
  const rows = [{ viewer_ref: 'viewer_efgh5678', tier_label: 'silver', supported_at: new Date('2026-09-07T01:00:00.000Z') }];
  const app = await buildTestApp({ widgetOverlaySql: mockSql(rows) });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/supporter-ticker`, headers: { authorization: 'Bearer overlay-token-gggggggggggggggggggggggggggggggg' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.entries, [{ viewerRef: 'viewer_efgh5678', tierLabel: 'silver', supportedAt: '2026-09-07T01:00:00.000Z' }]);
  assert.equal(JSON.stringify(body).includes('amountPaise'), false);
  await app.close();
});

test('overlay mega-tip-banner returns null when nothing currently qualifies (empty data state)', async () => {
  const app = await buildTestApp({ widgetOverlaySql: mockSql([]) });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/mega-tip-banner`, headers: { authorization: 'Bearer overlay-token-hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().banner, null);
  await app.close();
});

test('overlay mega-tip-banner returns the single qualifying banner (full data state)', async () => {
  const rows = [{ display_name: 'Chandra', amount_paise: 750000, created_at: new Date('2026-09-07T02:00:00.000Z') }];
  const app = await buildTestApp({ widgetOverlaySql: mockSql(rows) });
  const response = await app.inject({ method: 'GET', url: `/v1/overlay-widgets/${overlayId}/mega-tip-banner`, headers: { authorization: 'Bearer overlay-token-iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().banner, { displayName: 'Chandra', amountPaise: 750000, createdAt: '2026-09-07T02:00:00.000Z' });
  await app.close();
});
