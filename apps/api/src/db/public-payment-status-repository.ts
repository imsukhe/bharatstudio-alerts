import type { Sql } from 'postgres';
import type { PublicPaymentStatus, PublicPaymentStatusRepository } from '../domain/public-payment-status.js';

type PublicPaymentStatusRow = {
  order_id: string;
  status: PublicPaymentStatus['status'];
  amount_paise: number;
  currency: 'INR';
  updated_at: Date;
};

export function createPublicPaymentStatusRepository(sql: Sql): PublicPaymentStatusRepository {
  return {
    async findByOrderId(orderId) {
      const rows = await sql<PublicPaymentStatusRow[]>`
        select order_id, status, amount_paise, currency, updated_at
          from app_private.get_public_payment_status(${orderId}::uuid)
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        orderId: row.order_id,
        status: row.status,
        amountPaise: row.amount_paise,
        currency: row.currency,
        updatedAt: row.updated_at.toISOString(),
      };
    },
  };
}
