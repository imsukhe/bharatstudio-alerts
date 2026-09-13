import type { Sql, TransactionSql } from 'postgres';
import type {
  AttachCreatorPackStickerResult, CreatorPackSelectionStore, CreatorPackStatus, CreatorPackStickerSummary,
  CreatorPackStore, ImportCreatorPackStickerResult, PublicCreatorPackStickerSummary, PublicCreatorPackStore,
  SetCreatorPackStickerEnabledResult,
} from '../domain/sticker-creator-pack.js';

// Mirrors sticker-catalogue-store.ts's inUserTransaction exactly — RLS/
// has_channel_role checks inside app_private.*_creator_pack_* need
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

export function createSqlCreatorPackStore(sql: Sql): CreatorPackStore {
  return {
    async listForChannel(userId, channelId): Promise<CreatorPackStickerSummary[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        id: string; display_name: string; category: string; byte_size: number;
        enabled: boolean; status: CreatorPackStatus; creator_attested: boolean; updated_at: Date;
      }[]>`
        select id, display_name, category, byte_size, enabled, status, creator_attested, updated_at
          from app_private.list_creator_pack_for_channel(${channelId}::uuid)
      `);
      return rows.map((row) => ({
        id: row.id, displayName: row.display_name, category: row.category, byteSize: row.byte_size,
        enabled: row.enabled, status: row.status, creatorAttested: row.creator_attested,
        updatedAt: row.updated_at.toISOString(),
      }));
    },
    async upload(userId, channelId, displayName, category, assetBytes, creatorAttested): Promise<ImportCreatorPackStickerResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ outcome: string; entry_id: string; status: CreatorPackStatus }[]>`
          select outcome, entry_id, status
            from app_private.import_creator_pack_sticker(${channelId}::uuid, ${displayName}, ${category}, ${assetBytes}, ${creatorAttested})
        `);
        const row = rows[0];
        if (!row) return { outcome: 'invalid', reason: 'no result from import' };
        return { outcome: 'created', id: row.entry_id, status: row.status };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'not available at this channel')) return { outcome: 'tier_not_eligible' };
        if (isPgErrorWithMessage(error, 'attestation is required')) return { outcome: 'attestation_required' };
        if (isPgErrorWithMessage(error, 'limit reached')) return { outcome: 'limit_reached' };
        if (isPgErrorWithMessage(error, 'invalid creator-pack')) return { outcome: 'invalid', reason: 'invalid creator-pack upload' };
        throw error;
      }
    },
    async setEnabled(userId, channelId, packStickerId, enabled): Promise<SetCreatorPackStickerEnabledResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ set_creator_pack_sticker_enabled: boolean }[]>`
          select app_private.set_creator_pack_sticker_enabled(${channelId}::uuid, ${packStickerId}::uuid, ${enabled})
        `);
        const result = rows[0]?.set_creator_pack_sticker_enabled;
        return result === undefined ? { outcome: 'not_found' } : { outcome: 'ok', enabled: result };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'unknown creator-pack sticker')) return { outcome: 'not_found' };
        throw error;
      }
    },
  };
}

export function createSqlPublicCreatorPackStore(sql: Sql): PublicCreatorPackStore {
  return {
    async listEnabledForChannel(channelId): Promise<PublicCreatorPackStickerSummary[]> {
      const rows = await sql<{ id: string; display_name: string; category: string }[]>`
        select id, display_name, category
          from app_private.list_public_creator_pack_for_channel(${channelId}::uuid)
      `;
      return rows.map((row) => ({ id: row.id, displayName: row.display_name, category: row.category }));
    },
  };
}

export function createSqlCreatorPackSelectionStore(sql: Sql): CreatorPackSelectionStore {
  return {
    async attach(channelId, orderId, packStickerId): Promise<AttachCreatorPackStickerResult> {
      try {
        const rows = await sql<{ attach_creator_pack_sticker_to_tip: string }[]>`
          select app_private.attach_creator_pack_sticker_to_tip(${channelId}::uuid, ${orderId}::uuid, ${packStickerId}::uuid)
        `;
        const selectionId = rows[0]?.attach_creator_pack_sticker_to_tip;
        return selectionId ? { outcome: 'attached', selectionId } : { outcome: 'unknown_order' };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'unknown tip order')) return { outcome: 'unknown_order' };
        if (isPgErrorWithMessage(error, 'not yet paid')) return { outcome: 'order_not_paid' };
        if (isPgErrorWithMessage(error, 'unknown creator-pack sticker')) return { outcome: 'unknown_pack_sticker' };
        if (isPgErrorWithMessage(error, 'not available for this channel')) return { outcome: 'not_available' };
        if (isPgErrorWithMessage(error, 'already attached')) return { outcome: 'already_attached' };
        throw error;
      }
    },
  };
}
