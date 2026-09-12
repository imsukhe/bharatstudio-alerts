// L16 gap closure (packages/db/migrations/0108). Mirrors
// db/interaction-sql-store.ts's own inUserTransaction/fingerprint/error-
// matching conventions exactly — this file owns its own copies rather than
// importing that file's (same "every *-store.ts carries its own copy"
// convention interaction-sql-store.ts itself documents).
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type {
  PaidSupportVoteStore,
  PaidVoteOverlayStore,
  PaidVoteTally,
  TagVotePaymentInput,
  TagVotePaymentResult,
  VotePaymentTagStore,
} from '../domain/vote-payment-types.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type PaidTallyRowDb = { option_key: string; label: string; amount_paise: string | number; resolved: boolean; resolved_option_key: string | null };

function toPaidTally(rows: PaidTallyRowDb[]): PaidVoteTally | null {
  const first = rows[0];
  if (!first) return null;
  return {
    schemaVersion: 'v1',
    votingMode: 'paid',
    options: rows.map((row) => ({ optionKey: row.option_key, label: row.label, amountPaise: Number(row.amount_paise) })),
    resolved: first.resolved,
    resolvedOptionKey: first.resolved_option_key,
  };
}

// Called from apps/api/src/routes/public.ts's tip-order route, before the
// payment order is created, using the same channelId/environment/
// idempotencyKey that route already computes. Public/unauthenticated —
// every real gate (definition exists, is a paid-mode support_vote, option
// exists) lives inside the SECURITY DEFINER function; an invalid/mismatched
// tag never blocks the underlying tip (see routes/public.ts's own comment
// at the call site for why a tagging failure must not fail the checkout).
export function createSqlVotePaymentTagStore(sql: Sql): VotePaymentTagStore {
  return {
    async tag(input: TagVotePaymentInput): Promise<TagVotePaymentResult> {
      try {
        await sql`
          select app_private.tag_vote_payment(
            ${input.channelId}::uuid, ${input.environment}, ${input.idempotencyKey},
            ${input.interactionDefinitionId}::uuid, ${input.optionKey}
          )
        `;
        return { outcome: 'tagged' };
      } catch {
        return { outcome: 'invalid' };
      }
    },
  };
}

export function createSqlPaidSupportVoteStore(sql: Sql): PaidSupportVoteStore {
  return {
    async tally(userId, channelId, definitionId): Promise<PaidVoteTally | null> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<PaidTallyRowDb[]>`
        select option_key, label, amount_paise, resolved, resolved_option_key
          from app_private.paid_support_vote_tally(${channelId}::uuid, ${definitionId}::uuid)
      `);
      return toPaidTally(rows);
    },
  };
}

export function createSqlPaidVoteOverlayStore(sql: Sql): PaidVoteOverlayStore {
  return {
    async getPaidVoteTally(token, overlayId, definitionId): Promise<PaidVoteTally | null> {
      const rows = await sql<PaidTallyRowDb[]>`
        select option_key, label, amount_paise, resolved, resolved_option_key
          from app_private.list_overlay_paid_vote_tally(${overlayId}::uuid, ${fingerprint(token)}, ${definitionId}::uuid)
      `;
      return toPaidTally(rows);
    },
  };
}
