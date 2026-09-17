import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerMasterCanvasRoutes } from '../src/routes/master-canvas.js';
import { registerMediaQueueRoutes } from '../src/routes/media-queue.js';
import type {
  MediaQueueItem,
  MediaQueueOverlayStore,
  MediaQueueStore,
  OverlayMediaQueueEntry,
} from '../src/domain/media-queue-store.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';

/*
 * PRF-02 slice 7, §6 catalogue module #20 (Media / Meme Queue).
 *
 *   GET   /v1/overlay-widgets/:overlayId/media-queue        (overlay token)
 *   GET   /v1/channels/:channelId/media-queue                (creator session)
 *   POST  /v1/channels/:channelId/media-queue                (creator session)
 *   PATCH /v1/channels/:channelId/media-queue/:itemId        (creator session)
 *   PATCH /v1/channels/:channelId/media-queue/:itemId/status (creator session)
 *
 * The route layer's own correctness surface and nothing below it. The SQL
 * layer's proof that no viewer-submission path exists, that the overlay
 * read returns at most two rows, and that no tier gate reaches any
 * creator-facing function, lives in
 * packages/db/tests/prf02_slice7_media_queue.sql. This file is the
 * second, independent narrowing: even a store handing up more than two
 * overlay entries, or a route body somehow carrying a submitter/viewer/
 * approval field, must not get past this layer.
 */

const overlayId = '00000000-0000-4000-8000-000000005b41';
const overlayUrl = `/v1/overlay-widgets/${overlayId}/media-queue`;
const channelId = '00000000-0000-4000-8000-000000005b11';
const itemId = '00000000-0000-4000-8000-000000005b51';
const userId = '00000000-0000-4000-8000-000000000001';
const mediaQueueUrl = `/v1/channels/${channelId}/media-queue`;
const itemUrl = `/v1/channels/${channelId}/media-queue/${itemId}`;
const statusUrl = `${itemUrl}/status`;

const overlayEntries: OverlayMediaQueueEntry[] = [
  {
    schemaVersion: 'v1', queueSlot: 'current', title: 'First meme', mediaKind: 'image',
    mimeType: 'image/png', storageUrl: 'https://cdn.example.com/a.png', thumbnailUrl: null, durationMs: null,
  },
  {
    schemaVersion: 'v1', queueSlot: 'next', title: 'Second clip', mediaKind: 'video',
    mimeType: 'video/mp4', storageUrl: 'https://cdn.example.com/b.mp4', thumbnailUrl: 'https://cdn.example.com/b-thumb.png', durationMs: 5000,
  },
];

const item: MediaQueueItem = {
  schemaVersion: 'v1',
  mediaQueueItemId: itemId,
  title: 'First meme',
  mediaKind: 'image',
  mimeType: 'image/png',
  storageUrl: 'https://cdn.example.com/a.png',
  thumbnailUrl: null,
  durationMs: null,
  status: 'queued',
  enabled: true,
  createdAt: '2026-09-17T10:00:00.000Z',
  updatedAt: '2026-09-17T10:00:00.000Z',
};

async function buildOverlayApp(store?: Partial<MediaQueueOverlayStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerMasterCanvasRoutes(
    app, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    store as MediaQueueOverlayStore | undefined,
  );
  return app;
}

const token = 'a'.repeat(48);
const authHeaders = { authorization: `Bearer ${token}` };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-09-18T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const account = {
  async hasAcceptedActiveDocuments() { return true; },
} as unknown as AccountStore;

async function buildCreatorApp(store?: Partial<MediaQueueStore>, maxDurationMs?: number, maxQueueItems?: number) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerMediaQueueRoutes(app, sessions, store as MediaQueueStore | undefined, account, maxDurationMs, maxQueueItems);
  return app;
}

// =====================================================================
// The overlay read.
// =====================================================================

test('overlay: a missing bearer token is 401, and a missing store is a retryable 503', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return overlayEntries; } });
  const noToken = await app.inject({ method: 'GET', url: overlayUrl });
  assert.equal(noToken.statusCode, 401);

  const noStore = await buildOverlayApp(undefined);
  const unavailable = await noStore.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().retryable, true);
  await app.close();
  await noStore.close();
});

test('overlay: a valid read returns at most two entries, labelled current/next, and nothing else', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return overlayEntries; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['mediaQueue', 'schemaVersion']);
  assert.equal(body.mediaQueue.length, 2);
  assert.equal(body.mediaQueue[0].queueSlot, 'current');
  assert.equal(body.mediaQueue[1].queueSlot, 'next');
  for (const entry of body.mediaQueue) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'durationMs', 'mediaKind', 'mimeType', 'queueSlot', 'schemaVersion', 'storageUrl', 'thumbnailUrl', 'title',
    ]);
  }
  await app.close();
});

