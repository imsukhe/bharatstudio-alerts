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
  PublicPaidVoteDefinition,
  PublicPaidVoteStore,
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
type PublicPaidVoteRowDb = { definition_id: string; label: string; option_key: string; option_label: string };

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
// exists) lives inside the SECURITY DEFINER function. A selected invalid tag
// is distinct from an unavailable database: the route must never label a
// temporary outage as a stale viewer selection.
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
      } catch (error) {
        // PostgreSQL exposes stable SQLSTATEs for caller-invalid procedure
        // input (the migration raises 22023/23503/42501/P0002); anything
        // else is operational and must remain retryable to the public route.
        const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : undefined;
        return code === '22023' || code === '23503' || code === '42501' || code === 'P0002'
          ? { outcome: 'invalid' }
          : { outcome: 'unavailable' };
      }
    },
  };
}

export function createSqlPublicPaidVoteStore(sql: Sql): PublicPaidVoteStore {
  return {
    async listForChannel(channelId): Promise<PublicPaidVoteDefinition[]> {
      const rows = await sql<PublicPaidVoteRowDb[]>`
        select definition_id, label, option_key, option_label
          from app_private.list_public_paid_support_votes(${channelId}::uuid)
      `;
      const definitions = new Map<string, PublicPaidVoteDefinition>();
      for (const row of rows) {
        const existing = definitions.get(row.definition_id);
        if (existing) existing.options.push({ optionKey: row.option_key, label: row.option_label });
        else definitions.set(row.definition_id, { definitionId: row.definition_id, label: row.label, options: [{ optionKey: row.option_key, label: row.option_label }] });
      }
      return [...definitions.values()];
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
