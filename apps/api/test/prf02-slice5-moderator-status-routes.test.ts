import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerMasterCanvasRoutes } from '../src/routes/master-canvas.js';
import {
  projectModeratorStatus,
  type ModeratorStatus,
  type ModeratorStatusOverlayStore,
} from '../src/domain/moderator-status-store.js';

/*
 * PRF-02 slice 5, §6 module #12 (Moderator Status Card) -- HELD HALF
 * ONLY. Handler-level cases for
 * GET /v1/overlay-widgets/:overlayId/moderator-status.
 *
 * The route's own correctness surface, and nothing below it: does it
 * require a bearer token; does it forward the token it was given
 * untouched; does it fail closed as a retryable 503 rather than a 500 or
 * a 401 when the store is unwired or throws; and -- the case that
 * carries this slice's whole point -- does it narrow whatever the store
 * hands up to the held count and nothing else.
 *
 * The SQL layer's own proof that the query CANNOT return anything else
 * lives in packages/db/tests/prf02_slice5_moderator_status.sql. This file
 * is the second, independent narrowing: even a store handing up private
 * fields must not get them past the route.
 */

const overlayId = '00000000-0000-4000-8000-000000005531';
const url = `/v1/overlay-widgets/${overlayId}/moderator-status`;

async function buildTestApp(store?: Partial<ModeratorStatusOverlayStore>) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerMasterCanvasRoutes(
    app,
    undefined,
    undefined,
    undefined,
    undefined,
    store as ModeratorStatusOverlayStore | undefined,
  );
  return app;
}

const heldThree: ModeratorStatus = { schemaVersion: 'v1', heldCount: 3 };

// --- S5.7: no bearer token, and malformed ones ----------------------------

test('overlay moderator-status rejects a request with no bearer token', async () => {
  const app = await buildTestApp({ async getForOverlay() { return heldThree; } });
  const response = await app.inject({ method: 'GET', url });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().errorCode, 'overlay_unauthorized');
  assert.equal(typeof response.json().traceId, 'string');
  await app.close();
});

test('overlay moderator-status rejects a malformed authorization header, never a 500', async () => {
  const app = await buildTestApp({ async getForOverlay() { return heldThree; } });
  for (const header of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer   ', 'overlay-token-only']) {
    const response = await app.inject({ method: 'GET', url, headers: { authorization: header } });
    assert.equal(response.statusCode, 401, `header ${JSON.stringify(header)} must be rejected`);
    assert.equal(response.json().errorCode, 'overlay_unauthorized');
  }
  await app.close();
});

// --- S5.8: the exact token reaches the store ------------------------------

test('overlay moderator-status forwards the exact token to the store and returns its answer', async () => {
  let seenToken: string | undefined;
  let seenOverlayId: string | undefined;
  const app = await buildTestApp({
    async getForOverlay(token, id) { seenToken = token; seenOverlayId = id; return heldThree; },
  });
  const response = await app.inject({
    method: 'GET', url, headers: { authorization: 'Bearer overlay-token-mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', moderatorStatus: { schemaVersion: 'v1', heldCount: 3 } });
  assert.equal(seenToken, 'overlay-token-mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm');
  assert.equal(seenOverlayId, overlayId);
  await app.close();
});

// --- S5.2/S5.9: zero held is a real answer; unrecognised is null ----------

test('overlay moderator-status: a valid session with nothing held answers 200 with heldCount 0, NOT null', async () => {
  // This distinction is load-bearing for the renderer: a real zero hides
  // the card as "nothing is stuck", whereas null means the read did not
  // answer at all. Collapsing the two would make the Canvas unable to
  // tell a quiet queue from a broken read.
  const app = await buildTestApp({ async getForOverlay() { return { schemaVersion: 'v1', heldCount: 0 } as ModeratorStatus; } });
  const response = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().moderatorStatus, { schemaVersion: 'v1', heldCount: 0 });
  await app.close();
});

