import type { Sql, TransactionSql } from 'postgres';
import type { AdminStore, ChannelEntitlementAdminView, ChannelEntitlementHistoryEntry, DlqActionResult, DlqEntry, DlqStatusFilter } from '../domain/admin.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

// The two mutation SQL functions raise sqlstate 22023 ("invalid input") for
// the one legitimate non-exceptional failure mode this store must not
// surface as a 5xx: the delivery isn't (or is no longer) in a replayable/
// discardable state. Everything else — including 42501 permission-denied,
// which should never actually happen here since isPlatformAdmin() is
// checked before either function is ever called — is left to propagate and
// is handled generically by the route layer.
const INVALID_STATE_SQLSTATE = '22023';
const FOREIGN_KEY_VIOLATION_SQLSTATE = '23503';

function hasSqlstate(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code;
}

export function createSqlAdminStore(sql: Sql): AdminStore {
  return {
    async isPlatformAdmin(userId) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ is_platform_admin: boolean }[]>`
        select app_private.is_platform_admin() as is_platform_admin
      `);
      return rows[0]?.is_platform_admin ?? false;
    },
    async listDlq(userId, status, limit): Promise<DlqEntry[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        delivery_id: string; event_id: string; channel_id: string; channel_handle: string; queue_id: string;
        status: string; hold_reason: string | null; attempt_count: number; last_error_code: string | null;
        created_at: Date; updated_at: Date;
      }[]>`
        select delivery_id, event_id, channel_id, channel_handle, queue_id, status, hold_reason, attempt_count, last_error_code, created_at, updated_at
          from app_private.list_admin_dlq(${status}, ${limit})
      `);
      return rows.map((row): DlqEntry => ({
        deliveryId: row.delivery_id, eventId: row.event_id, channelId: row.channel_id, channelHandle: row.channel_handle,
        queueId: row.queue_id, status: row.status, holdReason: row.hold_reason, attemptCount: row.attempt_count,
        lastErrorCode: row.last_error_code, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      }));
    },
    async replayDlqDelivery(userId, deliveryId, reason): Promise<DlqActionResult | null> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ delivery_id: string; status: string }[]>`
          select delivery_id, status from app_private.admin_replay_delivery(${deliveryId}::uuid, ${userId}::uuid, ${reason})
        `);
        const row = rows[0];
        return row ? { deliveryId: row.delivery_id, status: row.status } : null;
      } catch (error) {
        if (hasSqlstate(error, INVALID_STATE_SQLSTATE)) return null;
        throw error;
      }
    },
    async discardDlqDelivery(userId, deliveryId, reason): Promise<DlqActionResult | null> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ delivery_id: string; status: string }[]>`
          select delivery_id, status from app_private.admin_discard_delivery(${deliveryId}::uuid, ${userId}::uuid, ${reason})
        `);
        const row = rows[0];
        return row ? { deliveryId: row.delivery_id, status: row.status } : null;
      } catch (error) {
        if (hasSqlstate(error, INVALID_STATE_SQLSTATE)) return null;
        throw error;
      }
    },
    async getChannelEntitlement(userId, channelId): Promise<ChannelEntitlementAdminView | null> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        channel_id: string; channel_handle: string; version: string; tier: string;
        source: ChannelEntitlementAdminView['source']; entitlement_values: Record<string, unknown>; effective_at: Date;
      }[]>`
        select channel_id, channel_handle, version, tier, source, entitlement_values, effective_at
          from app_private.get_channel_entitlement_admin(${channelId}::uuid)
      `);
      const row = rows[0];
      if (!row) return null;
      return {
        channelId: row.channel_id, channelHandle: row.channel_handle, version: Number(row.version), tier: row.tier,
        source: row.source, values: row.entitlement_values, effectiveAt: row.effective_at.toISOString(),
      };
    },
    async listChannelEntitlementHistory(userId, channelId, limit): Promise<ChannelEntitlementHistoryEntry[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        version: string; tier: string; source: ChannelEntitlementHistoryEntry['source'];
        entitlement_values: Record<string, unknown>; effective_at: Date; created_at: Date;
      }[]>`
        select version, tier, source, entitlement_values, effective_at, created_at
          from app_private.list_channel_entitlement_history(${channelId}::uuid, ${limit})
      `);
      return rows.map((row): ChannelEntitlementHistoryEntry => ({
        version: Number(row.version), tier: row.tier, source: row.source, values: row.entitlement_values,
        effectiveAt: row.effective_at.toISOString(), createdAt: row.created_at.toISOString(),
      }));
    },
    async overrideChannelEntitlement(userId, channelId, queueCount, reason): Promise<ChannelEntitlementAdminView | null> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{
          channel_id: string; channel_handle: string; version: string; tier: string; entitlement_values: Record<string, unknown>;
        }[]>`
          select channel_id, channel_handle, version, tier, entitlement_values
            from app_private.admin_override_channel_entitlement(${channelId}::uuid, ${userId}::uuid, ${queueCount}, ${reason})
        `);
        const row = rows[0];
        if (!row) throw new Error('Entitlement override did not return a result');
        return {
          channelId: row.channel_id, channelHandle: row.channel_handle, version: Number(row.version), tier: row.tier,
          source: 'admin_override', values: row.entitlement_values, effectiveAt: new Date().toISOString(),
        };
      } catch (error) {
        if (hasSqlstate(error, FOREIGN_KEY_VIOLATION_SQLSTATE)) return null;
        throw error;
      }
    },
  };
}
