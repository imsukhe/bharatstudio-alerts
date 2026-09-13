import type { Sql, TransactionSql } from 'postgres';
import type { GetVerdictResult, ReputationStore, SupporterReputationVerdict } from '../domain/reputation-store.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

type VerdictRow = {
  viewer_identity_id: string;
  verdict: 'clear' | 'flagged';
  recommended_action: 'none' | 'review_before_payout';
};

function toVerdict(row: VerdictRow): SupporterReputationVerdict {
  return {
    schemaVersion: 'v1',
    viewerIdentityId: row.viewer_identity_id,
    verdict: row.verdict,
    recommendedAction: row.recommended_action,
  };
}

// Reads only via app_private.get_supporter_reputation_verdict (0120) — the
// one function granted to bsa_app for this feature. reputation_score,
// reputation_verdict and reputation_signal_evidence are never called from
// here and are not granted to bsa_app at all; that is what keeps a creator
// route from ever being able to fetch cross-creator evidence, even by a
// future careless edit to this file.
export function createSqlReputationStore(sql: Sql): ReputationStore {
  return {
    async getVerdict(userId, channelId, viewerIdentityId): Promise<GetVerdictResult> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<VerdictRow[]>`
        select viewer_identity_id, verdict, recommended_action
          from app_private.get_supporter_reputation_verdict(${channelId}::uuid, ${viewerIdentityId}::uuid)
      `);
      const row = rows[0];
      return row ? { outcome: 'ok', verdict: toVerdict(row) } : { outcome: 'not_found' };
    },
  };
}