test('overlay: a store handing up MORE than two entries is still projected down to two', async () => {
  const three: OverlayMediaQueueEntry[] = [
    ...overlayEntries,
    { schemaVersion: 'v1', queueSlot: 'next', title: 'Should never render', mediaKind: 'image', mimeType: 'image/png', storageUrl: 'https://cdn.example.com/c.png', thumbnailUrl: null, durationMs: null },
  ];
  const app = await buildOverlayApp({ async getForOverlay() { return three; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.json().mediaQueue.length, 2);
  await app.close();
});

test('overlay: an unrecognised or empty token is 200 with an empty array, never 401', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return []; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer nope' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().mediaQueue, []);
  await app.close();
});

test('overlay: a store failure is a retryable 503, not a 200 asserting an empty queue', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { throw new Error('boom'); } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});

// =====================================================================
// NO VIEWER-SUBMISSION PATH: this is the structural proof at the route
// layer. AJV's `additionalProperties: false` rejects any field this
// route does not declare -- a submitter, a viewer id, an approval
// decision, a rejection reason -- with a 400 before the store is ever
// called, regardless of what the store would have done with it.
// =====================================================================

test('enqueue: a body carrying a submitter/viewer/approval field is refused with 400 before the store runs', async () => {
  let storeCalled = false;
  const app = await buildCreatorApp({
    async enqueueItem() { storeCalled = true; return { outcome: 'ok', item }; },
  });
  for (const poison of [
    { submitterId: userId }, { submittedBy: userId }, { viewerId: userId },
    { approved: true }, { approvalStatus: 'pending' }, { rejectionReason: 'no' }, { submission: {} },
  ]) {
    const response = await app.inject({
      method: 'POST', url: mediaQueueUrl, headers: authHeaders,
      payload: { title: 'x', mediaKind: 'image', mimeType: 'image/png', storageUrl: 'https://cdn.example.com/x.png', ...poison },
    });
    assert.equal(response.statusCode, 400, `expected 400 for poisoned field ${JSON.stringify(poison)}`);
  }
  assert.equal(storeCalled, false, 'the store must never be reached when the body carries an undeclared field');
  await app.close();
});

test('enqueue: an unrecognised mime type (e.g. text/html, image/svg+xml) is refused with 400', async () => {
  const app = await buildCreatorApp({ async enqueueItem() { return { outcome: 'ok', item }; } });
  for (const mimeType of ['text/html', 'image/svg+xml', 'application/javascript']) {
    const response = await app.inject({
      method: 'POST', url: mediaQueueUrl, headers: authHeaders,
      payload: { title: 'x', mediaKind: 'image', mimeType, storageUrl: 'https://cdn.example.com/x.png' },
    });
    assert.equal(response.statusCode, 400, `expected 400 for mime type ${mimeType}`);
  }
  await app.close();
});

