import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AdminStore } from '../src/domain/admin.js';
import {
  CapabilityRegistryAdminError,
  type CapabilityRegistryAdminStore,
  type CapabilityRegistryEntry,
} from '../src/domain/capability-registry-admin.js';

/*
 * CTL registry spec alignment (migration 0153). Route-layer proof only --
 * the SQL layer's own proof (every new §20.2 field settable/readable,
 * CTL-14/CTL-15 re-proven, the allowlist precedence order) lives in
 * packages/db/tests/ctl_registry_spec_alignment.sql. This file proves:
 * the platform-admin gate (same posture as capability-change-management-
 * routes.test.ts), request-schema validation, the
 * CapabilityRegistryAdminError -> HTTP status mapping, and that an
 * unwired store degrades to a safe 503, never a crash.
 */

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4104, appOrigin: 'http://localhost:3104', paymentEnvironment: 'test' };
const adminUserId = '00000000-0000-4000-8000-000000000911';
const nonAdminUserId = '00000000-0000-4000-8000-000000000912';
const headers = { authorization: `Bearer ${'c'.repeat(48)}` };
const nonAdminHeaders = { authorization: `Bearer ${'d'.repeat(48)}` };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) {
    if (token === 'c'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000005', userId: adminUserId, expiresAt: '2026-09-17T00:00:00.000Z' };
    if (token === 'd'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000006', userId: nonAdminUserId, expiresAt: '2026-09-17T00:00:00.000Z' };
    return null;
  },
  async getCurrentUser() { throw new Error('not used'); }, async list() { return []; }, async revoke() { return false; },
};

const admin: AdminStore = {
  async isPlatformAdmin(userId) { return userId === adminUserId; },
  async listDlq() { return []; },
  async replayDlqDelivery() { return null; },
  async discardDlqDelivery() { return null; },
  async getChannelEntitlement() { return null; },
  async listChannelEntitlementHistory() { return []; },
  async overrideChannelEntitlement() { return null; },
};

const sampleEntry: CapabilityRegistryEntry = {
  schemaVersion: 'v1',
  capabilityKey: 'ctl_route_registry_probe',
  capacityClass: 'active_widget',
  description: 'a route-level probe capability',
  killSwitch: false,
  rolloutPercentage: 100,
  minTier: 'pro',
  kind: 'widget',
  limits: { max_instances: 3 },
  beta: true,
  marketingVisible: true,
  marketingLabel: 'Probe Widget',
  marketingBlurb: 'A route-test probe.',
  version: 1,
  updatedAt: '2026-09-17T09:00:00.000Z',
};

function fakeStore(overrides: Partial<CapabilityRegistryAdminStore> = {}): CapabilityRegistryAdminStore {
  return {
    async getEntry() { return sampleEntry; },
    async listEntries() { return [sampleEntry]; },
    async setEntry() { return sampleEntry; },
    ...overrides,
  };
}

test('capability registry admin: platform-admin gate, same posture as capability change management', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityRegistryAdmin: fakeStore() });

  const asAdmin = await app.inject({ method: 'GET', url: '/v1/admin/capability-registry/entries', headers });
  assert.equal(asAdmin.statusCode, 200);
  assert.deepEqual(asAdmin.json(), { schemaVersion: 'v1', entries: [sampleEntry] });

  const asNonAdmin = await app.inject({ method: 'GET', url: '/v1/admin/capability-registry/entries', headers: nonAdminHeaders });
  assert.equal(asNonAdmin.statusCode, 403);
  assert.equal(asNonAdmin.json().errorCode, 'platform_admin_required');

  const unauthenticated = await app.inject({ method: 'GET', url: '/v1/admin/capability-registry/entries' });
  assert.equal(unauthenticated.statusCode, 401);
  await app.close();
});

