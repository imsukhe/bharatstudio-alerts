import type { Sql } from 'postgres';
import type { AttachStickerResult, PublicStickerCatalogueStore, PublicStickerSummary, StickerSelectionStore } from '../domain/sticker-catalogue.js';

// Public/unauthenticated reads and the viewer-side attach call — no
// app.user_id to set (mirrors public-payment-status-repository.ts: plain
// `sql` calls, all scoping enforced inside the security-definer function).

function isPgErrorWithMessage(error: unknown, substring: string): boolean {
  return error instanceof Error && error.message.includes(substring);
}

export function createSqlPublicStickerCatalogueStore(sql: Sql): PublicStickerCatalogueStore {
  return {
    async listEnabledForChannel(channelId): Promise<PublicStickerSummary[]> {
      const rows = await sql<{ id: string; display_name: string; category: string }[]>`
        select id, display_name, category
          from app_private.list_public_stickers_for_channel(${channelId}::uuid)
      `;
      return rows.map((row) => ({ id: row.id, displayName: row.display_name, category: row.category }));
    },
  };
}

export function createSqlStickerSelectionStore(sql: Sql): StickerSelectionStore {
  return {
    async attach(channelId, orderId, stickerId): Promise<AttachStickerResult> {
      try {
        const rows = await sql<{ attach_sticker_to_tip: string }[]>`
          select app_private.attach_sticker_to_tip(${channelId}::uuid, ${orderId}::uuid, ${stickerId}::uuid)
        `;
        const selectionId = rows[0]?.attach_sticker_to_tip;
        return selectionId ? { outcome: 'attached', selectionId } : { outcome: 'unknown_order' };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'unknown tip order')) return { outcome: 'unknown_order' };
        if (isPgErrorWithMessage(error, 'not yet paid')) return { outcome: 'order_not_paid' };
        if (isPgErrorWithMessage(error, 'unknown sticker')) return { outcome: 'unknown_sticker' };
        if (isPgErrorWithMessage(error, 'not available at this channel')) return { outcome: 'not_available' };
        if (isPgErrorWithMessage(error, 'disabled for this channel')) return { outcome: 'not_available' };
        if (isPgErrorWithMessage(error, 'already attached')) return { outcome: 'already_attached' };
        throw error;
      }
    },
  };
}