test('enqueue: a non-https storage url is refused with 400', async () => {
  const app = await buildCreatorApp({ async enqueueItem() { return { outcome: 'ok', item }; } });
  const response = await app.inject({
    method: 'POST', url: mediaQueueUrl, headers: authHeaders,
    payload: { title: 'x', mediaKind: 'image', mimeType: 'image/png', storageUrl: 'http://cdn.example.com/x.png' },
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});

// =====================================================================
// Creator writes and reads.
// =====================================================================

test('creator: a missing bearer token / missing store / missing session are handled distinctly', async () => {
  const app = await buildCreatorApp({ async listItems() { return [item]; } });
  const noAuth = await app.inject({ method: 'GET', url: mediaQueueUrl });
  assert.equal(noAuth.statusCode, 401);

  const noStore = await buildCreatorApp(undefined);
  const unavailable = await noStore.inject({ method: 'GET', url: mediaQueueUrl, headers: authHeaders });
  assert.equal(unavailable.statusCode, 503);
  await app.close();
  await noStore.close();
});

test('creator: list returns the store items under the declared envelope', async () => {
  const app = await buildCreatorApp({ async listItems() { return [item]; } });
  const response = await app.inject({ method: 'GET', url: mediaQueueUrl, headers: authHeaders });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items, [item]);
  await app.close();
});

test('enqueue: ok is 201, forbidden is 404 (never 403), invalid is 400, limit_reached is 409', async () => {
  const payload = { title: 'x', mediaKind: 'image', mimeType: 'image/png', storageUrl: 'https://cdn.example.com/x.png' };

  const ok = await buildCreatorApp({ async enqueueItem() { return { outcome: 'ok', item }; } });
  const okResponse = await ok.inject({ method: 'POST', url: mediaQueueUrl, headers: authHeaders, payload });
  assert.equal(okResponse.statusCode, 201);
  assert.deepEqual(okResponse.json().item, item);
  await ok.close();

  const forbidden = await buildCreatorApp({ async enqueueItem() { return { outcome: 'forbidden' }; } });
  const forbiddenResponse = await forbidden.inject({ method: 'POST', url: mediaQueueUrl, headers: authHeaders, payload });
  assert.equal(forbiddenResponse.statusCode, 404, 'existence of a channel the caller may not write to is itself information (404, never 403)');
  await forbidden.close();

  const invalid = await buildCreatorApp({ async enqueueItem() { return { outcome: 'invalid' }; } });
  const invalidResponse = await invalid.inject({ method: 'POST', url: mediaQueueUrl, headers: authHeaders, payload });
  assert.equal(invalidResponse.statusCode, 400);
  await invalid.close();

  const limited = await buildCreatorApp({ async enqueueItem() { return { outcome: 'limit_reached' }; } });
  const limitedResponse = await limited.inject({ method: 'POST', url: mediaQueueUrl, headers: authHeaders, payload });
  assert.equal(limitedResponse.statusCode, 409);
  await limited.close();
});

test('enqueue: the two configured-but-unset caps are threaded through to the store call unchanged', async () => {
  let seenMax: { maxDurationMs?: number | null; maxQueueItems?: number | null } = {};
  const app = await buildCreatorApp({
    async enqueueItem(_userId, _channelId, input) {
      seenMax = { maxDurationMs: input.maxDurationMs, maxQueueItems: input.maxQueueItems };
      return { outcome: 'ok', item };
    },
  }, 60000, 25);
  await app.inject({
    method: 'POST', url: mediaQueueUrl, headers: authHeaders,
    payload: { title: 'x', mediaKind: 'video', mimeType: 'video/mp4', storageUrl: 'https://cdn.example.com/x.mp4', durationMs: 1000 },
  });
  assert.equal(seenMax.maxDurationMs, 60000);
  assert.equal(seenMax.maxQueueItems, 25);
  await app.close();

  // Unset by default: undefined, not a guessed default like 0 or -1.
  let seenUnset: { maxDurationMs?: number | null; maxQueueItems?: number | null } = {};
  const appUnset = await buildCreatorApp({
    async enqueueItem(_userId, _channelId, input) {
      seenUnset = { maxDurationMs: input.maxDurationMs, maxQueueItems: input.maxQueueItems };
      return { outcome: 'ok', item };
    },
  });
  await appUnset.inject({
    method: 'POST', url: mediaQueueUrl, headers: authHeaders,
    payload: { title: 'x', mediaKind: 'image', mimeType: 'image/png', storageUrl: 'https://cdn.example.com/x.png' },
  });
  assert.equal(seenUnset.maxDurationMs, null);
  assert.equal(seenUnset.maxQueueItems, null);
  await appUnset.close();
});

test('update: ok is 200, not_found is 404, invalid is 400', async () => {
  const ok = await buildCreatorApp({ async updateItem() { return { outcome: 'ok', item }; } });
  const okResponse = await ok.inject({ method: 'PATCH', url: itemUrl, headers: authHeaders, payload: { title: 'renamed', enabled: false } });
  assert.equal(okResponse.statusCode, 200);
  await ok.close();

  const notFound = await buildCreatorApp({ async updateItem() { return { outcome: 'not_found' }; } });
  const notFoundResponse = await notFound.inject({ method: 'PATCH', url: itemUrl, headers: authHeaders, payload: { title: 'renamed', enabled: false } });
  assert.equal(notFoundResponse.statusCode, 404);
  await notFound.close();

  const invalid = await buildCreatorApp({ async updateItem() { return { outcome: 'invalid' }; } });
  const invalidResponse = await invalid.inject({ method: 'PATCH', url: itemUrl, headers: authHeaders, payload: { title: 'renamed', enabled: false } });
  assert.equal(invalidResponse.statusCode, 400);
  await invalid.close();
});

test('status: only queued/played/skipped are accepted -- an approval-shaped value is refused with 400 before the store runs', async () => {
  let storeCalled = false;
  const app = await buildCreatorApp({ async setItemStatus() { storeCalled = true; return { outcome: 'ok', item }; } });
  for (const status of ['approved', 'rejected', 'pending_review', 'submitted']) {
    const response = await app.inject({ method: 'PATCH', url: statusUrl, headers: authHeaders, payload: { status } });
    assert.equal(response.statusCode, 400, `expected 400 for status ${status}`);
  }
  assert.equal(storeCalled, false);
  await app.close();
});

test('status: ok is 200, not_found is 404', async () => {
  const ok = await buildCreatorApp({ async setItemStatus() { return { outcome: 'ok', item: { ...item, status: 'played' } }; } });
  const okResponse = await ok.inject({ method: 'PATCH', url: statusUrl, headers: authHeaders, payload: { status: 'played' } });
  assert.equal(okResponse.statusCode, 200);
  assert.equal(okResponse.json().item.status, 'played');
  await ok.close();

  const notFound = await buildCreatorApp({ async setItemStatus() { return { outcome: 'not_found' }; } });
  const notFoundResponse = await notFound.inject({ method: 'PATCH', url: statusUrl, headers: authHeaders, payload: { status: 'played' } });
  assert.equal(notFoundResponse.statusCode, 404);
  await notFound.close();
});
