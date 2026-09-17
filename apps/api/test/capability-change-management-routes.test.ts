import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AdminStore } from '../src/domain/admin.js';
import {
  CapabilityChangeManagementError,
  type CapabilityChangeManagementStore,
  type CapabilityChangeRequest,
} from '../src/domain/capability-change-management.js';

/*
 * CTL phase 2, Lane A (migration 0152). Route-layer proof only -- the
 * SQL layer's own proof of CTL-06 (read-time correctness), CTL-07 (the
 * three authority rules), CTL-08 (append-only revert) and CTL-09 (the
 * structural capacity_class guard) lives in packages/db/tests/
 * ctl_change_management.sql. This file proves: the platform-admin gate
 * (same posture as admin-routes.test.ts), request-schema validation,
 * the CapabilityChangeManagementError -> HTTP status mapping, and that
 * an unwired store degrades to a safe 503, never a crash.
 */

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4103, appOrigin: 'http://localhost:3103', paymentEnvironment: 'test' };
const adminUserId = '00000000-0000-4000-8000-000000000901';
const nonAdminUserId = '00000000-0000-4000-8000-000000000902';
const changeId = '00000000-0000-4000-8000-000000000961';
const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
const nonAdminHeaders = { authorization: `Bearer ${'b'.repeat(48)}` };

const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) {
    if (token === 'a'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000003', userId: adminUserId, expiresAt: '2026-09-17T00:00:00.000Z' };
    if (token === 'b'.repeat(48)) return { sessionId: '00000000-0000-4000-8000-000000000004', userId: nonAdminUserId, expiresAt: '2026-09-17T00:00:00.000Z' };
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

const sampleChange: CapabilityChangeRequest = {
  schemaVersion: 'v1',
  id: changeId,
  capabilityKey: 'ctl_route_probe',
  changeKind: 'update',
  status: 'pending_approval',
  proposedCapacityClass: 'team_seat',
  proposedDescription: 'a route-level probe change',
  proposedKillSwitch: false,
  proposedRolloutPercentage: 100,
  proposedMinTier: 'pro',
  // Migration 0157: the six §20.2 fields migration 0153 added, now
  // carried through this workflow.
  proposedKind: null,
  proposedLimits: null,
  proposedBeta: null,
  proposedMarketingVisible: null,
  proposedMarketingLabel: null,
  proposedMarketingBlurb: null,
  effectiveAt: '2026-09-17T10:00:00.000Z',
  requiresOwnerSignoff: false,
  staffApprovalCount: 0,
  ownerApprovalCount: 0,
  createdBy: adminUserId,
  createdAt: '2026-09-17T09:00:00.000Z',
  appliedAt: null,
  decidedAt: null,
  reason: null,
};

function fakeStore(overrides: Partial<CapabilityChangeManagementStore> = {}): CapabilityChangeManagementStore {
  return {
    async proposeChange() { return sampleChange; },
    async listChanges() { return [sampleChange]; },
    async getChange() { return sampleChange; },
    async listApprovals() { return []; },
    async approveChange() { return { ...sampleChange, status: 'approved', staffApprovalCount: 2 }; },
    async rejectChange() { return { ...sampleChange, status: 'rejected', decidedAt: '2026-09-17T11:00:00.000Z' }; },
    async killCapability() { return { ...sampleChange, changeKind: 'kill', status: 'applied', proposedKillSwitch: true }; },
    async revertCapability() { return { ...sampleChange, changeKind: 'revert', status: 'applied' }; },
    ...overrides,
  };
}

test('capability change management: platform-admin gate, same posture as the DLQ admin routes', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityChangeManagement: fakeStore() });

  const asAdmin = await app.inject({
    method: 'POST', url: '/v1/admin/capability-registry/changes', headers,
    payload: { capabilityKey: 'ctl_route_probe', capacityClass: 'team_seat', description: 'probe' },
  });
  assert.equal(asAdmin.statusCode, 201);
  assert.deepEqual(asAdmin.json(), sampleChange);

  const asNonAdmin = await app.inject({ method: 'GET', url: '/v1/admin/capability-registry/changes', headers: nonAdminHeaders });
  assert.equal(asNonAdmin.statusCode, 403);
  assert.equal(asNonAdmin.json().errorCode, 'platform_admin_required');

  const unauthenticated = await app.inject({ method: 'GET', url: '/v1/admin/capability-registry/changes' });
  assert.equal(unauthenticated.statusCode, 401);
  await app.close();
});

