import type { Sql, TransactionSql } from 'postgres';
import type {
  QrSmartCard,
  QrSmartCardStore,
  SetQrSmartCardEnabledResult,
  UpsertQrSmartCardResult,
} from '../domain/qr-smart-card-store.js';

// PRF-02 slice 7, creator side of §6 module #10 (migration 0144).
//
// WIRED TO THE MAIN `sql` POOL, NOT `derivedReadSql` -- the same
// deliberate structural choice db/stream-mission-store.ts's own header
// records: this file carries the creator WRITE path (upsert/toggle) plus
// the creator's own read of the current card, the same shape
// goal-store.ts, challenge-store.ts and stream-mission-store.ts's
// creator half all have, and all are constructed with `sql` in
// apps/api/src/index.ts.
//
// The overlay-facing read lives in its own file
// (db/qr-smart-card-overlay-store.ts) precisely so that it CAN be wired
// to `derivedReadSql` and CAN be seen by every rule of
// scan-required-queries.mjs -- see that file's own header.

// Same convention as db/stream-mission-store.ts / db/goal-store.ts -- a
// deliberate small duplication across store files rather than importing
// across an ownership boundary.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

type CardRow = {
  destination: string;
  label: string;
  is_enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

function toCard(row: CardRow): QrSmartCard {
  return {
    schemaVersion: 'v1',
    destination: row.destination,
    label: row.label,
    isEnabled: row.is_enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

export function createSqlQrSmartCardStore(sql: Sql): QrSmartCardStore {
  async function readCurrent(userId: string, channelId: string): Promise<QrSmartCard | null> {
    const rows = await inUserTransaction(sql, userId, (tx) => tx<CardRow[]>`
      select destination, label, is_enabled, created_at, updated_at
        from app_private.list_channel_qr_smart_card(${channelId}::uuid)
    `);
    const row = rows[0];
    return row ? toCard(row) : null;
  }

  return {
    getCurrent: readCurrent,

    async upsert(userId, channelId, destination, label): Promise<UpsertQrSmartCardResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.upsert_qr_smart_card(${channelId}::uuid, ${destination}, ${label})
        `);
      } catch (error) {
        // 42501 = insufficient_privilege, raised for a non-owner/admin.
        // 22023 = invalid_parameter_value, raised for a destination or
        //         label outside the 1-120 bound.
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const card = await readCurrent(userId, channelId);
      return card ? { outcome: 'ok', card } : { outcome: 'invalid' };
    },

    async setEnabled(userId, channelId, enabled): Promise<SetQrSmartCardEnabledResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.set_qr_smart_card_enabled(${channelId}::uuid, ${enabled})
        `);
      } catch (error) {
        // P0002 = no_data_found, raised for a non-owner/admin OR for a
        // channel that has never configured a card -- one
        // indistinguishable not-found answer, by design (migration
        // 0144's header).
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        throw error;
      }
      const card = await readCurrent(userId, channelId);
      return card ? { outcome: 'ok', card } : { outcome: 'not_found' };
    },
  };
}
