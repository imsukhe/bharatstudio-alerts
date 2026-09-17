import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
// ajv 8 ships CommonJS with `export =`, so under module: NodeNext the default
// import is the module namespace rather than the constructor. contracts/*.mjs
// get away with the plain import because .mjs files are never typechecked;
// this file is, so it takes ajv's documented ESM interop form instead.
import _Ajv2020 from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AlertStore, CompanionAction } from '../src/domain/alert-store.js';

// Root cause this file closes (see contracts/runtime-route-inventory.mjs and
// contracts/test-openapi-validator.mjs): neither existing contract script
// reads a schema at all -- one compares method+path only, the other checks
// document well-formedness only. Nothing has ever validated a real Companion
// response body against the schema published in contracts/openapi/v1.yaml.
// This file loads that document directly (no hand-copied JSON Schema, so it
// cannot silently drift from what ships) and asserts real app.inject bodies
// against it, plus a mutation proof (last test) that the check actually
// catches a field-level regression rather than trivially passing everything.

const here = path.dirname(fileURLToPath(import.meta.url));
const openApiFile = path.join(here, '..', '..', '..', 'contracts', 'openapi', 'v1.yaml');

function pointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new Error(`External or malformed $ref is not allowed: ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value: unknown, part) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined), root);
}

// Fully resolves every local $ref in `node` against `root`, so the schema
// handed to ajv is self-contained and matches exactly what a client
// generated from the published document would see.
function dereference(root: unknown, node: unknown, seen: readonly unknown[] = []): unknown {
  if (Array.isArray(node)) return node.map((item) => dereference(root, item, seen));
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === 'string') {
      const resolved = pointer(root, obj.$ref);
      if (resolved === undefined) throw new Error(`Unresolved $ref ${obj.$ref}`);
      if (seen.includes(resolved)) throw new Error(`Circular $ref ${obj.$ref}`);
      return dereference(root, resolved, [...seen, resolved]);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) out[key] = dereference(root, value, seen);
    return out;
  }
  return node;
}

const source = await fs.readFile(openApiFile, 'utf8');
const document = parseDocument(source, { strict: true });
if (document.errors.length > 0) throw new Error(`OpenAPI YAML parse failed: ${document.errors.map((error) => error.message).join('; ')}`);
const api = document.toJS({ maxAliasCount: 0 }) as { components: { schemas: Record<string, unknown> } };

function loadSchema(name: string): Record<string, unknown> {
  const raw = api.components.schemas[name];
  if (!raw) throw new Error(`No such schema: ${name}`);
  return dereference(api, raw) as Record<string, unknown>;
}

const companionStateSchema = loadSchema('CompanionState');
const companionLayoutSchema = loadSchema('CompanionLayout');
const companionActionRequestSchema = loadSchema('CompanionActionRequest');
const companionActionResultSchema = loadSchema('CompanionActionResult');

// allowUnionTypes: the published contract legitimately uses `type: [string,
// 'null']` for nullable fields (e.g. obsStatusReportedAt) -- without this,
// ajv's strict mode only warns instead of failing, which would let a real
// schema authoring mistake slip past silently.
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

function assertConforms(schema: Record<string, unknown>, body: unknown, label: string): void {
  const validate = ajv.compile(structuredClone(schema));
  const ok = validate(body);
  assert.ok(ok, `${label} does not conform to its published schema: ${ajv.errorsText(validate.errors)}`);
}

// L24's own catalogue (apps/api/src/routes/companion.ts) -- the ground truth
// this test proves the contract now matches, so a returning drift here fails
// this file rather than only being visible by reading two source files.
const ACTIONS_17 = [
  'pause_queue', 'resume_queue', 'send_test_alert',
  'obs_set_scene', 'obs_toggle_source', 'obs_toggle_mute', 'obs_start_stream', 'obs_stop_stream',
  'obs_start_record', 'obs_stop_record', 'obs_save_replay_buffer', 'obs_set_transition',
  'mirror_start', 'mirror_stop', 'mirror_screenshot', 'stream_go_live', 'stream_end',
];

const config: RuntimeConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 4108,
  appOrigin: 'http://localhost:3108',
  paymentEnvironment: 'live',
};

const BEARER = 'c'.repeat(48);
const headers = { authorization: `Bearer ${BEARER}` };
// Reserved fixture range for this lane: 00000000-0000-0000-0000-000000006100
// through ...61ff.
const CHANNEL_ID = '00000000-0000-0000-0000-000000006101';
const USER_ID = '00000000-0000-0000-0000-000000006102';
const SESSION_ID = '00000000-0000-0000-0000-000000006103';
const QUEUE_TARGET_ID = '00000000-0000-0000-0000-000000006104';
const OBS_SLOT_TARGET_ID = '00000000-0000-0000-0000-000000006105';
const COMMAND_ID_1 = '00000000-0000-0000-0000-000000006110';
const COMMAND_ID_2 = '00000000-0000-0000-0000-000000006111';

function fakeSessions(): SessionStore {
  return {
    async create() {
      return { accessToken: BEARER, principal: { sessionId: SESSION_ID, userId: USER_ID, expiresAt: '2026-09-20T10:00:00Z' } };
    },
    async lookup(token) {
      return token === BEARER ? { sessionId: SESSION_ID, userId: USER_ID, expiresAt: '2026-09-20T10:00:00Z' } : null;
    },
    async getCurrentUser(userId) { return { schemaVersion: 'v1', userId, displayName: 'Synthetic Conformance Creator', channels: [] }; },
    async list() { return []; },
    async revoke() { return true; },
  };
}

type CompanionStateBody = {
  schemaVersion: 'v1'; channelId: string; overlayConnected: boolean; pendingAlerts: number; lastUpdatedAt: string;
  helperPaired: boolean; obsConnected: boolean; obsStatusReportedAt: string | null;
  paymentAccountConnected: boolean; mirrorReachable: boolean; streamPaired: boolean;
};

function fakeAlerts(state: CompanionStateBody): AlertStore {
  return {
    async createTestAlert() { throw new Error('not used'); },
    async listHistory() { throw new Error('not used'); },
    async moderate() { throw new Error('not used'); },
    async getBilling() { throw new Error('not used'); },
    async getEntitlements(_userId, channelId) {
      return { schemaVersion: 'v1', channelId, tier: 'studio', source: 'individual_plan', entitlementVersion: 1, values: { companionActionGroups: ['alerts', 'obs', 'mirror', 'stream'] } };
    },
    async getCompanionState(_userId, channelId) { return { ...state, channelId }; },
    async getCompanionLayout(_userId, channelId) {
      return {
        schemaVersion: 'v1', channelId, version: 3, tier: 'studio', maxSlots: 64, pageSize: 16,
        slots: [
          { slotIndex: 1, page: 1, label: 'Pause queue', action: 'pause_queue', targetId: QUEUE_TARGET_ID },
          { slotIndex: 2, page: 1, label: 'Mute mic', action: 'obs_toggle_mute', targetId: OBS_SLOT_TARGET_ID, targetLabel: 'Mic' },
        ],
        createdAt: '2026-09-18T10:00:00.000Z',
      };
    },
    async updateCompanionLayout(_userId, channelId, _expectedVersion, pageSize, slots) {
      return { schemaVersion: 'v1', channelId, version: 4, tier: 'studio', maxSlots: 64, pageSize, slots, createdAt: '2026-09-18T10:00:01.000Z' };
    },
    async acquireCompanionControlSession() { throw new Error('not used'); },
    async revokeCompanionControlSession() { throw new Error('not used'); },
    async executeCompanionAction(_userId, channelId, action: CompanionAction, targetId, idempotencyKey) {
      return { schemaVersion: 'v1', commandId: idempotencyKey === 'openapi-conformance-pause-0001' ? COMMAND_ID_1 : COMMAND_ID_2, status: 'accepted', acceptedAt: '2026-09-18T10:00:02.000Z' };
    },
    async reportCompanionObsConnection() { throw new Error('not used'); },
  };
}

const stateWithHeartbeat: CompanionStateBody = {
  schemaVersion: 'v1', channelId: CHANNEL_ID, overlayConnected: true, pendingAlerts: 3, lastUpdatedAt: '2026-09-18T09:59:00.000Z',
  helperPaired: true, obsConnected: true, obsStatusReportedAt: '2026-09-18T09:58:30.000Z',
  paymentAccountConnected: true, mirrorReachable: false, streamPaired: false,
};

const stateNeverReported: CompanionStateBody = {
  ...stateWithHeartbeat, helperPaired: false, obsConnected: false, obsStatusReportedAt: null,
};

test('GET companion/state response conforms to the published CompanionState schema (obsStatusReportedAt populated)', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts(stateWithHeartbeat) });
  const res = await app.inject({ method: 'GET', url: `/v1/channels/${CHANNEL_ID}/companion/state`, headers });
  assert.equal(res.statusCode, 200);
  assertConforms(companionStateSchema, res.json(), 'GET companion/state');
  await app.close();
});

