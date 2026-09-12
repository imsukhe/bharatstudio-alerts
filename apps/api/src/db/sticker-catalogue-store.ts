import type { Sql, TransactionSql } from 'postgres';
import type { SetStickerEnabledResult, StickerCatalogueStore, StickerSummary, StickerTier } from '../domain/sticker-catalogue.js';

// Mirrors template-catalogue-store.ts / branding-store.ts's inUserTransaction
// exactly: RLS/has_channel_role checks inside app_private.
// list_stickers_for_channel and set_channel_sticker_enabled need
// app.user_id set for the duration of the call.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function isPgErrorWithMessage(error: unknown, substring: string): boolean {
  return error instanceof Error && error.message.includes(substring);
}

export function createSqlStickerCatalogueStore(sql: Sql): StickerCatalogueStore {
  return {
    async listForChannel(userId, channelId): Promise<StickerSummary[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        id: string; external_key: string; display_name: string; category: string;
        min_tier: StickerTier; byte_size: number; enabled: boolean; updated_at: Date;
      }[]>`
        select id, external_key, display_name, category, min_tier, byte_size, enabled, updated_at
          from app_private.list_stickers_for_channel(${channelId}::uuid)
      `);
      return rows.map((row) => ({
        id: row.id, externalKey: row.external_key, displayName: row.display_name,
        category: row.category, minTier: row.min_tier, byteSize: row.byte_size,
        enabled: row.enabled, updatedAt: row.updated_at.toISOString(),
      }));
    },
    async setEnabled(userId, channelId, stickerId, enabled): Promise<SetStickerEnabledResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ set_channel_sticker_enabled: boolean }[]>`
          select app_private.set_channel_sticker_enabled(${channelId}::uuid, ${stickerId}::uuid, ${enabled})
        `);
        const result = rows[0]?.set_channel_sticker_enabled;
        return result === undefined ? { outcome: 'not_found' } : { outcome: 'ok', enabled: result };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'unknown sticker')) return { outcome: 'not_found' };
        throw error;
      }
    },
  };
}
