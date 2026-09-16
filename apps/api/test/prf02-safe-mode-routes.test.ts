import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestFastify } from './create-test-fastify.js';
import { installAuthState } from '../src/auth/pre-handler.js';
import { registerSafeModeRoutes } from '../src/routes/safe-mode.js';
import type { SafeModeStore } from '../src/domain/safe-mode-store.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';

/*
 * PRF-02, §6 module #12: SAFE MODE -- the creator's own read and write.
 * Handler-level cases for
 *   GET /v1/channels/:channelId/safe-mode
 *   PUT /v1/channels/:channelId/safe-mode
 *
 * Authority: bharatstudio-requirements/reviews/
 * 2026-09-16-prf-02-slice-6-owner-decisions.md decision 3.
 *
 * THE CASE THAT CARRIES THE OWNER'S CONSTRAINT IS SMR.4. Safe mode is
 * NEVER automatic -- no spike detection, no rejection-rate heuristic, no
 * signal of any kind engages it. The route's body schema is where that
 * is enforced on the wire: a request carrying a threshold, a window, a
 * duration or a trigger must be a 400 BEFORE the store is called, so a
 * client cannot introduce a knob the product deliberately does not have.
 *
 * The SQL layer's own proof that the role gate and the never-automatic
 * constraint hold lives in packages/db/tests/prf02_safe_mode.sql. This
 * file is the route boundary, and nothing below it.
 */

const channelId = '00000000-0000-4000-8000-000000005a11';
const url = `/v1/channels/${channelId}/safe-mode`;
const userId = '00000000-0000-4000-8000-000000000001';

// The session/terms chain is exercised by its own suites; this file
// stubs it exactly as prf02-stream-mission-routes.test.ts does, so its
// cases are about safe mode rather than about auth plumbing.
// `installAuthState` is still installed, so a request with no session
// takes the real unauthenticated path.
const token = 'a'.repeat(48);

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(t) { return t === token ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-09-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

const account = {
  async hasAcceptedActiveDocuments() { return true; },
} as unknown as AccountStore;

async function buildTestApp(store?: Partial<SafeModeStore>, authed = true) {
  const app = createTestFastify();
  app.addHook('onRequest', async (request) => installAuthState(request));
  await registerSafeModeRoutes(
    app,
    authed ? sessions : undefined,
    store as SafeModeStore | undefined,
    authed ? account : undefined,
  );
  return app;
}

const authHeaders = { authorization: `Bearer ${token}` };

function okStore(initial: boolean) {
  let enabled = initial;
  const calls: boolean[] = [];
  return {
    calls,
    store: {
      async get() { return { outcome: 'ok' as const, safeMode: { schemaVersion: 'v1' as const, enabled } }; },
      async set(_userId: string, _channelId: string, value: boolean) {
        calls.push(value);
        enabled = value;
        return { outcome: 'ok' as const, safeMode: { schemaVersion: 'v1' as const, enabled } };
      },
    } satisfies SafeModeStore,
  };
}

// --- SMR.1: no session --------------------------------------------------

test('safe mode: an unauthenticated read and write are both rejected', async () => {
  const app = await buildTestApp(okStore(false).store, false);
  for (const method of ['GET', 'PUT'] as const) {
    const response = await app.inject({ method, url, payload: method === 'PUT' ? { enabled: true } : undefined });
    assert.notEqual(response.statusCode, 200, `${method} must not succeed without a session`);
  }
  await app.close();
});

// --- SMR.2 / SMR.3: the ordinary read and write --------------------------

test('safe mode: the read returns exactly { schemaVersion, safeMode: { schemaVersion, enabled } }', async () => {
  const app = await buildTestApp(okStore(true).store);
  const response = await app.inject({ method: 'GET', url, headers: authHeaders });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: 'v1', safeMode: { schemaVersion: 'v1', enabled: true } });
  await app.close();
});

