import type { Sql, TransactionSql } from 'postgres';
import type { AdminStore, DlqActionResult, DlqEntry, DlqStatusFilter } from '../domain/admin.js';

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

function isInvalidStateError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === INVALID_STATE_SQLSTATE;
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
        if (isInvalidStateError(error)) return null;
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
        if (isInvalidStateError(error)) return null;
        throw error;
      }
    },
  };
}
