import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { PaymentAccount, PaymentAccountStore } from '../domain/payment-account.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  }) as T;
}

function fromRow(row: { account_id: string; channel_id: string; provider: 'razorpay'; environment: 'test' | 'live'; connected_account_ref: string; status: PaymentAccount['status']; created_at: Date; updated_at: Date; revoked_at: Date | null }): PaymentAccount {
  return {
    schemaVersion: 'v1', accountId: row.account_id, channelId: row.channel_id,
    provider: row.provider, environment: row.environment,
    connectedAccountRef: row.connected_account_ref, status: row.status,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

export function createSqlPaymentAccountStore(sql: Sql): PaymentAccountStore {
  return {
    async list(userId, channelId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<Parameters<typeof fromRow>[0][]>`
          select account_id, channel_id, provider, environment, connected_account_ref,
                 status, created_at, updated_at, revoked_at
            from app_private.get_creator_payment_accounts(${channelId}::uuid)
        `;
        return rows.map(fromRow);
      });
    },
    async register(userId, channelId, environment, connectedAccountRef) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<Parameters<typeof fromRow>[0][]>`
          select account_id, channel_id, provider, environment, connected_account_ref,
                 status, created_at, updated_at, revoked_at
            from app_private.register_creator_payment_account(
              ${randomUUID()}::uuid, ${channelId}::uuid, ${userId}::uuid,
              ${environment}, ${connectedAccountRef}
            )
        `;
        if (!rows[0]) throw new Error('Payment account registration returned no row');
        return fromRow(rows[0]);
      });
    },
    async revoke(userId, channelId, environment) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ revoked: boolean }[]>`
          select app_private.revoke_creator_payment_account(
            ${channelId}::uuid, ${userId}::uuid, ${environment}
          ) as revoked
        `;
        return rows[0]?.revoked ?? false;
      });
    },
    async skipOnboarding(userId, channelId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ skipped_at: Date }[]>`
          select app_private.skip_payout_onboarding(${channelId}::uuid, ${userId}::uuid) as skipped_at
        `;
        const row = rows[0];
        if (!row) throw new Error('Payout onboarding skip returned no row');
        return row.skipped_at.toISOString();
      });
    },
  };
}
