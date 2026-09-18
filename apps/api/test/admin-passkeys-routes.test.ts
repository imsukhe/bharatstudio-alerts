import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AdminStore } from '../src/domain/admin.js';
import type { AdminPasskeyStore } from '../src/domain/admin-passkeys.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4199, appOrigin: 'http://localhost:3199', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-00000000fa01';
const sessionId = '00000000-0000-4000-8000-00000000fa02';
const headers = { authorization: `Bearer ${'p'.repeat(48)}` };
const sessions: SessionStore = { async create() { throw new Error('unused'); }, async lookup(token) { return token === 'p'.repeat(48) ? { userId, sessionId, expiresAt: '2026-09-18T00:00:00.000Z' } : null; }, async getCurrentUser() { throw new Error('unused'); }, async list() { return []; }, async revoke() { return false; } };
const admin: AdminStore = { async isPlatformAdmin(id) { return id === userId; }, async listDlq() { return []; }, async replayDlqDelivery() { return null; }, async discardDlqDelivery() { return null; }, async getChannelEntitlement() { return null; }, async listChannelEntitlementHistory() { return []; }, async overrideChannelEntitlement() { return null; } };
const webauthn = { rpId: 'admin.test', origins: ['http://localhost:3199'], challengeTtlSeconds: 60, mfaMaxAgeSeconds: 60 };

test('admin passkeys: configuration/store absence fails closed', async () => {
  const app = await buildApp(config, { sessions, admin });
  const response = await app.inject({ method: 'GET', url: '/v1/admin/mfa/status', headers });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().errorCode, 'admin_mfa_unavailable');
  await app.close();
});

test('admin passkeys: status and options are session-bound and do not expose a bearer token', async () => {
  const begins: Array<{ userId: string; sessionId: string; ceremony: string; challengeHash: string }> = [];
  const store: AdminPasskeyStore = {
    async list() { return []; },
    async begin(input) { begins.push(input); },
    async finishRegistration() {},
    async finishAssertion() { return '2026-09-18T00:00:00.000Z'; },
    async isVerified() { return false; },
    async requestRecovery() { return '00000000-0000-4000-8000-00000000aa01'; },
    async listPendingRecoveries() { return []; },
    async approveRecovery() { return { status: 'awaiting_second_approval' as const, completedAt: null }; },
  };
  const app = await buildApp(config, { sessions, admin, adminPasskeys: store, adminWebAuthn: webauthn });
  const status = await app.inject({ method: 'GET', url: '/v1/admin/mfa/status', headers });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json(), { schemaVersion: 'v1', hasPasskey: false, verified: false });
  const options = await app.inject({ method: 'POST', url: '/v1/admin/mfa/passkeys/registration/options', headers });
  assert.equal(options.statusCode, 200);
  assert.equal(typeof options.json().ceremonyId, 'string');
  assert.equal(typeof options.json().options.challenge, 'string');
  assert.equal(JSON.stringify(options.json()).includes('Bearer'), false);
  assert.equal(begins.length, 1);
  assert.deepEqual({ userId: begins[0]?.userId, sessionId: begins[0]?.sessionId, ceremony: begins[0]?.ceremony }, { userId, sessionId, ceremony: 'registration' });
  assert.match(begins[0]?.challengeHash ?? '', /^[0-9a-f]{64}$/);
  await app.close();
});

test('admin passkeys: malformed verification never reaches durable finalization', async () => {
  let finalized = false;
  const store: AdminPasskeyStore = {
    async list() { return []; }, async begin() {},
    async finishRegistration() { finalized = true; }, async finishAssertion() { finalized = true; return 'never'; }, async isVerified() { return false; }, async requestRecovery() { return '00000000-0000-4000-8000-00000000aa01'; }, async listPendingRecoveries() { return []; }, async approveRecovery() { return { status: 'awaiting_second_approval' as const, completedAt: null }; },
  };
  const app = await buildApp(config, { sessions, admin, adminPasskeys: store, adminWebAuthn: webauthn });
  const response = await app.inject({ method: 'POST', url: '/v1/admin/mfa/passkeys/registration/verify', headers, payload: { ceremonyId: '00000000-0000-4000-8000-00000000fa11', response: { id: 'bad', response: { clientDataJSON: 'bad' } } } });
  assert.equal(response.statusCode, 400);
  assert.equal(finalized, false);
  await app.close();
});

test('admin passkeys: recovery requests are role-only but inspection and approval require recent MFA', async () => {
  let requested = false;
  let approved = false;
  const store: AdminPasskeyStore = {
    async list() { return []; }, async begin() {}, async finishRegistration() {}, async finishAssertion() { return 'never'; },
    async isVerified() { return false; },
    async requestRecovery(input) { requested = input.userId === userId && input.sessionId === sessionId; return '00000000-0000-4000-8000-00000000fa31'; },
    async listPendingRecoveries() { return []; },
    async approveRecovery() { approved = true; return { status: 'awaiting_second_approval' as const, completedAt: null }; },
  };
  const app = await buildApp(config, { sessions, admin, adminPasskeys: store, adminWebAuthn: webauthn });
  const request = await app.inject({ method: 'POST', url: '/v1/admin/mfa/recovery/request', headers });
  assert.equal(request.statusCode, 202);
  assert.equal(request.json().recoveryId, '00000000-0000-4000-8000-00000000fa31');
  assert.equal(requested, true);
  const pending = await app.inject({ method: 'GET', url: '/v1/admin/mfa/recovery/pending', headers });
  assert.equal(pending.statusCode, 428);
  const approve = await app.inject({ method: 'POST', url: '/v1/admin/mfa/recovery/00000000-0000-4000-8000-00000000fa31/approve', headers });
  assert.equal(approve.statusCode, 428);
  assert.equal(approved, false);
  await app.close();
});

test('admin passkeys: recovery approval is durable-store backed after MFA', async () => {
  let approved = false;
  const store: AdminPasskeyStore = {
    async list() { return []; }, async begin() {}, async finishRegistration() {}, async finishAssertion() { return 'never'; },
    async isVerified() { return true; }, async requestRecovery() { return '00000000-0000-4000-8000-00000000fa32'; },
    async listPendingRecoveries() { return [{ recoveryId: '00000000-0000-4000-8000-00000000fa32', targetUserId: userId, targetDisplayName: 'Synthetic admin', requestedAt: '2026-09-18T00:00:00.000Z', expiresAt: '2026-09-19T00:00:00.000Z', ownerApproved: false, staffApproved: false }]; },
    async approveRecovery(input) { approved = input.recoveryId === '00000000-0000-4000-8000-00000000fa32'; return { status: 'completed' as const, completedAt: '2026-09-18T00:01:00.000Z' }; },
  };
  const app = await buildApp(config, { sessions, admin, adminPasskeys: store, adminWebAuthn: webauthn });
  const pending = await app.inject({ method: 'GET', url: '/v1/admin/mfa/recovery/pending', headers });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.json().recoveries.length, 1);
  const approval = await app.inject({ method: 'POST', url: '/v1/admin/mfa/recovery/00000000-0000-4000-8000-00000000fa32/approve', headers });
  assert.equal(approval.statusCode, 200);
  assert.deepEqual(approval.json(), { schemaVersion: 'v1', status: 'completed', completedAt: '2026-09-18T00:01:00.000Z' });
  assert.equal(approved, true);
  await app.close();
});