test('capability change management: every route fails closed (503) with no configured store', async () => {
  const app = await buildApp(config, { sessions, admin });
  const routes: Array<{ method: 'GET' | 'POST'; url: string; payload: Record<string, unknown> }> = [
    { method: 'POST', url: '/v1/admin/capability-registry/changes', payload: { capabilityKey: 'x', capacityClass: 'team_seat', description: 'd' } },
    { method: 'GET', url: '/v1/admin/capability-registry/changes', payload: {} },
    { method: 'GET', url: `/v1/admin/capability-registry/changes/${changeId}`, payload: {} },
    { method: 'POST', url: `/v1/admin/capability-registry/changes/${changeId}/approve`, payload: { approvalKind: 'staff' } },
    { method: 'POST', url: `/v1/admin/capability-registry/changes/${changeId}/reject`, payload: { reason: 'no' } },
    { method: 'POST', url: '/v1/admin/capability-registry/ctl_probe/kill', payload: {} },
    { method: 'POST', url: '/v1/admin/capability-registry/ctl_probe/revert', payload: {} },
  ];
  for (const route of routes) {
    const response = await app.inject({ method: route.method, url: route.url, headers, payload: route.payload });
    assert.equal(response.statusCode, 503, `${route.method} ${route.url}`);
    assert.equal(response.json().errorCode, 'capability_change_management_unavailable');
  }
  await app.close();
});

test('capability change management: propose rejects a body with an undeclared field or an invalid capacityClass', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityChangeManagement: fakeStore() });
  const badField = await app.inject({
    method: 'POST', url: '/v1/admin/capability-registry/changes', headers,
    payload: { capabilityKey: 'ctl_route_probe', capacityClass: 'team_seat', description: 'probe', notAllowed: true },
  });
  assert.equal(badField.statusCode, 400);

  const badCapacityClass = await app.inject({
    method: 'POST', url: '/v1/admin/capability-registry/changes', headers,
    payload: { capabilityKey: 'ctl_route_probe', capacityClass: 'payment', description: 'CTL-09: this must never validate' },
  });
  assert.equal(badCapacityClass.statusCode, 400);

  // Migration 0157: an unrecognised kind is rejected the same way an
  // unrecognised capacityClass already was -- same enum-validation
  // posture extended to the newly-accepted field.
  const badKind = await app.inject({
    method: 'POST', url: '/v1/admin/capability-registry/changes', headers,
    payload: { capabilityKey: 'ctl_route_probe', capacityClass: 'team_seat', description: 'probe', kind: 'marketing_section' },
  });
  assert.equal(badKind.statusCode, 400);
  await app.close();
});

