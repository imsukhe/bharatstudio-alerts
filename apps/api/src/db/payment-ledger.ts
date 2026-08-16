import type { Sql, TransactionSql } from 'postgres';
import type { PaymentLedgerEntry, PaymentLedgerPage, PaymentLedgerStore } from '../domain/payment-ledger.js';
import { formatHistoryCursor, parseHistoryCursor } from './history-cursor.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

export function createSqlPaymentLedgerStore(sql: Sql): PaymentLedgerStore {
  return {
    async listPayments(userId, channelId, cursor, pageSize): Promise<PaymentLedgerPage> {
      // Reuses the history cursor codec (ISO timestamp + UUID tie-breaker) —
      // the format has never depended on the id actually being an event id,
      // just any UUID paired with a timestamp for a strict descending walk.
      const parsedCursor = parseHistoryCursor(cursor);
      if (cursor !== undefined && !parsedCursor) throw new Error('invalid payments cursor');
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        payment_id: string; provider_payment_id: string; gross_amount_paise: number; currency: 'INR';
        status: PaymentLedgerEntry['status']; created_at: Date; refund_total_paise: number;
        latest_refund_status: PaymentLedgerEntry['latestRefundStatus'];
      }[]>`
        select payment_id, provider_payment_id, gross_amount_paise, currency, status, created_at, refund_total_paise, latest_refund_status
          from app_private.list_channel_payments(${channelId}::uuid, ${parsedCursor?.createdAt ?? null}::timestamptz, ${parsedCursor?.eventId ?? null}::uuid, ${pageSize})
      `);
      const items = rows.map((row): PaymentLedgerEntry => ({
        paymentId: row.payment_id, providerPaymentId: row.provider_payment_id, grossAmountPaise: row.gross_amount_paise,
        currency: row.currency, status: row.status, createdAt: row.created_at.toISOString(),
        refundTotalPaise: row.refund_total_paise, latestRefundStatus: row.latest_refund_status,
      }));
      const last = rows.at(-1);
      return { schemaVersion: 'v1', items, nextCursor: last ? formatHistoryCursor(last.created_at, last.payment_id) : null };
    },
  };
}
