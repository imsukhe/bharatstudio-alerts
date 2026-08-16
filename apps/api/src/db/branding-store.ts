import type { Sql, TransactionSql } from 'postgres';
import type { BrandingStore, DisplayStyle, LottieAssetSummary, StoreLottieAssetResult } from '../domain/branding.js';

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

export function createSqlBrandingStore(sql: Sql): BrandingStore {
  return {
    async listAssets(userId, channelId): Promise<LottieAssetSummary[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        display_style: DisplayStyle; artifact_id: string; byte_size: number; updated_at: Date;
      }[]>`
        select display_style, artifact_id, byte_size, updated_at
          from app_private.list_channel_lottie_assets(${channelId}::uuid)
      `);
      return rows.map((row) => ({
        displayStyle: row.display_style, artifactId: row.artifact_id,
        byteSize: row.byte_size, updatedAt: row.updated_at.toISOString(),
      }));
    },
    async storeAsset(userId, channelId, displayStyle, bytes): Promise<StoreLottieAssetResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ store_channel_lottie_asset: string }[]>`
          select app_private.store_channel_lottie_asset(${channelId}::uuid, ${displayStyle}, ${bytes})
        `);
        const artifactId = rows[0]?.store_channel_lottie_asset;
        return artifactId ? { outcome: 'stored', artifactId } : { outcome: 'invalid' };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'requires the Studio tier')) return { outcome: 'tier_required' };
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'invalid Lottie asset')) return { outcome: 'invalid' };
        throw error;
      }
    },
    async deleteAsset(userId, channelId, displayStyle): Promise<boolean> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ delete_channel_lottie_asset: boolean }[]>`
          select app_private.delete_channel_lottie_asset(${channelId}::uuid, ${displayStyle})
        `);
        return rows[0]?.delete_channel_lottie_asset ?? false;
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return false;
        throw error;
      }
    },
  };
}
