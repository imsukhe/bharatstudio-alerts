import type { Sql, TransactionSql } from 'postgres';
import type { CompanionActionGroup, CompanionEntitlementStore, CompanionGrantPolicy } from '../domain/companion-entitlement-policy.js';

// Same convention as apps/api/src/db/companion-feature-store.ts's own
// inUserTransaction (itself a deliberate small duplication of apps/api/src/
// db/alert-store.ts's private helper, unowned/unexported from there) --
// duplicated again here rather than importing across an ownership
// boundary.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

const VALID_GROUPS: CompanionActionGroup[] = ['alerts', 'obs', 'mirror', 'stream'];

export function createSqlCompanionEntitlementStore(sql: Sql): CompanionEntitlementStore {
  return {
    async getCompanionGrantPolicy(userId, channelId) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        source_key: string; granted: boolean; action_limit: number; action_groups: unknown;
      }[]>`
        select source_key, granted, action_limit, action_groups
          from app_private.companion_grant_policy(${channelId}::uuid)
      `);
      const row = rows[0];
      if (!row) return null;
      const rawGroups = Array.isArray(row.action_groups) ? row.action_groups : [];
      const actionGroups = rawGroups.filter((entry): entry is CompanionActionGroup => typeof entry === 'string' && (VALID_GROUPS as string[]).includes(entry));
      const result: CompanionGrantPolicy = {
        schemaVersion: 'v1', channelId, sourceKey: row.source_key, granted: row.granted, actionLimit: row.action_limit, actionGroups,
      };
      return result;
    },
  };
}
