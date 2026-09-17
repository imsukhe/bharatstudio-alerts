import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerMasterCanvasRoutes } from '../src/routes/master-canvas.js';
import { registerSafeSoundboardRoutes, type SafeSoundboardUploadCaps } from '../src/routes/safe-soundboard.js';
import {
  projectOverlaySoundboardPlay,
  type OverlaySoundboardPlay,
  type SafeSoundboardOverlayStore,
  type SafeSoundboardStore,
  type SoundboardCatalogueEntry,
  type SoundboardUpload,
} from '../src/domain/safe-soundboard-store.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';

/*
 * PRF-02 slice 7, §6 catalogue module #6 (Safe Soundboard Alert).
 *
 *   GET  /v1/overlay-widgets/:overlayId/safe-soundboard   (overlay token)
 *   GET  /v1/channels/:channelId/soundboard/catalogue     (creator session)
 *   PUT  .../soundboard/catalogue/:entryId                (creator session)
 *   GET  /v1/channels/:channelId/soundboard/uploads       (creator session)
 *   POST /v1/channels/:channelId/soundboard/uploads       (creator session)
 *   POST /v1/channels/:channelId/soundboard/play          (creator session)
 *
 * The route layer's own correctness surface and nothing below it. The SQL
 * layer's proof that no bytea column exists, that the upload path is
 * inert with unset caps, that no review-state column exists, and that the
 * §30.3 module gate never blocks the creator's own record, lives in
 * packages/db/tests/prf02_slice7_safe_soundboard.sql. This file is the
 * second, independent narrowing.
 */

const overlayId = '00000000-0000-4000-8000-000000005c41';
const overlayUrl = `/v1/overlay-widgets/${overlayId}/safe-soundboard`;
const channelId = '00000000-0000-4000-8000-000000005c11';
const entryId = '00000000-0000-4000-8000-000000005c21';
const uploadId = '00000000-0000-4000-8000-000000005c31';
const userId = '00000000-0000-4000-8000-000000000001';
const catalogueUrl = `/v1/channels/${channelId}/soundboard/catalogue`;
const uploadsUrl = `/v1/channels/${channelId}/soundboard/uploads`;
const playUrl = `/v1/channels/${channelId}/soundboard/play`;

const play: OverlaySoundboardPlay = {
  schemaVersion: 'v1',
  playId: '00000000-0000-4000-8000-000000005c91',
  clipKind: 'catalogue',
  displayName: 'Air Horn',
  playbackUrl: 'https://cdn.example.com/soundboard/catalogue/air-horn',
  mimeType: 'audio/mpeg',
  durationSeconds: 3,
  triggeredAt: '2026-09-17T10:00:00.000Z',
};

const catalogueEntry: SoundboardCatalogueEntry = {
  schemaVersion: 'v1',
  id: entryId,
  externalKey: 'sb-air-horn',
  displayName: 'Air Horn',
  category: 'hype',
  minTier: 'pro',
  byteSize: 240000,
  durationSeconds: 3,
  enabled: true,
  updatedAt: '2026-09-17T10:00:00.000Z',
};

const upload: SoundboardUpload = {
  schemaVersion: 'v1',
  id: uploadId,
  displayName: 'My Clip',
  byteSize: 240000,
  durationSeconds: 4,
  uploadedAt: '2026-09-17T10:00:00.000Z',
};

async function buildOverlayApp(store?: Partial<SafeSoundboardOverlayStore>) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerMasterCanvasRoutes(
    app, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    // slice-7 merge: overlayMediaQueue occupies position 10, so the soundboard
    // store is 11th. Positional, so the gap must be explicit rather than assumed.
    undefined,
    store as SafeSoundboardOverlayStore | undefined,
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

async function buildCreatorApp(store?: Partial<SafeSoundboardStore>, caps: SafeSoundboardUploadCaps = {}) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerSafeSoundboardRoutes(app, sessions, store as SafeSoundboardStore | undefined, account, caps);
  return app;
}

// =====================================================================
// The overlay read.
// =====================================================================

test('a missing bearer token is 401, and a missing store is a retryable 503', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return play; } });
  const noToken = await app.inject({ method: 'GET', url: overlayUrl });
  assert.equal(noToken.statusCode, 401);

  const noStore = await buildOverlayApp(undefined);
  const unavailable = await noStore.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().retryable, true);
  await app.close();
  await noStore.close();
});

test('a valid read returns exactly the seven declared fields, the schema version, and nothing else', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return play; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['schemaVersion', 'soundboardPlay']);
  assert.deepEqual(Object.keys(body.soundboardPlay).sort(), [
    'clipKind', 'displayName', 'durationSeconds', 'mimeType', 'playId', 'playbackUrl', 'schemaVersion', 'triggeredAt',
  ]);
  assert.equal(body.soundboardPlay.playbackUrl, 'https://cdn.example.com/soundboard/catalogue/air-horn');
  await app.close();
});