test('safe mode: turning it on and off is one idempotent path that returns the new state', async () => {
  const { store, calls } = okStore(false);
  const app = await buildTestApp(store);

  const on = await app.inject({ method: 'PUT', url, headers: authHeaders, payload: { enabled: true } });
  assert.equal(on.statusCode, 200, 'a change is a 200, not a 201 -- nothing is created, a channel already had a safe-mode state');
  assert.deepEqual(on.json().safeMode, { schemaVersion: 'v1', enabled: true });

  // Same request again: still on, and still a 200. The body carries the
  // VALUE, not a toggle, so a stale tab cannot invert the switch.
  const again = await app.inject({ method: 'PUT', url, headers: authHeaders, payload: { enabled: true } });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json().safeMode, { schemaVersion: 'v1', enabled: true });

  const off = await app.inject({ method: 'PUT', url, headers: authHeaders, payload: { enabled: false } });
  assert.equal(off.statusCode, 200);
  assert.deepEqual(off.json().safeMode, { schemaVersion: 'v1', enabled: false });

  assert.deepEqual(calls, [true, true, false], 'the route forwards the value it was given, never a computed toggle');
  await app.close();
});

// --- SMR.4: SAFE MODE HAS NO KNOBS, and the schema is where that holds ---

test('safe mode: a body carrying any automatic-engagement field is a 400 before the store is ever called', async () => {
  // The owner's decision is that safe mode is never automatic. Every
  // field below is machinery for an automatic trigger; none of them
  // exists in this product, and the request must fail at the schema
  // layer rather than being silently stripped and quietly accepted.
  const knobs: Record<string, unknown>[] = [
    { enabled: true, threshold: 10 },
    { enabled: true, windowSeconds: 60 },
    { enabled: true, rateLimitPerMinute: 30 },
    { enabled: true, auto: true },
    { enabled: true, triggeredBy: 'spike' },
    { enabled: true, expiresAt: '2026-09-16T00:00:00Z' },
    { enabled: true, durationSeconds: 900 },
    { enabled: true, reason: 'a spike of alerts' },
  ];
  let storeCalls = 0;
  const app = await buildTestApp({
    async get() { return { outcome: 'ok', safeMode: { schemaVersion: 'v1', enabled: false } }; },
    async set() { storeCalls += 1; return { outcome: 'ok', safeMode: { schemaVersion: 'v1', enabled: true } }; },
  });

  for (const payload of knobs) {
    const response = await app.inject({ method: 'PUT', url, headers: authHeaders, payload });
    assert.equal(response.statusCode, 400, `${JSON.stringify(payload)} must be refused -- safe mode is never automatic and has no such control`);
  }
  assert.equal(storeCalls, 0, 'none of those requests may reach the store at all');
  await app.close();
});

// --- SMR.5: the value must be a real boolean ----------------------------

test('safe mode: anything that is not a real boolean is a 400 — nothing is coerced into a switch position', async () => {
  // THIS CASE EXISTS BECAUSE THE FIRST VERSION OF THIS ROUTE FAILED IT.
  // With the API's normal `type: 'boolean'` declaration and Fastify's
  // default AJV `coerceTypes`, `enabled: null` was MEASURED to coerce to
  // `false` and return 200 -- silently turning safe mode OFF for an
  // uninitialised form field, releasing a channel's alert flow onto a
  // live broadcast that nobody asked to release. The schema now declares
  // the allowed VALUES rather than a type, which removes coercion
  // entirely.
  //
  // `null` is the one that matters; the rest are here so the guarantee
  // is "only true and false", not "null plus whatever we remembered".
  const { store, calls } = okStore(false);
  const app = await buildTestApp(store);
  for (const payload of [
    {},
    { enabled: null },
    { enabled: 'true' },
    { enabled: 'false' },
    { enabled: 1 },
    { enabled: 0 },
    { enabled: 'on' },
    { enabled: 'yes' },
    { enabled: '0' },
    { enabled: 2 },
    { enabled: {} },
    { enabled: [] },
  ]) {
    const response = await app.inject({ method: 'PUT', url, headers: authHeaders, payload });
    assert.equal(response.statusCode, 400, `${JSON.stringify(payload)} must be refused, never coerced into a switch position`);
  }
  assert.deepEqual(calls, [], 'not one of those may reach the store');

  // And the two real values still work.
  for (const [payload, expected] of [[{ enabled: true }, true], [{ enabled: false }, false]] as const) {
    const response = await app.inject({ method: 'PUT', url, headers: authHeaders, payload });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().safeMode, { schemaVersion: 'v1', enabled: expected });
  }
  assert.deepEqual(calls, [true, false]);
  for (const seen of calls) assert.equal(typeof seen, 'boolean', 'the store only ever sees a real boolean');
  await app.close();
});

