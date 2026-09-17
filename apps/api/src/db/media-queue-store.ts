import type { Sql, TransactionSql } from 'postgres';
import type {
  EnqueueMediaQueueItemInput,
  EnqueueMediaQueueItemResult,
  MediaQueueItem,
  MediaQueueStore,
  SetMediaQueueItemStatusResult,
  UpdateMediaQueueItemResult,
} from '../domain/media-queue-store.js';

// PRF-02 slice 7, creator side of §6 module #20 (migration 0146).
//
// WIRED TO THE MAIN `sql` POOL, NOT `derivedReadSql` -- the identical
// structural position db/giveaway-tournament-store.ts, db/lobby-status-
// store.ts and db/stream-mission-store.ts occupy. This file carries the
// creator WRITE paths plus the creator's own durable read. The overlay-
// facing read lives in its own file (db/media-queue-overlay-store.ts)
// precisely so it CAN be wired to derivedReadSql and CAN be seen by every
// rule of scan-required-queries.mjs -- see that file's own header.
//
// NO TIER CHECK EXISTS IN THIS FILE, AND NONE MAY BE ADDED (§12.6). The
// only gate is the role gate, and it lives in SQL:
// app_private.has_channel_role(channel, ['owner','admin']) inside
// migration 0146's own functions. No scoping decision is made in
// TypeScript.
//
// THIS IS THE ONLY WRITE PATH FOR public.media_queue_items. There is no
// submission endpoint, no approval queue and no viewer-facing write
// anywhere in this codebase -- see migration 0146's own header for the
// structural proof and packages/db/tests/prf02_slice7_media_queue.sql's
// MED20.1 for the test that would catch one being added later.

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

type MediaQueueItemRow = {
  media_queue_item_id: string;
  title: string;
  media_kind: string;
  mime_type: string;
  storage_url: string;
  thumbnail_url: string | null;
  duration_ms: number | null;
  status: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

function toItem(row: MediaQueueItemRow): MediaQueueItem {
  return {
    schemaVersion: 'v1',
    mediaQueueItemId: row.media_queue_item_id,
    title: row.title,
    mediaKind: row.media_kind as MediaQueueItem['mediaKind'],
    mimeType: row.mime_type,
    storageUrl: row.storage_url,
    thumbnailUrl: row.thumbnail_url,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    status: row.status as MediaQueueItem['status'],
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

// Same convention as db/goal-store.ts, db/challenge-store.ts and others:
// migration 0146 raises 22023 for every field-validation failure AND for
// both configured-but-unset caps being exceeded, so the errcode alone
// cannot distinguish "the queue is at its configured limit" from "that
// title/mime type/url was invalid". The raised message text can, and
// migration 0146's enqueue_media_queue_item raises the literal string
// 'media queue item limit reached' for exactly that case.
function isPgErrorWithMessage(error: unknown, substring: string): boolean {
  return error instanceof Error && error.message.includes(substring);
}

export function createSqlMediaQueueStore(sql: Sql): MediaQueueStore {
  async function readItems(userId: string, channelId: string, limit?: number): Promise<MediaQueueItem[]> {
    const rows = await inUserTransaction(sql, userId, (tx) => tx<MediaQueueItemRow[]>`
      select media_queue_item_id, title, media_kind, mime_type, storage_url, thumbnail_url,
             duration_ms, status, enabled, created_at, updated_at
        from app_private.list_channel_media_queue_items(${channelId}::uuid, ${limit ?? null})
    `);
    return rows.map(toItem);
  }

  async function readOneItem(userId: string, channelId: string, itemId: string): Promise<MediaQueueItem | null> {
    // list_channel_media_queue_items is the ONE creator read function
    // (migration 0146); a single item is read back by filtering its
    // output rather than adding a second read function for the same
    // table.
    const rows = await readItems(userId, channelId, 100);
    return rows.find((item) => item.mediaQueueItemId === itemId) ?? null;
  }

  return {
    listItems: readItems,

    async enqueueItem(userId, channelId, input: EnqueueMediaQueueItemInput): Promise<EnqueueMediaQueueItemResult> {
      let newId: string | undefined;
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ enqueue_media_queue_item: string }[]>`
          select app_private.enqueue_media_queue_item(
            ${channelId}::uuid, ${input.title}, ${input.mediaKind}, ${input.mimeType}, ${input.storageUrl},
            ${input.thumbnailUrl ?? null}, ${input.durationMs ?? null},
            ${input.maxDurationMs ?? null}, ${input.maxQueueItems ?? null}
          ) as enqueue_media_queue_item
        `);
        newId = rows[0]?.enqueue_media_queue_item;
      } catch (error) {
        // 42501 = insufficient_privilege, raised for a non-owner/admin.
        // 22023 = invalid_parameter_value, raised for every field
        //         validation AND for both configured-but-unset caps being
        //         exceeded. The errcode alone cannot tell those apart, so
        //         the queue-item-count cap is distinguished by its exact
        //         raised message text (isPgErrorWithMessage, above,
        //         matching migration 0146's literal
        //         'media queue item limit reached' string) and mapped to
        //         'limit_reached'; every other 22023 -- including the
        //         duration cap, which the route layer's own JSON-schema
        //         bound catches for most shapes before this is ever
        //         reached -- surfaces as 'invalid'.
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, '22023') && isPgErrorWithMessage(error, 'media queue item limit reached')) {
          return { outcome: 'limit_reached' };
        }
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      if (!newId) return { outcome: 'invalid' };
      const item = await readOneItem(userId, channelId, newId);
      return item ? { outcome: 'ok', item } : { outcome: 'invalid' };
    },

    async updateItem(userId, channelId, itemId, title, enabled): Promise<UpdateMediaQueueItemResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.update_media_queue_item(${channelId}::uuid, ${itemId}::uuid, ${title}, ${enabled}::boolean)
        `);
      } catch (error) {
        // P0002 = no_data_found, raised for an item that does not exist,
        //         belongs to another channel, OR that the caller is not
        //         authorised to write -- one indistinguishable answer.
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const item = await readOneItem(userId, channelId, itemId);
      return item ? { outcome: 'ok', item } : { outcome: 'not_found' };
    },

    async setItemStatus(userId, channelId, itemId, status): Promise<SetMediaQueueItemStatusResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.set_media_queue_item_status(${channelId}::uuid, ${itemId}::uuid, ${status})
        `);
      } catch (error) {
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const item = await readOneItem(userId, channelId, itemId);
      return item ? { outcome: 'ok', item } : { outcome: 'not_found' };
    },
  };
}
