import type { Sql, TransactionSql } from 'postgres';
import type { CapabilityStore, ResolvedCapabilities } from '../domain/capability-store.js';

// CTL phase 1 (migration 0149). Wired to `derivedReadSql` in
// apps/api/src/index.ts, the same RT-10/RT-11 bounded, statement-
// timeout-bearing pool every other widget/dashboard read in this
// codebase uses (insights, canvas layout's overlay half, etc.) --
// app_private.get_channel_capabilities is a creator/dashboard read,
// not a write, and never touches app_private.resolve_channel_
// capabilities' cache-miss recompute path from outside that single
// function call. Manifested in packages/db/explain-plans/
// required-queries.json (capability-resolution.explain.md) per RT-12.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  })) as T;
}

type ResolvedCapabilitiesRow = {
  resolved: Record<string, boolean>;
  generation: number;
  resolved_at: Date;
};

export function createSqlCapabilityStore(sql: Sql): CapabilityStore {
  return {
    async getResolvedCapabilities(userId, channelId): Promise<ResolvedCapabilities | null> {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<ResolvedCapabilitiesRow[]>`
          select resolved, generation, resolved_at
            from app_private.get_channel_capabilities(${channelId}::uuid)
        `;
        const row = rows[0];
        if (!row) return null;
        return {
          schemaVersion: 'v1',
          generation: row.generation,
          resolvedAt: row.resolved_at.toISOString(),
          capabilities: row.resolved,
        };
      });
    },
  };
}