test('capability change management: propose forwards all six new §20.2 fields (migration 0157) to the store', async () => {
  let received: unknown;
  const app = await buildApp(config, {
    sessions, admin,
    capabilityChangeManagement: fakeStore({
      async proposeChange(_userId, input) { received = input; return sampleChange; },
    }),
  });
  const response = await app.inject({
    method: 'POST', url: '/v1/admin/capability-registry/changes', headers,
    payload: {
      capabilityKey: 'ctl_route_probe', capacityClass: 'team_seat', description: 'probe',
      kind: 'module', limits: { max_instances: 3 }, beta: true,
      marketingVisible: true, marketingLabel: 'Label', marketingBlurb: 'Blurb',
    },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(received, {
    capabilityKey: 'ctl_route_probe', capacityClass: 'team_seat', description: 'probe',
    killSwitch: false, rolloutPercentage: 100, minTier: null, effectiveAt: null, reason: null,
    kind: 'module', limits: { max_instances: 3 }, beta: true,
    marketingVisible: true, marketingLabel: 'Label', marketingBlurb: 'Blurb',
  });

  // Omitting all six leaves them undefined -- merge semantics ("do not
  // touch this field"), never coerced to a real value like false/{}/null.
  let receivedOmitted: unknown;
  const app2 = await buildApp(config, {
    sessions, admin,
    capabilityChangeManagement: fakeStore({
      async proposeChange(_userId, input) { receivedOmitted = input; return sampleChange; },
    }),
  });
  await app2.inject({
    method: 'POST', url: '/v1/admin/capability-registry/changes', headers,
    payload: { capabilityKey: 'ctl_route_probe', capacityClass: 'team_seat', description: 'probe' },
  });
  const omitted = receivedOmitted as Record<string, unknown>;
  for (const field of ['kind', 'limits', 'beta', 'marketingVisible', 'marketingLabel', 'marketingBlurb']) {
    assert.equal(omitted[field], undefined, `${field} must stay undefined (merge semantics), not coerced`);
  }
  await app.close();
  await app2.close();
});

test('capability change management: get returns the change plus its approvals, 404 when not found', async () => {
  let current: CapabilityChangeRequest | null = sampleChange;
  const app = await buildApp(config, {
    sessions, admin,
    capabilityChangeManagement: fakeStore({
      async getChange() { return current; },
      async listApprovals() { return [{ id: '00000000-0000-4000-8000-000000000971', approvalKind: 'staff', approverId: adminUserId, approvedAt: '2026-09-17T09:30:00.000Z' }]; },
    }),
  });

  const ok = await app.inject({ method: 'GET', url: `/v1/admin/capability-registry/changes/${changeId}`, headers });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().approvals.length, 1);
  assert.equal(ok.json().id, changeId);

  current = null;
  const notFound = await app.inject({ method: 'GET', url: `/v1/admin/capability-registry/changes/${changeId}`, headers });
  assert.equal(notFound.statusCode, 404);
  await app.close();
});

test('capability change management: approve/reject/kill/revert happy paths', async () => {
  const app = await buildApp(config, { sessions, admin, capabilityChangeManagement: fakeStore() });

  const approved = await app.inject({ method: 'POST', url: `/v1/admin/capability-registry/changes/${changeId}/approve`, headers, payload: { approvalKind: 'staff' } });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().status, 'approved');

  const rejected = await app.inject({ method: 'POST', url: `/v1/admin/capability-registry/changes/${changeId}/reject`, headers, payload: { reason: 'no longer needed' } });
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.json().status, 'rejected');

  const killed = await app.inject({ method: 'POST', url: '/v1/admin/capability-registry/ctl_route_probe/kill', headers, payload: { reason: 'incident' } });
  assert.equal(killed.statusCode, 200);
  assert.equal(killed.json().changeKind, 'kill');

  const reverted = await app.inject({ method: 'POST', url: '/v1/admin/capability-registry/ctl_route_probe/revert', headers, payload: {} });
  assert.equal(reverted.statusCode, 200);
  assert.equal(reverted.json().changeKind, 'revert');
  await app.close();
});

test('capability change management: CapabilityChangeManagementError reasons map to the documented HTTP status', async () => {
  const cases: Array<{ reason: ConstructorParameters<typeof CapabilityChangeManagementError>[0]; expected: number }> = [
    { reason: 'not_found', expected: 404 },
    { reason: 'capability_not_found', expected: 404 },
    { reason: 'not_open', expected: 409 },
    { reason: 'duplicate_approval', expected: 409 },
    { reason: 'self_approval_forbidden', expected: 403 },
    { reason: 'owner_identity_required', expected: 403 },
    { reason: 'owner_signoff_not_required', expected: 400 },
    { reason: 'no_previous_version', expected: 400 },
    { reason: 'invalid_input', expected: 400 },
  ];
  for (const { reason, expected } of cases) {
    const app = await buildApp(config, {
      sessions, admin,
      capabilityChangeManagement: fakeStore({
        async approveChange() { throw new CapabilityChangeManagementError(reason, `synthetic ${reason}`); },
      }),
    });
    const response = await app.inject({ method: 'POST', url: `/v1/admin/capability-registry/changes/${changeId}/approve`, headers, payload: { approvalKind: 'staff' } });
    assert.equal(response.statusCode, expected, reason);
    assert.equal(response.json().errorCode, reason);
    await app.close();
  }
});

test('capability change management: an unexpected store failure degrades to a clean, retryable 503, never a crash', async () => {
  const app = await buildApp(config, {
    sessions, admin,
    capabilityChangeManagement: fakeStore({
      async proposeChange() { throw new Error('synthetic db failure'); },
    }),
  });
  const response = await app.inject({
    method: 'POST', url: '/v1/admin/capability-registry/changes', headers,
    payload: { capabilityKey: 'ctl_route_probe', capacityClass: 'team_seat', description: 'probe' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().retryable, true);
  await app.close();
});
