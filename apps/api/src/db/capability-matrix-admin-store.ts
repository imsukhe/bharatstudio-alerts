import type { Sql, TransactionSql } from 'postgres';
import type { CapabilityMatrixAdminStore, CapabilityMatrixSnapshotSummary } from '../domain/capability-matrix-admin.js';

// CTL-10/CTL-11 (migration 0160). Same session-scoped-transaction
// pattern as db/capability-registry-admin-store.ts: set_config so
// app_private.is_platform_admin()/current_user_id() see the real caller.
// MAIN pool, never derivedReadSql -- a platform-staff governance write
// surface, same reasoning as every other admin store in this codebase.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

type PublishRow = {
  id: string;
  version: number;
  published_at: Date;
  row_count: number;
};

type SnapshotListRow = {
  id: string;
  version: number;
  published_at: Date;
  published_by: string | null;
  reason: string | null;
  row_count: number;
};

export function createSqlCapabilityMatrixAdminStore(sql: Sql): CapabilityMatrixAdminStore {
  return {
    async publish(userId, reason): Promise<CapabilityMatrixSnapshotSummary> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<PublishRow[]>`
        select id, version, published_at, row_count
          from app_private.staff_publish_capability_matrix_snapshot(${reason})
      `);
      const row = rows[0];
      if (!row) throw new Error('staff_publish_capability_matrix_snapshot returned no row');
      return {
        schemaVersion: 'v1',
        id: row.id,
        version: row.version,
        publishedAt: row.published_at.toISOString(),
        publishedBy: userId,
        reason,
        rowCount: row.row_count,
      };
    },
    async listSnapshots(userId): Promise<CapabilityMatrixSnapshotSummary[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<SnapshotListRow[]>`
        select id, version, published_at, published_by, reason, row_count
          from app_private.staff_list_capability_matrix_snapshots()
      `);
      return rows.map((row) => ({
        schemaVersion: 'v1',
        id: row.id,
        version: row.version,
        publishedAt: row.published_at.toISOString(),
        publishedBy: row.published_by,
        reason: row.reason,
        rowCount: row.row_count,
      }));
    },
  };
}
