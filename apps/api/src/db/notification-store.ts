import type { Sql, TransactionSql } from 'postgres';
import type { NotificationDevice, NotificationPreferences, NotificationStore } from '../domain/notification-store.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

export function createSqlNotificationStore(sql: Sql): NotificationStore {
  return {
    async getPreferences(userId) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ connection_alerts: boolean; security_alerts: boolean; action_failures: boolean }[]>`
        select connection_alerts, security_alerts, action_failures
          from app_private.get_notification_preferences()
      `);
      const row = rows[0];
      return { schemaVersion: 'v1', connectionAlerts: row?.connection_alerts ?? true, securityAlerts: row?.security_alerts ?? true, actionFailures: row?.action_failures ?? false };
    },
    async updatePreferences(userId, preferences) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ connection_alerts: boolean; security_alerts: boolean; action_failures: boolean }[]>`
        select connection_alerts, security_alerts, action_failures
          from app_private.set_notification_preferences(
            ${preferences.connectionAlerts}, ${preferences.securityAlerts}, ${preferences.actionFailures}
          )
      `);
      const row = rows[0];
      if (!row) throw new Error('Notification preferences were not saved');
      return { schemaVersion: 'v1', connectionAlerts: row.connection_alerts, securityAlerts: row.security_alerts, actionFailures: row.action_failures };
    },
    async registerDevice(userId, platform, tokenCiphertext, tokenFingerprint) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ device_id: string; platform: NotificationDevice['platform']; enabled: boolean; created_at: Date; last_seen_at: Date }[]>`
        select device_id, platform, enabled, created_at, last_seen_at
          from app_private.register_notification_device(
            ${platform}, ${tokenCiphertext}, ${tokenFingerprint}
          )
      `);
      const row = rows[0];
      if (!row) throw new Error('Notification device was not registered');
      return { schemaVersion: 'v1', deviceId: row.device_id, platform: row.platform, enabled: row.enabled, createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString() };
    },
    async listDevices(userId) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ device_id: string; platform: NotificationDevice['platform']; enabled: boolean; created_at: Date; last_seen_at: Date }[]>`
        select device_id, platform, enabled, created_at, last_seen_at
          from app_private.list_notification_devices()
      `);
      return rows.map((row) => ({ schemaVersion: 'v1' as const, deviceId: row.device_id, platform: row.platform, enabled: row.enabled, createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString() }));
    },
    async revokeDevice(userId, deviceId) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ revoked: boolean }[]>`
        select app_private.revoke_notification_device(${deviceId}::uuid) as revoked
      `);
      return rows[0]?.revoked ?? false;
    },
  };
}
