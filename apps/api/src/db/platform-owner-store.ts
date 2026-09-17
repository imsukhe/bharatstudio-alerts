import type { Sql, TransactionSql } from 'postgres';
import {
  PlatformOwnerError,
  type PlatformOwnerChange,
  type PlatformOwnerStore,
  type SetPlatformOwnerInput,
} from '../domain/platform-owner.js';

// Migration 0155, Job 1. Same session-scoped-transaction pattern as
// apps/api/src/db/capability-change-management-store.ts: set_config
// ('app.user_id', ...) inside the transaction so app_private.
// is_platform_admin() and app_private.current_user_id() see the real
// caller. Writes -- takes the MAIN pool, never derivedReadSql.
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

function classify(error: unknown): PlatformOwnerError {
  const message = errorMessage(error);
  if (hasSqlstate(error, '42501')) return new PlatformOwnerError('self_conferral_forbidden', message);
  if (hasSqlstate(error, '23505')) return new PlatformOwnerError('singleton_violation', message);
  if (hasSqlstate(error, '22023')) {
    if (message.includes('does not exist')) return new PlatformOwnerError('target_not_found', message);
    return new PlatformOwnerError('invalid_input', message);
  }
  throw error;
}

type ChangeRow = {
  user_id: string;
  is_platform_owner: boolean;
  changed_by: string;
  changed_at: Date;
  reason: string;
};

function fromRow(row: ChangeRow): PlatformOwnerChange {
  return {
    schemaVersion: 'v1',
    userId: row.user_id,
    isPlatformOwner: row.is_platform_owner,
    changedBy: row.changed_by,
    changedAt: row.changed_at.toISOString(),
    reason: row.reason,
  };
}

export function createSqlPlatformOwnerStore(sql: Sql): PlatformOwnerStore {
  return {
    async setOwner(userId, input): Promise<PlatformOwnerChange> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<ChangeRow[]>`
          select user_id, is_platform_owner, changed_by, changed_at, reason
            from app_private.staff_set_platform_owner(${input.targetUserId}::uuid, ${input.isPlatformOwner}, ${input.reason})
        `);
        const row = rows[0];
        if (!row) throw new PlatformOwnerError('invalid_input', 'setOwner returned no row');
        return fromRow(row);
      } catch (error) {
        if (error instanceof PlatformOwnerError) throw error;
        throw classify(error);
      }
    },
  };
}
