import type { Sql, TransactionSql } from 'postgres';
import type {
  Challenge,
  ChallengeKind,
  ChallengeState,
  ChallengeStore,
  CreateChallengeInput,
  CreateChallengeResult,
  TransitionChallengeResult,
} from '../domain/challenge-store.js';

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

type ChallengeRow = {
  challenge_id: string;
  title: string;
  description: string | null;
  challenge_kind: ChallengeKind;
  target_amount_paise: string | number;
  state: ChallengeState;
  is_public: boolean;
  progress_paise: string | number;
  target_reached: boolean;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
};

function toChallenge(channelId: string, row: ChallengeRow): Challenge {
  return {
    schemaVersion: 'v1',
    challengeId: row.challenge_id,
    channelId,
    title: row.title,
    description: row.description,
    kind: row.challenge_kind,
    targetAmountPaise: Number(row.target_amount_paise),
    state: row.state,
    isPublic: row.is_public,
    progressPaise: Number(row.progress_paise),
    targetReached: row.target_reached,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export function createSqlChallengeStore(sql: Sql): ChallengeStore {
  return {
    async create(userId, channelId, input: CreateChallengeInput): Promise<CreateChallengeResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ create_challenge: string }[]>`
          select app_private.create_challenge(
            ${channelId}::uuid, ${input.title}, ${input.description ?? null}, ${input.kind}, ${input.targetAmountPaise}::bigint, ${input.isPublic ?? true}
          )
        `);
        const challengeId = rows[0]?.create_challenge;
        if (!challengeId) return { outcome: 'invalid' };
        const created = await this.get(userId, channelId, challengeId);
        if (!created) return { outcome: 'invalid' };
        return { outcome: 'created', challenge: created };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'challenge limit reached')) return { outcome: 'tier_limit_reached' };
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'invalid challenge')) return { outcome: 'invalid' };
        throw error;
      }
    },

    async list(userId, channelId): Promise<Challenge[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<ChallengeRow[]>`
        select challenge_id, title, description, challenge_kind, target_amount_paise, state, is_public, progress_paise, target_reached, started_at, ended_at, created_at
          from app_private.list_channel_challenges(${channelId}::uuid)
      `);
      return rows.map((row) => toChallenge(channelId, row));
    },

    async get(userId, channelId, challengeId): Promise<Challenge | null> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<ChallengeRow[]>`
        select challenge_id, title, description, challenge_kind, target_amount_paise, state, is_public, progress_paise, target_reached, started_at, ended_at, created_at
          from app_private.get_channel_challenge(${channelId}::uuid, ${challengeId}::uuid)
      `);
      const row = rows[0];
      return row ? toChallenge(channelId, row) : null;
    },

    async transition(userId, channelId, challengeId, toState): Promise<TransitionChallengeResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.transition_challenge(${channelId}::uuid, ${challengeId}::uuid, ${toState})
        `);
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'challenge not found')) return { outcome: 'not_found' };
        if (isPgErrorWithMessage(error, 'invalid challenge state transition')) return { outcome: 'invalid_transition' };
        throw error;
      }
      const updated = await this.get(userId, channelId, challengeId);
      return updated ? { outcome: 'ok', challenge: updated } : { outcome: 'not_found' };
    },
  };
}
