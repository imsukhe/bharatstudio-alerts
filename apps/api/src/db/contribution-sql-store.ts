import type { Sql, TransactionSql } from 'postgres';
import type {
  ContributionSourceInclusion,
  ContributionSourceStore,
  ContributionSourceType,
  ContributionTargetType,
  ListSourceInclusionsResult,
  SetSourceInclusionResult,
} from '../domain/contribution-source-types.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function isPgErrorWithMessage(error: unknown, substring: string): boolean {
  return error instanceof Error && error.message.includes(substring);
}

type SourceRow = { source_type: ContributionSourceType; included: boolean };

function toSources(rows: SourceRow[]): ContributionSourceInclusion[] {
  return rows.map((row) => ({ sourceType: row.source_type, included: row.included }));
}

export function createSqlContributionSourceStore(sql: Sql): ContributionSourceStore {
  return {
    async list(userId, channelId, targetType: ContributionTargetType, targetId): Promise<ListSourceInclusionsResult> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<SourceRow[]>`
        select source_type, included
          from app_private.list_contribution_source_inclusions(${channelId}::uuid, ${targetType}, ${targetId}::uuid)
      `);
      // The SQL function returns zero rows both when the caller lacks
      // channel access AND when the target does not belong to this
      // channel — the same "never leak which case" shape every other
      // channel-scoped read in this codebase already uses (e.g.
      // get_channel_goal). A caller cannot distinguish "forbidden" from
      // "not found" from this signal alone, by design.
      if (rows.length === 0) return { outcome: 'not_found' };
      return { outcome: 'ok', sources: toSources(rows) };
    },

    async set(userId, channelId, targetType: ContributionTargetType, targetId, sourceType: ContributionSourceType, included): Promise<SetSourceInclusionResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.set_contribution_source_inclusion(${channelId}::uuid, ${targetType}, ${targetId}::uuid, ${sourceType}, ${included})
        `);
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'target not found on this channel')) return { outcome: 'not_found' };
        if (isPgErrorWithMessage(error, 'invalid contribution source inclusion')) return { outcome: 'invalid' };
        throw error;
      }
      const updated = await this.list(userId, channelId, targetType, targetId);
      return updated.outcome === 'ok' ? updated : { outcome: 'not_found' };
    },
  };
}
