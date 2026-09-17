import type { Sql, TransactionSql } from 'postgres';
import type {
  CreateSafetyCorpusTermInput,
  CreateSafetyCorpusTermResult,
  DeleteSafetyCorpusTermResult,
  SafetyCorpusStore,
  SafetyCorpusTerm,
} from '../domain/safety-corpus-store.js';
import type { ModeratorReviewDecisionValue, SafetyDecisionValue } from '../domain/safety-pipeline.js';

// SAF phase 1 (migration 0151). TWO POOLS, deliberately, in one file --
// this store has no overlay counterpart to split the read half into (the
// pattern every other dual-pool surface in this codebase uses, e.g.
// db/canvas-layout-store.ts vs db/canvas-layout-overlay-store.ts), and a
// corpus list is exactly the kind of bounded, statement-timeout-bearing
// RT-10/RT-11 dashboard read `derivedReadSql` exists for (the same
// justification migration 0149's capability store already established
// for a read with no overlay session anywhere near it). `create`/
// `remove` are WRITES and stay on the main `sql` pool, matching every
// other creator-facing mutation in this codebase.
export function createSqlSafetyCorpusStore(sql: Sql, derivedReadSql: Sql): SafetyCorpusStore {
  async function inUserTransaction<T>(pool: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
    const result = await pool.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${userId}, true)`;
      return callback(tx);
    });
    return result as T;
  }

  function isPgErrorWithMessage(error: unknown, substring: string): boolean {
    return error instanceof Error && error.message.includes(substring);
  }

  type CorpusTermRow = {
    id: string;
    channel_id: string | null;
    term: string;
    whole_word: boolean;
    display_decision: SafetyDecisionValue;
    tts_decision: SafetyDecisionValue;
    moderator_review_decision: ModeratorReviewDecisionValue;
    created_at: Date;
  };

  function toSafetyCorpusTerm(row: CorpusTermRow): SafetyCorpusTerm {
    return {
      schemaVersion: 'v1',
      termId: row.id,
      scope: row.channel_id === null ? 'global' : 'channel',
      term: row.term,
      wholeWord: row.whole_word,
      displayDecision: row.display_decision,
      ttsDecision: row.tts_decision,
      moderatorReviewDecision: row.moderator_review_decision,
      createdAt: row.created_at.toISOString(),
    };
  }

  return {
    // Wired to `derivedReadSql` -- see this file's own header. Caught by
    // RT-12's composition-root scan rule (apps/api/src/index.ts
    // constructs this factory with derivedReadSql, apps/api/src/db is
    // this file's own directory), manifested in
    // packages/db/explain-plans/required-queries.json.
    async list(userId, channelId): Promise<SafetyCorpusTerm[]> {
      const rows = await inUserTransaction(derivedReadSql, userId, (tx) => tx<CorpusTermRow[]>`
        select id, channel_id, term, whole_word, display_decision, tts_decision, moderator_review_decision, created_at
          from app_private.get_safety_corpus_terms(${channelId}::uuid)
      `);
      return rows.map(toSafetyCorpusTerm);
    },

    async create(userId, channelId, input: CreateSafetyCorpusTermInput): Promise<CreateSafetyCorpusTermResult> {
      let newId: string | undefined;
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ create_safety_corpus_term: string }[]>`
          select app_private.create_safety_corpus_term(
            ${channelId}::uuid, ${input.term}, ${input.wholeWord ?? true},
            ${input.displayDecision}, ${input.ttsDecision}, ${input.moderatorReviewDecision}
          )
        `);
        newId = rows[0]?.create_safety_corpus_term;
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'duplicate key value')) return { outcome: 'duplicate' };
        if (isPgErrorWithMessage(error, 'violates check constraint')) return { outcome: 'invalid' };
        throw error;
      }
      if (!newId) return { outcome: 'invalid' };

      const rows = await inUserTransaction(sql, userId, (tx) => tx<CorpusTermRow[]>`
        select id, channel_id, term, whole_word, display_decision, tts_decision, moderator_review_decision, created_at
          from app_private.get_safety_corpus_terms(${channelId}::uuid)
         where id = ${newId}::uuid
      `);
      const row = rows[0];
      return row ? { outcome: 'created', term: toSafetyCorpusTerm(row) } : { outcome: 'invalid' };
    },

    async remove(userId, channelId, termId): Promise<DeleteSafetyCorpusTermResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.delete_safety_corpus_term(${channelId}::uuid, ${termId}::uuid)
        `);
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'safety corpus term not found')) return { outcome: 'not_found' };
        throw error;
      }
      return { outcome: 'ok' };
    },
  };
}