// --- SMR.6: a caller without the role gets 404, never 403 ----------------

test('safe mode: a caller who may not see the channel gets 404 on both the read and the write, never 403', async () => {
  const app = await buildTestApp({
    async get() { return { outcome: 'not_found' }; },
    async set() { return { outcome: 'not_found' }; },
  });

  const read = await app.inject({ method: 'GET', url, headers: authHeaders });
  assert.equal(read.statusCode, 404);
  assert.equal(read.json().errorCode, 'not_found');

  const write = await app.inject({ method: 'PUT', url, headers: authHeaders, payload: { enabled: true } });
  assert.equal(write.statusCode, 404);
  assert.equal(write.json().errorCode, 'not_found');
  await app.close();
});

// --- SMR.7 / SMR.8: fail closed, retryable, leak nothing -----------------

test('safe mode: an unwired store is a retryable 503, never a 200 claiming safe mode is off', async () => {
  // Reporting "off" when the answer is unknown would tell a creator
  // their alerts are flowing when nothing has checked. That is the worst
  // possible wrong answer on this surface, so it is not one this route
  // can give.
  const app = await buildTestApp(undefined);
  for (const [method, payload] of [['GET', undefined], ['PUT', { enabled: true }]] as const) {
    const response = await app.inject({ method, url, headers: authHeaders, payload });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().errorCode, 'safe_mode_store_unavailable');
    assert.equal(response.json().retryable, true);
    assert.equal(typeof response.json().traceId, 'string');
  }
  await app.close();
});

test('safe mode: a throwing store is a 503 and its message never reaches the body', async () => {
  const app = await buildTestApp({
    async get() { throw new Error('synthetic database outage'); },
    async set() { throw new Error('synthetic database outage'); },
  });
  for (const [method, payload] of [['GET', undefined], ['PUT', { enabled: false }]] as const) {
    const response = await app.inject({ method, url, headers: authHeaders, payload });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().errorCode, 'safe_mode_store_unavailable');
    assert.equal(JSON.stringify(response.json()).includes('database outage'), false);
  }
  await app.close();
});

// --- The channel id is validated, and the response carries no tier -------

test('safe mode: a malformed channel id is a 400, and no response carries a tier or a queue flag', async () => {
  const app = await buildTestApp(okStore(true).store);

  const malformed = await app.inject({ method: 'GET', url: '/v1/channels/not-a-uuid/safe-mode', headers: authHeaders });
  assert.equal(malformed.statusCode, 400);

  // §12.6: a durable creator record is never tier-gated, and this
  // response says nothing about tier. It also says nothing about
  // alert_queues.is_paused, which is a different thing (owner decision,
  // 2026-09-16).
  const read = await app.inject({ method: 'GET', url, headers: authHeaders });
  const body = JSON.stringify(read.json());
  for (const forbidden of ['tier', 'free', 'pro', 'creator', 'studio', 'isPaused', 'paused', 'threshold', 'window']) {
    assert.equal(body.toLowerCase().includes(forbidden.toLowerCase()), false, `${forbidden} must not appear in a safe-mode response`);
  }
  await app.close();
});
