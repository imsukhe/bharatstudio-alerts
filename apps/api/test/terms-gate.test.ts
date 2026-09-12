import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { AccountStore } from '../src/domain/account-store.js';
import type { ChannelStore } from '../src/domain/channel-store.js';
import type { NotificationStore } from '../src/domain/notification-store.js';
import type { OverlayStore } from '../src/domain/overlay-store.js';

const config: RuntimeConfig = { nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test' };
const userId = '00000000-0000-4000-8000-000000000001';
const sessions: SessionStore = {
  async create() { throw new Error('not used'); },
  async lookup(token) { return token === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-17T00:00:00.000Z' } : null; },
  async getCurrentUser() { throw new Error('not used'); },
  async list() { return []; },
  async revoke() { return false; },
};

function accountStore(accepted: { value: boolean }): AccountStore {
  return {
    async listActiveDocuments() { return []; },
    async acceptDocument() { return true; },
    async hasAcceptedActiveDocuments() { return accepted.value; },
    async createPrivacyRequest() { throw new Error('not used'); },
    async listPrivacyRequests() { return []; },
    async exportAccount() { return {}; },
    async closeAccount() { return ''; },
  };
}

const channels = {
  async createChannel(_user: string, input: { channelId: string; handle: string; displayName: string }) {
    return { schemaVersion: 'v1' as const, channelId: input.channelId, handle: input.handle, displayName: input.displayName, acceptingTips: true, publicConfigVersion: 1, role: 'owner' };
  },
} as unknown as ChannelStore;

test('creator mutations require current terms and privacy acceptance', async () => {
  const accepted = { value: false };
  const app = await buildApp(config, { sessions, channels, account: accountStore(accepted) });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
  const blocked = await app.inject({ method: 'POST', url: '/v1/channels', headers, payload: { handle: 'creator', displayName: 'Creator' } });
  assert.equal(blocked.statusCode, 428);
  assert.equal(blocked.json().errorCode, 'terms_acceptance_required');

  accepted.value = true;
  const allowed = await app.inject({ method: 'POST', url: '/v1/channels', headers, payload: { handle: 'creator', displayName: 'Creator' } });
  assert.equal(allowed.statusCode, 201);
  await app.close();
});

test('credential revocations remain available while updated terms are pending', async () => {
  const accepted = { value: false };
  let sessionRevoked = false;
  let deviceRevoked = false;
  let overlayRevoked = false;
  let overlayRotated = false;
  const app = await buildApp(config, {
    sessions: {
      ...sessions,
      async revoke() { sessionRevoked = true; return true; },
    },
    account: accountStore(accepted),
    notifications: {
      async revokeDevice() { deviceRevoked = true; return true; },
    } as unknown as NotificationStore,
    overlays: {
      async revoke() { overlayRevoked = true; return true; },
      async rotate() {
        overlayRotated = true;
        return {
          schemaVersion: 'v1',
          overlayId: '00000000-0000-4000-8000-000000000006',
          expiresAt: '2026-09-10T00:00:00.000Z',
          streamUrl: 'https://overlay.example/#credential',
        };
      },
    } as unknown as OverlayStore,
  });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };

  const session = await app.inject({ method: 'DELETE', url: '/v1/me/sessions/00000000-0000-4000-8000-000000000004', headers });
  const device = await app.inject({ method: 'DELETE', url: '/v1/me/notifications/devices/00000000-0000-4000-8000-000000000005', headers });
  const rotate = await app.inject({ method: 'POST', url: '/v1/overlays/00000000-0000-4000-8000-000000000006/rotate', headers });
  const overlay = await app.inject({ method: 'DELETE', url: '/v1/overlays/00000000-0000-4000-8000-000000000006', headers });

  assert.equal(session.statusCode, 204);
  assert.equal(device.statusCode, 204);
  assert.equal(rotate.statusCode, 201);
  assert.equal(overlay.statusCode, 204);
  assert.equal(sessionRevoked, true);
  assert.equal(deviceRevoked, true);
  assert.equal(overlayRotated, true);
  assert.equal(overlayRevoked, true);
  await app.close();
});

test('staging cannot boot without the account enforcement adapter', async () => {
  await assert.rejects(
    buildApp({ ...config, nodeEnv: 'staging' }, { sessions }),
    /Account store is required/,
  );
});