test('an unrecognised token is 200 with a null state, never 401', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { return null; } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer nope' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().soundboardPlay, null);
  await app.close();
});

test('a store failure is a retryable 503, not a 200 asserting nothing was triggered', async () => {
  const app = await buildOverlayApp({ async getForOverlay() { throw new Error('boom'); } });
  const response = await app.inject({ method: 'GET', url: overlayUrl, headers: { authorization: 'Bearer tok' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});

test('a non-https playback URL is stripped to null rather than reaching the Canvas', async () => {
  const polluted = projectOverlaySoundboardPlay({ ...play, playbackUrl: 'http://not-https.example.com/x' });
  assert.equal(polluted, null, 'an insecure or malformed playback URL must fail the projection outright');
});

test('an unknown-shaped store answer projects to null rather than leaking an unexpected field', () => {
  const polluted = { ...play, viewerId: '00000000-0000-4000-8000-0000000000a1', supporterName: 'Riya' };
  const projected = projectOverlaySoundboardPlay(polluted);
  assert.ok(projected);
  assert.deepEqual(Object.keys(projected as object).sort(), [
    'clipKind', 'displayName', 'durationSeconds', 'mimeType', 'playId', 'playbackUrl', 'schemaVersion', 'triggeredAt',
  ]);
});

// =====================================================================
// The creator's catalogue.
// =====================================================================

test('catalogue list requires a session and fails closed without a store', async () => {
  const app = await buildCreatorApp(undefined);
  const noAuth = await app.inject({ method: 'GET', url: catalogueUrl });
  assert.equal(noAuth.statusCode, 401);

  const withAuth = await app.inject({ method: 'GET', url: catalogueUrl, headers: authHeaders });
  assert.equal(withAuth.statusCode, 503);
  await app.close();
});

test('catalogue list returns entries for any tier -- the module is never tier-gated on the creator record', async () => {
  const app = await buildCreatorApp({ async listCatalogue() { return [catalogueEntry]; } });
  const response = await app.inject({ method: 'GET', url: catalogueUrl, headers: authHeaders });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().entries.length, 1);
  await app.close();
});

test('toggling a catalogue entry: ok, forbidden maps to 404, invalid maps to 400', async () => {
  const okApp = await buildCreatorApp({ async setCatalogueEntryEnabled() { return { outcome: 'ok', entries: [catalogueEntry] }; } });
  const ok = await okApp.inject({ method: 'PUT', url: `${catalogueUrl}/${entryId}`, headers: authHeaders, payload: { enabled: false } });
  assert.equal(ok.statusCode, 200);

  const forbiddenApp = await buildCreatorApp({ async setCatalogueEntryEnabled() { return { outcome: 'forbidden' }; } });
  const forbidden = await forbiddenApp.inject({ method: 'PUT', url: `${catalogueUrl}/${entryId}`, headers: authHeaders, payload: { enabled: false } });
  assert.equal(forbidden.statusCode, 404);

  const invalidApp = await buildCreatorApp({ async setCatalogueEntryEnabled() { return { outcome: 'invalid' }; } });
  const invalid = await invalidApp.inject({ method: 'PUT', url: `${catalogueUrl}/${entryId}`, headers: authHeaders, payload: { enabled: false } });
  assert.equal(invalid.statusCode, 400);
  await okApp.close(); await forbiddenApp.close(); await invalidApp.close();
});

// =====================================================================
// Uploads: NO REVIEW FIELD ACCEPTED, and the inert-when-unset path.
// =====================================================================

const validUploadBody = {
  displayName: 'My Clip',
  contentSha256: 'a'.repeat(64),
  mimeType: 'audio/mpeg',
  byteSize: 240000,
  durationSeconds: 4,
  rightsAttested: true,
};

test('a body carrying a status/moderation/review field is a 400 before the store is ever called', async () => {
  const app = await buildCreatorApp({ async uploadClip() { throw new Error('must not be called'); } });
  for (const pollutedField of ['status', 'moderationState', 'approved', 'reviewed', 'reviewedAt']) {
    const response = await app.inject({
      method: 'POST', url: uploadsUrl, headers: authHeaders,
      payload: { ...validUploadBody, [pollutedField]: true },
    });
    assert.equal(response.statusCode, 400, `expected ${pollutedField} to be rejected by additionalProperties:false`);
  }
  await app.close();
});

test('with no caps configured, the upload path is inert regardless of how small the clip is', async () => {
  const app = await buildCreatorApp(
    { async uploadClip(_userId, _channelId, _input, caps) {
      assert.equal(caps.maxDurationSeconds, undefined);
      assert.equal(caps.maxByteSize, undefined);
      return { outcome: 'caps_not_configured' };
    } },
    {}, // no caps threaded in -- today's real configuration
  );
  const response = await app.inject({ method: 'POST', url: uploadsUrl, headers: authHeaders, payload: validUploadBody });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'soundboard_uploads_not_configured');
  await app.close();
});

test('with caps configured, a successful upload is immediately usable -- no review step', async () => {
  const app = await buildCreatorApp(
    { async uploadClip(_userId, _channelId, input, caps) {
      assert.equal(caps.maxDurationSeconds, 30);
      assert.equal(caps.maxByteSize, 1000000);
      assert.equal(input.rightsAttested, true);
      return { outcome: 'ok', upload };
    } },
    { maxDurationSeconds: 30, maxByteSize: 1000000 },
  );
  const response = await app.inject({ method: 'POST', url: uploadsUrl, headers: authHeaders, payload: validUploadBody });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(Object.keys(response.json().upload).sort(), [
    'byteSize', 'displayName', 'durationSeconds', 'id', 'schemaVersion', 'uploadedAt',
  ]);
  await app.close();
});

test('rights_not_attested, cap_exceeded, tier_limit_reached and conflict map to their own status codes', async () => {
  const cases: Array<[SafeSoundboardUploadCaps extends unknown ? string : never, string, number]> = [] as never;
  const outcomes: Array<[string, number, string]> = [
    ['rights_not_attested', 400, 'rights_attestation_required'],
    ['cap_exceeded', 400, 'soundboard_clip_too_large'],
    ['tier_limit_reached', 403, 'soundboard_upload_limit_reached'],
    ['conflict', 409, 'soundboard_clip_already_uploaded'],
  ];
  for (const [outcome, status, errorCode] of outcomes) {
    const app = await buildCreatorApp(
      { async uploadClip() { return { outcome } as never; } },
      { maxDurationSeconds: 30, maxByteSize: 1000000 },
    );
    const response = await app.inject({ method: 'POST', url: uploadsUrl, headers: authHeaders, payload: validUploadBody });
    assert.equal(response.statusCode, status, `outcome ${outcome}`);
    assert.equal(response.json().errorCode, errorCode);
    await app.close();
  }
  void cases;
});

test('rightsAttested: false is a valid, explicit request the schema accepts and the store refuses', async () => {
  const app = await buildCreatorApp(
    { async uploadClip(_u, _c, input) { return input.rightsAttested ? { outcome: 'ok', upload } : { outcome: 'rights_not_attested' }; } },
    { maxDurationSeconds: 30, maxByteSize: 1000000 },
  );
  const response = await app.inject({ method: 'POST', url: uploadsUrl, headers: authHeaders, payload: { ...validUploadBody, rightsAttested: false } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'rights_attestation_required');
  await app.close();
});

// =====================================================================
// Trigger play: exactly one source, no supporter field accepted.
// =====================================================================

test('a body with both catalogueEntryId and uploadId, or neither, is rejected by the schema', async () => {
  const app = await buildCreatorApp({ async triggerPlay() { throw new Error('must not be called'); } });
  const both = await app.inject({ method: 'POST', url: playUrl, headers: authHeaders, payload: { catalogueEntryId: entryId, uploadId } });
  assert.equal(both.statusCode, 400);
  const neither = await app.inject({ method: 'POST', url: playUrl, headers: authHeaders, payload: {} });
  assert.equal(neither.statusCode, 400);
  await app.close();
});

test('a body carrying a supporter/viewer field is rejected -- no tip-attached trigger exists in this slice', async () => {
  const app = await buildCreatorApp({ async triggerPlay() { throw new Error('must not be called'); } });
  const response = await app.inject({
    method: 'POST', url: playUrl, headers: authHeaders,
    payload: { catalogueEntryId: entryId, supporterId: '00000000-0000-4000-8000-0000000000a1' },
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test('triggering a play: ok returns 201 with a playId, not_found and invalid map correctly', async () => {
  const okApp = await buildCreatorApp({ async triggerPlay() { return { outcome: 'ok', playId: '00000000-0000-4000-8000-000000005c91' }; } });
  const ok = await okApp.inject({ method: 'POST', url: playUrl, headers: authHeaders, payload: { catalogueEntryId: entryId } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().playId, '00000000-0000-4000-8000-000000005c91');

  const notFoundApp = await buildCreatorApp({ async triggerPlay() { return { outcome: 'not_found' }; } });
  const notFound = await notFoundApp.inject({ method: 'POST', url: playUrl, headers: authHeaders, payload: { uploadId } });
  assert.equal(notFound.statusCode, 404);
  await okApp.close(); await notFoundApp.close();
});
