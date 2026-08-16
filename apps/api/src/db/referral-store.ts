import type { Sql, TransactionSql } from 'postgres';
import type { ReferralAttributionResult, ReferralHistory, ReferralOverview, ReferralStatus, ReferralStore } from '../domain/referrals.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

export function createSqlReferralStore(sql: Sql): ReferralStore {
  return {
    async getOverview(userId, channelId): Promise<ReferralOverview> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        pending_count: number; paid_pending_hold_count: number; credited_count: number;
        flagged_or_revoked_count: number; banked_credit_days: number; lifetime_credited_days: number;
      }[]>`
        select pending_count, paid_pending_hold_count, credited_count, flagged_or_revoked_count, banked_credit_days, lifetime_credited_days
          from app_private.list_channel_referral_overview(${channelId}::uuid)
      `);
      const row = rows[0];
      return {
        schemaVersion: 'v1',
        pendingCount: row?.pending_count ?? 0,
        paidPendingHoldCount: row?.paid_pending_hold_count ?? 0,
        creditedCount: row?.credited_count ?? 0,
        flaggedOrRevokedCount: row?.flagged_or_revoked_count ?? 0,
        bankedCreditDays: row?.banked_credit_days ?? 0,
        lifetimeCreditedDays: row?.lifetime_credited_days ?? 0,
      };
    },
    async listHistory(userId, channelId): Promise<ReferralHistory> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        referral_id: string; status: ReferralStatus; attributed_at: Date; credited_at: Date | null; credit_days: number | null;
      }[]>`
        select referral_id, status, attributed_at, credited_at, credit_days
          from app_private.list_channel_referrals(${channelId}::uuid)
      `);
      return {
        schemaVersion: 'v1',
        items: rows.map((row) => ({
          referralId: row.referral_id,
          status: row.status,
          attributedAt: row.attributed_at.toISOString(),
          creditedAt: row.credited_at ? row.credited_at.toISOString() : null,
          creditDays: row.credit_days,
        })),
      };
    },
    async attribute(referredChannelId, referrerHandle, ipSubnetHash): Promise<ReferralAttributionResult> {
      // Deliberately its own top-level transaction (not inUserTransaction —
      // no app.user_id binding needed since record_referral_attribution
      // authorizes purely on the referred channel id the caller already
      // owns), so a failure here can never roll back the channel-creation
      // transaction that triggers it.
      const rows = await sql<{ result: ReferralAttributionResult }[]>`
        select result from app_private.record_referral_attribution(${referredChannelId}::uuid, ${referrerHandle}, ${ipSubnetHash})
      `;
      return rows[0]?.result ?? 'unknown_referrer_code';
    },
  };
}
