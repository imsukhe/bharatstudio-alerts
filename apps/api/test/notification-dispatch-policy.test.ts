import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotificationDevice, NotificationPreferences } from '../src/domain/notification-store.js';
import {
  buildOperationalNotificationEnvelope,
  dispatchOperationalNotification,
  isNotificationEnabled,
  selectNotificationDevices,
} from '../src/notifications/notification-dispatch-policy.js';

const preferences: NotificationPreferences = {
  schemaVersion: 'v1',
  connectionAlerts: true,
  securityAlerts: true,
  actionFailures: false,
};

const devices: NotificationDevice[] = [
  { schemaVersion: 'v1', deviceId: '00000000-0000-4000-8000-000000000001', platform: 'android', enabled: true, createdAt: '2026-08-15T00:00:00.000Z', lastSeenAt: '2026-08-15T00:00:00.000Z' },
  { schemaVersion: 'v1', deviceId: '00000000-0000-4000-8000-000000000002', platform: 'ios', enabled: false, createdAt: '2026-08-15T00:00:00.000Z', lastSeenAt: '2026-08-15T00:00:00.000Z' },
];
const enabledDevice = devices[0]!;

test('notification kinds map only to their operational preference', () => {
  assert.equal(isNotificationEnabled(preferences, 'connection_lost'), true);
  assert.equal(isNotificationEnabled(preferences, 'connection_recovered'), true);
  assert.equal(isNotificationEnabled(preferences, 'session_revoked'), true);
  assert.equal(isNotificationEnabled(preferences, 'action_failed'), false);
  assert.deepEqual(selectNotificationDevices(preferences, devices, 'connection_lost').map((device) => device.deviceId), [enabledDevice.deviceId]);
  assert.deepEqual(selectNotificationDevices(preferences, devices, 'action_failed'), []);
});

test('envelope is normalized and contains no tip or donor fields', () => {
  const envelope = buildOperationalNotificationEnvelope({
    notificationId: '00000000-0000-4000-8000-000000000003',
    kind: 'session_revoked',
    occurredAt: '2026-08-15T01:02:03+05:30',
  });
  assert.deepEqual(envelope, {
    schemaVersion: 'v1',
    notificationId: '00000000-0000-4000-8000-000000000003',
    kind: 'session_revoked',
    occurredAt: '2026-08-14T19:32:03.000Z',
  });
  assert.equal('amount' in envelope, false);
  assert.equal('donor' in envelope, false);
  assert.equal('message' in envelope, false);
});

test('invalid notification identifiers and timestamps fail closed', () => {
  assert.throws(() => buildOperationalNotificationEnvelope({
    notificationId: 'not-a-uuid', kind: 'connection_lost', occurredAt: '2026-08-15T00:00:00.000Z',
  }));
  assert.throws(() => buildOperationalNotificationEnvelope({
    notificationId: '00000000-0000-4000-8000-000000000004', kind: 'connection_lost', occurredAt: 'not-a-date',
  }));
});

test('dispatch isolates provider outcomes and keeps delivery sequential', async () => {
  const calls: string[] = [];
  const result = await dispatchOperationalNotification(
    preferences,
    [devices[0]!, devices[1]!],
    { notificationId: '00000000-0000-4000-8000-000000000005', kind: 'connection_recovered', occurredAt: '2026-08-15T00:00:00.000Z' },
    {
      async send(target) {
        calls.push(target.deviceId);
        if (target.platform === 'android') return 'sent';
        return 'retryable';
      },
    },
  );
  assert.deepEqual(calls, [devices[0]!.deviceId]);
  assert.deepEqual(result, { attempted: 1, sent: 1, retryable: 0, disabled: 0 });
});

test('sender exceptions become retryable and never become a false success', async () => {
  const result = await dispatchOperationalNotification(
    preferences,
    [devices[0]!],
    { notificationId: '00000000-0000-4000-8000-000000000006', kind: 'connection_lost', occurredAt: '2026-08-15T00:00:00.000Z' },
    { async send() { throw new Error('provider unavailable'); } },
  );
  assert.deepEqual(result, { attempted: 1, sent: 0, retryable: 1, disabled: 0 });
});
