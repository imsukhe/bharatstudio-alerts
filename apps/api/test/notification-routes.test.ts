import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { RuntimeConfig } from '../src/config.js';
import type { SessionStore } from '../src/auth/session-store.js';
import type { NotificationDevice, NotificationPreferences, NotificationStore } from '../src/domain/notification-store.js';
import { createNotificationTokenProtector } from '../src/notifications/token-crypto.js';

const config: RuntimeConfig = {
  nodeEnv: 'test', host: '127.0.0.1', port: 4100, appOrigin: 'http://localhost:3100', paymentEnvironment: 'test',
};
const userId = '00000000-0000-4000-8000-000000000001';
const deviceId = '00000000-0000-4000-8000-000000000002';
const token = 'fcm-token:abcdefghijklmnopqrstuvwxyz-0123456789';

function sessions(): SessionStore {
  return {
    async create() { throw new Error('not used'); },
    async lookup(value) {
      return value === 'a'.repeat(48) ? { sessionId: '00000000-0000-4000-8000-000000000003', userId, expiresAt: '2026-08-16T00:00:00.000Z' } : null;
    },
    async getCurrentUser() { throw new Error('not used'); },
    async list() { return []; },
    async revoke() { return false; },
  };
}

function notifications(): NotificationStore {
  let preferences: NotificationPreferences = { schemaVersion: 'v1', connectionAlerts: true, securityAlerts: true, actionFailures: false };
  let device: NotificationDevice | null = null;
  return {
    async getPreferences() { return preferences; },
    async updatePreferences(_userId, next) { preferences = { schemaVersion: 'v1', ...next }; return preferences; },
    async registerDevice(_userId, platform) {
      device = { schemaVersion: 'v1', deviceId, platform, enabled: true, createdAt: '2026-08-15T00:00:00.000Z', lastSeenAt: '2026-08-15T00:00:00.000Z' };
      return device;
    },
    async listDevices() { return device ? [device] : []; },
    async revokeDevice(_userId, id) { if (id !== deviceId || !device) return false; device = null; return true; },
  };
}

test('notification preferences and device routes are authenticated and privacy-minimised', async () => {
  const app = await buildApp(config, {
    sessions: sessions(),
    notifications: notifications(),
    notificationTokenProtector: createNotificationTokenProtector('a'.repeat(64)),
  });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };

  const initial = await app.inject({ method: 'GET', url: '/v1/me/notifications/preferences', headers });
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json(), { schemaVersion: 'v1', connectionAlerts: true, securityAlerts: true, actionFailures: false });

  const updated = await app.inject({
    method: 'PUT', url: '/v1/me/notifications/preferences', headers,
    payload: { connectionAlerts: false, securityAlerts: true, actionFailures: true },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().connectionAlerts, false);

  const registered = await app.inject({ method: 'PUT', url: '/v1/me/notifications/devices', headers, payload: { platform: 'android', token } });
  assert.equal(registered.statusCode, 200);
  assert.deepEqual(Object.keys(registered.json()).sort(), ['createdAt', 'deviceId', 'enabled', 'lastSeenAt', 'platform', 'schemaVersion']);
  assert.equal(JSON.stringify(registered.json()).includes(token), false);

  const devices = await app.inject({ method: 'GET', url: '/v1/me/notifications/devices', headers });
  assert.equal(devices.statusCode, 200);
  assert.equal(devices.json().devices.length, 1);

  const revoked = await app.inject({ method: 'DELETE', url: `/v1/me/notifications/devices/${deviceId}`, headers });
  assert.equal(revoked.statusCode, 204);
  await app.close();
});

test('notification device registration rejects malformed or sensitive input', async () => {
  const app = await buildApp(config, { sessions: sessions(), notifications: notifications(), notificationTokenProtector: createNotificationTokenProtector('b'.repeat(64)) });
  const headers = { authorization: `Bearer ${'a'.repeat(48)}` };
  const malformed = await app.inject({ method: 'PUT', url: '/v1/me/notifications/devices', headers, payload: { platform: 'android', token: 'contains spaces and secrets' } });
  assert.equal(malformed.statusCode, 400);
  const missing = await app.inject({ method: 'GET', url: '/v1/me/notifications/preferences' });
  assert.equal(missing.statusCode, 401);
  await app.close();
});