test('overlay moderator-status: a token the store does not recognise yields null, never another session\'s count', async () => {
  const recognised = 'overlay-token-oooooooooooooooooooooooooooooooo';
  const app = await buildTestApp({
    async getForOverlay(token) { return token === recognised ? heldThree : null; },
  });
  const foreign = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-pppppppppppppppppppppppppppppppp' } });
  assert.equal(foreign.statusCode, 200);
  assert.equal(foreign.json().moderatorStatus, null);
  const good = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${recognised}` } });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(good.json().moderatorStatus, { schemaVersion: 'v1', heldCount: 3 });
  await app.close();
});

// --- S5.10: fail closed, retryable, and leak nothing ----------------------

test('overlay moderator-status reports an unwired or failed store as a retryable 503, never a 500 or 401', async () => {
  const unwired = await buildTestApp();
  const unavailable = await unwired.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().errorCode, 'master_canvas_store_unavailable');
  assert.equal(unavailable.json().retryable, true);
  await unwired.close();

  const failing = await buildTestApp({ async getForOverlay() { throw new Error('synthetic database outage'); } });
  const failed = await failing.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' } });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().errorCode, 'master_canvas_store_unavailable');
  assert.equal(failed.json().retryable, true);
  assert.equal(JSON.stringify(failed.json()).includes('database outage'), false, 'an internal error message must never reach an overlay browser source');
  await failing.close();
});

// --- S5.11: THE PRIVACY NARROWING, at the route boundary ------------------

test('overlay moderator-status strips every field the store hands up beyond the count (§6: never private content)', async () => {
  // A deliberately polluted store answer. The SQL function cannot
  // actually produce any of this -- its returned column set is asserted
  // to be exactly {held_count} in
  // packages/db/tests/prf02_slice5_moderator_status.sql -- so this case
  // exists precisely because the guarantee must not depend on ONE layer
  // holding. Two independent narrowings, not one.
  const polluted = {
    schemaVersion: 'v1',
    heldCount: 4,
    supporterName: 'Riya',
    message: 'a private supporter message',
    amountPaise: 300000,
    deliveryId: '00000000-0000-4000-8000-000000005561',
    eventId: '00000000-0000-4000-8000-000000005541',
    queueId: '00000000-0000-4000-8000-000000005521',
    channelId: '00000000-0000-4000-8000-000000005511',
    viewerIdentityId: '00000000-0000-4000-8000-0000000000a1',
    // Safe mode is NOT built (owner decision, 2026-09-16). Even if a
    // store invented one, it must not reach an overlay under any label.
    safeMode: true,
    isPaused: true,
  } as unknown as ModeratorStatus;

  const app = await buildTestApp({ async getForOverlay() { return polluted; } });
  const response = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', moderatorStatus: { schemaVersion: 'v1', heldCount: 4 } });

  const body = JSON.stringify(response.json());
  for (const forbidden of ['Riya', 'private supporter message', '300000', '5561', '5541', '5521', '5511', '00a1', 'safeMode', 'isPaused']) {
    assert.equal(body.includes(forbidden), false, `${forbidden} must never appear in an overlay moderator-status response`);
  }
  await app.close();
});

// --- S5.12: a nonsense count is no answer, never a rendered figure --------

test('overlay moderator-status: a negative, fractional or non-numeric count is projected to null rather than rendered', async () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3' as unknown as number, null as unknown as number]) {
    const app = await buildTestApp({ async getForOverlay() { return { schemaVersion: 'v1', heldCount: bad } as ModeratorStatus; } });
    const response = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer overlay-token-ssssssssssssssssssssssssssssssss' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().moderatorStatus, null, `heldCount ${String(bad)} must not be rendered`);
    await app.close();
  }
});

// --- projectModeratorStatus, directly -------------------------------------

test('projectModeratorStatus keeps only schemaVersion and heldCount, and rejects an absent or invalid count', async () => {
  assert.equal(projectModeratorStatus(null), null);
  assert.deepEqual(projectModeratorStatus({ schemaVersion: 'v1', heldCount: 0 }), { schemaVersion: 'v1', heldCount: 0 });
  assert.deepEqual(projectModeratorStatus({ schemaVersion: 'v1', heldCount: 12 }), { schemaVersion: 'v1', heldCount: 12 });
  assert.equal(projectModeratorStatus({ schemaVersion: 'v1', heldCount: -1 }), null);
  assert.equal(projectModeratorStatus({ schemaVersion: 'v1', heldCount: 0.5 }), null);

  const projected = projectModeratorStatus({ schemaVersion: 'v1', heldCount: 2, message: 'private' } as unknown as ModeratorStatus);
  assert.deepEqual(Object.keys(projected ?? {}), ['schemaVersion', 'heldCount'], 'the projection must emit exactly two keys');
});

// --- The type itself carries no safe-mode field ---------------------------

test('ModeratorStatus has no safe-mode/paused field of any kind — a compile-time check, not a comment', async () => {
  // Safe mode is NOT the queue-paused flag (owner decision, 2026-09-16);
  // it is a separate moderation control that does not exist in the
  // schema and needs its own record and decision. If a field for it is
  // ever added to ModeratorStatus, this assignment stops compiling and
  // the suite fails to run at all.
  type HasKey<K extends string> = K extends keyof ModeratorStatus ? true : false;
  const safeModeAbsent: HasKey<'safeMode'> = false;
  const isPausedAbsent: HasKey<'isPaused'> = false;
  const pausedAbsent: HasKey<'paused'> = false;
  assert.equal(safeModeAbsent, false);
  assert.equal(isPausedAbsent, false);
  assert.equal(pausedAbsent, false);

  // And exactly two keys exist on the shape, so nothing private can be
  // carried alongside the count either.
  const sample: ModeratorStatus = { schemaVersion: 'v1', heldCount: 1 };
  assert.deepEqual(Object.keys(sample), ['schemaVersion', 'heldCount']);
});
