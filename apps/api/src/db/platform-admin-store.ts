import type { Sql, TransactionSql } from 'postgres';
import {
  PlatformAdminError,
  type PlatformAdminChange,
  type PlatformAdminListEntry,
  type PlatformAdminStore,
  type SetPlatformAdminInput,
} from '../domain/platform-admin.js';

// Migration 0156 (ADM-07). Same session-scoped-transaction pattern as
// apps/api/src/db/platform-owner-store.ts: set_config('app.user_id', ...)
// inside the transaction so app_private.is_platform_admin() and
// app_private.current_user_id() see the real caller. Writes -- takes the
// MAIN pool, never derivedReadSql.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function hasSqlstate(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : '';
}

function classify(error: unknown): PlatformAdminError {
  const message = errorMessage(error);
  if (hasSqlstate(error, '42501')) return new PlatformAdminError('self_conferral_forbidden', message);
  if (hasSqlstate(error, '22023')) {
    if (message.includes('does not exist')) return new PlatformAdminError('target_not_found', message);
    return new PlatformAdminError('invalid_input', message);
  }
  throw error;
}

type ChangeRow = {
  user_id: string;
  is_platform_admin: boolean;
  changed_by: string;
  changed_at: Date;
  reason: string;
};

function fromChangeRow(row: ChangeRow): PlatformAdminChange {
  return {
    schemaVersion: 'v1',
    userId: row.user_id,
    isPlatformAdmin: row.is_platform_admin,
    changedBy: row.changed_by,
    changedAt: row.changed_at.toISOString(),
    reason: row.reason,
  };
}

type ListRow = {
  user_id: string;
  display_name: string | null;
  is_platform_admin: boolean;
  is_platform_owner: boolean;
  granted_by: string | null;
  granted_at: Date | null;
  reason: string | null;
};

function fromListRow(row: ListRow): PlatformAdminListEntry {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    isPlatformAdmin: row.is_platform_admin,
    isPlatformOwner: row.is_platform_owner,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at ? row.granted_at.toISOString() : null,
    reason: row.reason,
  };
}

export function createSqlPlatformAdminStore(sql: Sql): PlatformAdminStore {
  return {
    async setAdmin(userId, input): Promise<PlatformAdminChange> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<ChangeRow[]>`
          select user_id, is_platform_admin, changed_by, changed_at, reason
            from app_private.staff_set_platform_admin(${input.targetUserId}::uuid, ${input.isPlatformAdmin}, ${input.reason})
        `);
        const row = rows[0];
        if (!row) throw new PlatformAdminError('invalid_input', 'setAdmin returned no row');
        return fromChangeRow(row);
      } catch (error) {
        if (error instanceof PlatformAdminError) throw error;
        throw classify(error);
      }
    },
    async listAdmins(userId): Promise<PlatformAdminListEntry[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<ListRow[]>`
        select user_id, display_name, is_platform_admin, is_platform_owner, granted_by, granted_at, reason
          from app_private.staff_list_platform_admins()
      `);
      return rows.map(fromListRow);
    },
  };
}
