import type { Sql, TransactionSql } from 'postgres';
import type { ActivationState, InsightsStore, RevenueKpis } from '../domain/insights-store.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  })) as T;
}

export function createSqlInsightsStore(sql: Sql): InsightsStore {
  return {
    async getActivationState(userId, channelId): Promise<ActivationState | null> {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{
          payout_connected: boolean; payout_connected_at: Date | null;
          overlay_connected: boolean; overlay_connected_at: Date | null;
          first_alert_fired: boolean; first_alert_fired_at: Date | null;
        }[]>`
          select payout_connected, payout_connected_at, overlay_connected, overlay_connected_at,
                 first_alert_fired, first_alert_fired_at
            from app_private.get_creator_activation_state(${channelId}::uuid)
        `;
        const row = rows[0];
        if (!row) return null;
        return {
          schemaVersion: 'v1',
          payoutConnected: row.payout_connected,
          payoutConnectedAt: row.payout_connected_at?.toISOString() ?? null,
          overlayConnected: row.overlay_connected,
          overlayConnectedAt: row.overlay_connected_at?.toISOString() ?? null,
          firstAlertFired: row.first_alert_fired,
          firstAlertFiredAt: row.first_alert_fired_at?.toISOString() ?? null,
        };
      });
    },
    async getRevenueKpis(userId, channelId, windowStart, windowEnd): Promise<RevenueKpis | null> {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{
          average_net_tip_paise: string; net_tip_count: string; total_net_tip_paise: string;
          supporter_count: string; repeat_supporter_count: string; repeat_supporter_rate: string;
          challenge_revenue_paise: string; vote_revenue_paise: string;
        }[]>`
          select average_net_tip_paise, net_tip_count, total_net_tip_paise,
                 supporter_count, repeat_supporter_count, repeat_supporter_rate,
                 challenge_revenue_paise, vote_revenue_paise
            from app_private.get_channel_revenue_kpis(
              ${channelId}::uuid, ${windowStart}::timestamptz, ${windowEnd}::timestamptz
            )
        `;
        const row = rows[0];
        if (!row) return null;
        return {
          schemaVersion: 'v1',
          windowStart, windowEnd,
          averageNetTipPaise: row.average_net_tip_paise,
          netTipCount: row.net_tip_count,
          totalNetTipPaise: row.total_net_tip_paise,
          supporterCount: row.supporter_count,
          repeatSupporterCount: row.repeat_supporter_count,
          repeatSupporterRate: row.repeat_supporter_rate,
          challengeRevenuePaise: row.challenge_revenue_paise,
          voteRevenuePaise: row.vote_revenue_paise,
        };
      });
    },
  };
}