test('GET companion/state response conforms to the published CompanionState schema (obsStatusReportedAt null -- never reported)', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts(stateNeverReported) });
  const res = await app.inject({ method: 'GET', url: `/v1/channels/${CHANNEL_ID}/companion/state`, headers });
  assert.equal(res.statusCode, 200);
  assertConforms(companionStateSchema, res.json(), 'GET companion/state (null heartbeat)');
  await app.close();
});

test('GET companion/layout response conforms to the published CompanionLayout schema (slots span an alerts action and a 17-catalogue obs action with targetLabel)', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts(stateWithHeartbeat) });
  const res = await app.inject({ method: 'GET', url: `/v1/channels/${CHANNEL_ID}/companion/layout`, headers });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.slots[1].action, 'obs_toggle_mute');
  assertConforms(companionLayoutSchema, body, 'GET companion/layout');
  await app.close();
});

test('PATCH companion/layout response conforms to the published CompanionLayout schema', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts(stateWithHeartbeat) });
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/channels/${CHANNEL_ID}/companion/layout`,
    headers: { ...headers, 'if-match-version': '3' },
    payload: {
      pageSize: 16,
      slots: [{ slotIndex: 1, page: 1, label: 'Go live', action: 'stream_go_live', targetId: OBS_SLOT_TARGET_ID }],
    },
  });
  assert.equal(res.statusCode, 200);
  assertConforms(companionLayoutSchema, res.json(), 'PATCH companion/layout');
  await app.close();
});

test('POST companion/actions (alerts action) request and response conform to their published schemas', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts(stateWithHeartbeat) });
  const requestBody = { action: 'pause_queue', targetId: QUEUE_TARGET_ID };
  assertConforms(companionActionRequestSchema, requestBody, 'POST companion/actions request (alerts)');
  const res = await app.inject({
    method: 'POST',
    url: `/v1/channels/${CHANNEL_ID}/companion/actions`,
    headers: { ...headers, 'idempotency-key': 'openapi-conformance-pause-0001' },
    payload: requestBody,
  });
  assert.equal(res.statusCode, 202);
  assertConforms(companionActionResultSchema, res.json(), 'POST companion/actions response (alerts)');
  await app.close();
});

test('POST companion/actions (obs action from the full 17-action catalogue, with targetLabel) request and response conform to their published schemas', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts(stateWithHeartbeat) });
  const requestBody = { action: 'obs_toggle_mute', targetId: OBS_SLOT_TARGET_ID, targetLabel: 'Mic' };
  assert.ok(ACTIONS_17.includes(requestBody.action), 'obs_toggle_mute must be part of the L24 17-action catalogue this test proves the contract now accepts');
  assertConforms(companionActionRequestSchema, requestBody, 'POST companion/actions request (obs)');
  const res = await app.inject({
    method: 'POST',
    url: `/v1/channels/${CHANNEL_ID}/companion/actions`,
    headers: { ...headers, 'idempotency-key': 'openapi-conformance-obsmute-0001' },
    payload: requestBody,
  });
  assert.equal(res.statusCode, 202);
  assertConforms(companionActionResultSchema, res.json(), 'POST companion/actions response (obs)');
  await app.close();
});

// MUTATION PROOF: a conformance check that always passes is worthless -- this
// is the failure mode that let the original defect (CompanionState missing 6
// real fields, action enums missing 14 real values) go undetected for as
// long as it did. Prove this test actually discriminates by reintroducing
// that exact shape of drift (silently dropping one real field from a copy of
// the resolved schema, additionalProperties:false still in force) against a
// real captured response body, and asserting: (1) the drifted copy rejects
// the real body, (2) the real, currently-published schema still accepts it.
test('mutation proof: the conformance check detects a field silently dropped from the schema, and the real schema still passes', async () => {
  const app = await buildApp(config, { sessions: fakeSessions(), alerts: fakeAlerts(stateWithHeartbeat) });
  const res = await app.inject({ method: 'GET', url: `/v1/channels/${CHANNEL_ID}/companion/state`, headers });
  assert.equal(res.statusCode, 200);
  const realBody = res.json();
  await app.close();

  // Sanity: the real body must actually carry the field we are about to drop,
  // or this proof would trivially pass for the wrong reason.
  assert.equal(typeof realBody.helperPaired, 'boolean');

  const drifted = structuredClone(companionStateSchema) as { properties: Record<string, unknown>; required: string[] };
  delete drifted.properties.helperPaired;
  drifted.required = drifted.required.filter((name) => name !== 'helperPaired');

  const driftedValidate = ajv.compile(drifted);
  const driftedOk = driftedValidate(realBody);
  assert.equal(driftedOk, false, 'a schema missing a real response field must reject that real response (additionalProperties: false)');
  assert.match(ajv.errorsText(driftedValidate.errors), /helperPaired|additional/i);

  // And the real, currently-published schema (unmutated) still accepts the
  // exact same body -- proving the detection above is about the injected
  // drift, not some incidental problem with the fixture.
  assertConforms(companionStateSchema, realBody, 'GET companion/state (control, real schema)');
});
