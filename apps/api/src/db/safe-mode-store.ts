import type { Sql, TransactionSql } from 'postgres';
import type { SafeModeResult, SafeModeStore } from '../domain/safe-mode-store.js';

// PRF-02, creator side of §6 module #12's safe mode (migration 0138).
//
// WIRED TO THE MAIN `sql` POOL, NOT `derivedReadSql`, and that is a
// deliberate structural choice -- the same one db/stream-mission-store.ts
// records for itself. This file carries a creator WRITE path plus the
// creator's own read of one channel setting. RT-10/RT-11's
// `derivedReadSql` is the bounded, statement-timeout-bearing pool for
// widget/dashboard/analytics DERIVED READS; putting a creator write on it
// would be wrong twice over (wrong pool for a write, and two pro-forma
// exemptions forced into packages/db/explain-plans/required-queries.json,
// which is how an exemption list stops being read).
//
// RT-12: no manifest entry is required for this file and none was added.
// Its basename contains neither "overlay" nor "master-canvas" (rule 2),
// the functions it calls are not `list_overlay_*` (rule 1), and
// apps/api/src/index.ts constructs it with `sql` rather than
// `derivedReadSql` (rule 3). All three rules were read before the names
// were chosen, not assumed afterwards -- this is the same structural
// position db/stream-mission-store.ts occupies for the same reason.
//
// The overlay-facing read of the same flag lives in
// db/moderator-status-overlay-store.ts, which IS manifested, IS on
// `derivedReadSql`, and IS covered by all three rules.

// Same convention as db/stream-mission-store.ts / db/goal-store.ts -- a
// deliberate small duplication across store files rather than importing
// across an ownership boundary. app_private.current_user_id() reads
// `app.user_id`, so the SQL gate and the session are the same identity.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

export function createSqlSafeModeStore(sql: Sql): SafeModeStore {
  return {
    // Zero rows for a caller without the owner/admin role AND for a
    // channel that does not exist -- migration 0138 puts the role check
    // inside the function's own WHERE clause, so the two are the same
    // answer by construction rather than by a branch here.
    async get(userId, channelId): Promise<SafeModeResult> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ enabled: boolean }[]>`
        select enabled from app_private.get_channel_safe_mode(${channelId}::uuid)
      `);
      const row = rows[0];
      if (!row || typeof row.enabled !== 'boolean') return { outcome: 'not_found' };
      return { outcome: 'ok', safeMode: { schemaVersion: 'v1', enabled: row.enabled } };
    },

    async set(userId, channelId, enabled): Promise<SafeModeResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ set_channel_safe_mode: boolean }[]>`
          select app_private.set_channel_safe_mode(${channelId}::uuid, ${userId}::uuid, ${enabled}) as set_channel_safe_mode
        `);
        const row = rows[0];
        if (!row || typeof row.set_channel_safe_mode !== 'boolean') return { outcome: 'not_found' };
        return { outcome: 'ok', safeMode: { schemaVersion: 'v1', enabled: row.set_channel_safe_mode } };
      } catch (error) {
        // 42501 = insufficient_privilege, raised by 0138 for a
        // non-owner/admin, for a mismatched session identity, AND for a
        // channel that does not exist or is closed. Deliberately one
        // outcome: a 403 that distinguished them would confirm the
        // existence of a channel the caller may not see.
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'not_found' };
        throw error;
      }
    },
  };
}