test('capability registry admin: every route fails closed (503) with no configured store', async () => {
  const app = await buildApp(config, { sessions, admin });
  const routes: Array<{ method: 'GET' | 'PUT'; url: string; payload?: Record<string, unknown> }> = [
    { method: 'GET', url: '/v1/admin/capability-registry/entries' },
    { method: 'GET', url: '/v1/admin/capability-registry/entries/ctl_probe' },
    { method: 'PUT', url: '/v1/admin/capability-registry/entries/ctl_probe', payload: fullBody() },
  ];
  for (const route of routes) {
    const response = await app.inject({ method: route.method, url: route.url, headers, payload: route.payload });
    assert.equal(response.statusCode, 503, `${route.method} ${route.url}`);
    assert.equal(response.json().errorCode, 'capability_registry_admin_unavailable');
  }
  await app.close();
});

function fullBody() {
  return {
    capacityClass: 'active_widget', description: 'probe', killSwitch: false, rolloutPercentage: 100,
    minTier: 'pro', kind: 'widget', limits: { max_instances: 3 }, beta: true,
    marketingVisible: true, marketingLabel: 'Probe Widget', marketingBlurb: 'A route-test probe.',
  };
}

test('capability registry admin: get returns the entry, 404 when not found', async () => {
  let current: CapabilityRegistryEntry | null = sampleEntry;
  const app = await buildApp(config, { sessions, admin, capabilityRegistryAdmin: fakeStore({ async getEntry() { return current; } }) });

  const ok = await app.inject({ method: 'GET', url: '/v1/admin/capability-registry/entries/ctl_route_registry_probe', headers });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().capabilityKey, 'ctl_route_registry_probe');

  current = null;
  const notFound = await app.inject({ method: 'GET', url: '/v1/admin/capability-registry/entries/ctl_route_registry_probe', headers });
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.json().errorCode, 'capability_not_found');
  await app.close();
});

test('capability registry admin: set requires the complete body -- an undeclared field or a missing required field is rejected (400)', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityRegistryAdmin: fakeStore() });

  const badField = await app.inject({
    method: 'PUT', url: '/v1/admin/capability-registry/entries/ctl_route_registry_probe', headers,
    payload: { ...fullBody(), notAllowed: true },
  });
  assert.equal(badField.statusCode, 400);

  const missingField = await app.inject({
    method: 'PUT', url: '/v1/admin/capability-registry/entries/ctl_route_registry_probe', headers,
    payload: { capacityClass: 'active_widget', description: 'probe' },
  });
  assert.equal(missingField.statusCode, 400);

  const badKind = await app.inject({
    method: 'PUT', url: '/v1/admin/capability-registry/entries/ctl_route_registry_probe', headers,
    payload: { ...fullBody(), kind: 'marketing_section' },
  });
  assert.equal(badKind.statusCode, 400, 'kind: marketing_section is not in the §20.2 enum and must not validate here either');
  await app.close();
});

test('capability registry admin: set happy path', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityRegistryAdmin: fakeStore() });
  const response = await app.inject({
    method: 'PUT', url: '/v1/admin/capability-registry/entries/ctl_route_registry_probe', headers,
    payload: fullBody(),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().kind, 'widget');
  assert.equal(response.json().marketingVisible, true);
  await app.close();
});

test('capability registry admin: CapabilityRegistryAdminError maps to 400', async () => {
  const app = await buildApp(config, {
    sessions, admin,
    capabilityRegistryAdmin: fakeStore({
      async setEntry() { throw new CapabilityRegistryAdminError('invalid_input', 'synthetic check_violation'); },
    }),
  });
  const response = await app.inject({ method: 'PUT', url: '/v1/admin/capability-registry/entries/ctl_route_registry_probe', headers, payload: fullBody() });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().errorCode, 'invalid_input');
  await app.close();
});

test('capability registry admin: an unexpected store failure degrades to a clean, retryable 503, never a crash', async () => {
  const app = await buildApp(config, {
    sessions, admin,
    capabilityRegistryAdmin: fakeStore({
      async setEntry() { throw new Error('synthetic db failure'); },
    }),
  });
  const response = await app.inject({ method: 'PUT', url: '/v1/admin/capability-registry/entries/ctl_route_registry_probe', headers, payload: fullBody() });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});
