import type { Sql, TransactionSql } from 'postgres';
import type { TemplateCatalogueStore, TemplateSummary, TemplateTier } from '../domain/template-catalogue.js';

// Mirrors branding-store.ts's inUserTransaction exactly: RLS/has_channel_role
// checks inside app_private.list_templates_for_channel need app.user_id set
// for the duration of the call.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

export function createSqlTemplateCatalogueStore(sql: Sql): TemplateCatalogueStore {
  return {
    async listForChannel(userId, channelId): Promise<TemplateSummary[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        id: string; external_key: string; display_name: string; category: string;
        min_tier: TemplateTier; byte_size: number; updated_at: Date;
      }[]>`
        select id, external_key, display_name, category, min_tier, byte_size, updated_at
          from app_private.list_templates_for_channel(${channelId}::uuid)
      `);
      return rows.map((row) => ({
        id: row.id, externalKey: row.external_key, displayName: row.display_name,
        category: row.category, minTier: row.min_tier, byteSize: row.byte_size,
        updatedAt: row.updated_at.toISOString(),
      }));
    },
  };
}
