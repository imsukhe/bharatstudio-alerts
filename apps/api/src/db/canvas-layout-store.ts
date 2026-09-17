import type { Sql, TransactionSql } from 'postgres';
import type {
  CanvasLayout,
  CanvasLayoutStore,
  ChannelCanvasLayout,
  SetCanvasLayoutResult,
} from '../domain/canvas-layout-store.js';

// PRF-02 slice 7, creator side of §6 module #14 (migration 0147).
//
// WIRED TO THE MAIN `sql` POOL, NOT `derivedReadSql` -- the same
// deliberate structural choice db/qr-smart-card-store.ts's own header
// records: this file carries the creator WRITE path (set) plus the
// creator's own read of the current layout, the same shape every other
// creator-facing store in this directory has, all constructed with
// `sql` in apps/api/src/index.ts.
//
// The overlay-facing read lives in its own file
// (db/canvas-layout-overlay-store.ts) precisely so that it CAN be wired
// to `derivedReadSql` and CAN be seen by every rule of
// scan-required-queries.mjs -- see that file's own header.

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

type LayoutRow = {
  layout: CanvasLayout;
  vertical_entitled: boolean;
};

function toChannelLayout(row: LayoutRow): ChannelCanvasLayout {
  return {
    schemaVersion: 'v1',
    layout: row.layout,
    verticalEntitled: row.vertical_entitled,
  };
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

export function createSqlCanvasLayoutStore(sql: Sql): CanvasLayoutStore {
  async function readCurrent(userId: string, channelId: string): Promise<ChannelCanvasLayout | null> {
    const rows = await inUserTransaction(sql, userId, (tx) => tx<LayoutRow[]>`
      select layout, vertical_entitled
        from app_private.get_channel_canvas_layout(${channelId}::uuid)
    `);
    const row = rows[0];
    return row ? toChannelLayout(row) : null;
  }

  return {
    getCurrent: readCurrent,

    async set(userId, channelId, layout): Promise<SetCanvasLayoutResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.set_channel_canvas_layout(${channelId}::uuid, ${userId}::uuid, ${layout})
        `);
      } catch (error) {
        // 42501 = insufficient_privilege, raised for a non-owner/admin
        //         or a channel that does not exist / is closed.
        // 22023 = invalid_parameter_value, raised for a layout outside
        //         ('horizontal', 'vertical').
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const channelLayout = await readCurrent(userId, channelId);
      return channelLayout ? { outcome: 'ok', channelLayout } : { outcome: 'invalid' };
    },
  };
}
