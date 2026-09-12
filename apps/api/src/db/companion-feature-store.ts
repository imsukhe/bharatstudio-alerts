import type { Sql, TransactionSql } from 'postgres';
import type {
  CompanionFeatureStore,
  CompanionPaymentStatusItem,
  CompanionPaymentStatusView,
  CompanionRecentTipItem,
  CompanionRecentTipsView,
  CompanionTestReport,
  CompanionTestReportHop,
  CompanionTtsCancelResult,
  CompanionTtsMuteState,
} from '../domain/companion-feature-store.js';

// Same convention as apps/api/src/db/alert-store.ts's own inUserTransaction
// (unowned/unchanged; not imported from there because that file exports no
// such helper -- this is a small, deliberate duplication rather than an
// edit to a file outside this task's ownership).
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

export function createSqlCompanionFeatureStore(sql: Sql): CompanionFeatureStore {
  return {
    async setCompanionTtsMuted(userId, channelId, queueId, muted) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ queue_id: string; tts_muted: boolean; tts_muted_at: Date | null }[]>`
        select queue_id, tts_muted, tts_muted_at
          from app_private.set_companion_tts_mute(${channelId}::uuid, ${userId}::uuid, ${queueId}::uuid, ${muted})
      `);
      const row = rows[0];
      if (!row) throw new Error('Companion TTS mute was not accepted');
      return { schemaVersion: 'v1', queueId: row.queue_id, ttsMuted: row.tts_muted, ttsMutedAt: row.tts_muted_at?.toISOString() ?? null };
    },
    async cancelCompanionTts(userId, channelId, deliveryId) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ delivery_id: string; event_id: string; status: 'tts_cancelled'; cancelled_at: Date }[]>`
        select delivery_id, event_id, status, cancelled_at
          from app_private.cancel_companion_tts_delivery(${channelId}::uuid, ${userId}::uuid, ${deliveryId}::uuid)
      `);
      const row = rows[0];
      if (!row) return null;
      return { schemaVersion: 'v1', deliveryId: row.delivery_id, eventId: row.event_id, status: row.status, cancelledAt: row.cancelled_at.toISOString() };
    },
    async getCompanionTestReport(userId, channelId, eventId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const hopRows = await tx<{ hop: string; status: string; occurred_at: Date | null; detail: string | null }[]>`
          select hop, status, occurred_at, detail
            from app_private.get_companion_test_report(${channelId}::uuid, ${eventId}::uuid)
        `;
        const ttsRows = await tx<{ hop: string; status: string; occurred_at: Date | null; detail: string | null }[]>`
          select hop, status, occurred_at, detail
            from app_private.get_companion_test_report_tts_hop(${channelId}::uuid, ${eventId}::uuid)
        `;
        if (hopRows.length === 0 && ttsRows.length === 0) return null;
        const hops: CompanionTestReportHop[] = [...hopRows, ...ttsRows].map((row) => ({
          hop: row.hop, status: row.status, occurredAt: row.occurred_at?.toISOString() ?? null, detail: row.detail,
        }));
        const result: CompanionTestReport = { schemaVersion: 'v1', channelId, eventId, hops };
        return result;
      });
    },
    async getCompanionPaymentStatus(userId, channelId, limit) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        payment_id: string; status: string; gross_amount_paise: number; currency: string;
        refund_status: string | null; refund_amount_paise: number | null; created_at: Date; updated_at: Date;
      }[]>`
        select payment_id, status, gross_amount_paise, currency, refund_status, refund_amount_paise, created_at, updated_at
          from app_private.get_companion_payment_status(${channelId}::uuid, ${limit})
      `);
      const items: CompanionPaymentStatusItem[] = rows.map((row) => ({
        paymentId: row.payment_id, status: row.status, grossAmountPaise: row.gross_amount_paise, currency: row.currency,
        refundStatus: row.refund_status, refundAmountPaise: row.refund_amount_paise,
        createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      }));
      const result: CompanionPaymentStatusView = { schemaVersion: 'v1', channelId, items };
      return result;
    },
    async getCompanionRecentTips(userId, channelId, limit) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        event_id: string; display_name: string | null; message: string | null;
        gross_amount_paise: number | null; currency: string | null; created_at: Date;
      }[]>`
        select event_id, display_name, message, gross_amount_paise, currency, created_at
          from app_private.get_companion_recent_tips(${channelId}::uuid, ${limit})
      `);
      const items: CompanionRecentTipItem[] = rows.map((row) => ({
        eventId: row.event_id, displayName: row.display_name, message: row.message,
        grossAmountPaise: row.gross_amount_paise, currency: row.currency, createdAt: row.created_at.toISOString(),
      }));
      const result: CompanionRecentTipsView = { schemaVersion: 'v1', channelId, items };
      return result;
    },
  };
}
