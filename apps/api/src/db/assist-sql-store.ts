import type { Sql, TransactionSql } from 'postgres';
import type {
  AssistConfirmation,
  AssistDecision,
  AssistStore,
  AssistSuggestion,
  AssistSuggestionAudit,
  AssistSurface,
  ChannelRole,
  CreateAssistSuggestionInput,
  CreateAssistSuggestionResult,
  DecideAssistSuggestionInput,
  DecideAssistSuggestionResult,
} from '../domain/assist-types.js';

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

type SuggestionRow = {
  suggestion_id: string;
  surface: AssistSurface;
  status: AssistSuggestion['status'];
  suggested_payload: Record<string, unknown>;
  basis: string;
  requested_by_user_id: string;
  created_at: Date;
  decided_at: Date | null;
};

function toSuggestion(channelId: string, row: SuggestionRow): AssistSuggestion {
  return {
    schemaVersion: 'v1',
    suggestionId: row.suggestion_id,
    channelId,
    surface: row.surface,
    status: row.status,
    suggestedPayload: row.suggested_payload,
    basis: row.basis,
    requestedByUserId: row.requested_by_user_id,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
  };
}

type ConfirmationRow = {
  confirmation_id: string;
  suggestion_id: string;
  decision: AssistDecision;
  decided_by_user_id: string;
  decided_by_role: ChannelRole;
  applied_payload: Record<string, unknown> | null;
  decided_at: Date;
};

function toConfirmation(row: ConfirmationRow): AssistConfirmation {
  return {
    schemaVersion: 'v1',
    confirmationId: row.confirmation_id,
    suggestionId: row.suggestion_id,
    decision: row.decision,
    decidedByUserId: row.decided_by_user_id,
    decidedByRole: row.decided_by_role,
    appliedPayload: row.applied_payload,
    decidedAt: row.decided_at.toISOString(),
  };
}

export function createSqlAssistStore(sql: Sql): AssistStore {
  return {
    async create(userId, channelId, input: CreateAssistSuggestionInput): Promise<CreateAssistSuggestionResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ create_assist_suggestion: string }[]>`
          select app_private.create_assist_suggestion(
            ${channelId}::uuid, ${input.surface}, ${JSON.stringify(input.suggestedPayload)}::jsonb, ${input.basis}
          )
        `);
        const suggestionId = rows[0]?.create_assist_suggestion;
        if (!suggestionId) return { outcome: 'invalid' };
        const list = await this.list(userId, channelId);
        const created = list.find((item) => item.suggestionId === suggestionId);
        if (!created) return { outcome: 'invalid' };
        return { outcome: 'created', suggestion: created };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'assist is not enabled for this channel')) return { outcome: 'tier_not_entitled' };
        if (isPgErrorWithMessage(error, 'invalid assist')) return { outcome: 'invalid' };
        throw error;
      }
    },

    async list(userId, channelId): Promise<AssistSuggestion[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<SuggestionRow[]>`
        select suggestion_id, surface, status, suggested_payload, basis, requested_by_user_id, created_at, decided_at
          from app_private.list_channel_assist_suggestions(${channelId}::uuid)
      `);
      return rows.map((row) => toSuggestion(channelId, row));
    },

    async decide(userId, suggestionId, input: DecideAssistSuggestionInput): Promise<DecideAssistSuggestionResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<ConfirmationRow[]>`
          select confirmation_id, suggestion_id, decision, decided_by_user_id, decided_by_role, applied_payload, decided_at
            from app_private.decide_assist_suggestion(
              ${suggestionId}::uuid, ${input.decision}, ${input.appliedPayload ? JSON.stringify(input.appliedPayload) : null}::jsonb
            )
        `);
        const row = rows[0];
        if (!row) return { outcome: 'invalid' };
        return { outcome: 'decided', confirmation: toConfirmation(row) };
      } catch (error) {
        if (isPgErrorWithMessage(error, 'not authorized')) return { outcome: 'forbidden' };
        if (isPgErrorWithMessage(error, 'assist suggestion not found')) return { outcome: 'not_found' };
        if (isPgErrorWithMessage(error, 'assist suggestion already decided')) return { outcome: 'already_decided' };
        if (isPgErrorWithMessage(error, 'invalid')) return { outcome: 'invalid' };
        throw error;
      }
    },

    async getAudit(userId, suggestionId): Promise<AssistSuggestionAudit | null> {
      type AuditRow = SuggestionRow & {
        channel_id: string;
        confirmation_id: string | null;
        decision: AssistDecision | null;
        decided_by_user_id: string | null;
        decided_by_role: ChannelRole | null;
        applied_payload: Record<string, unknown> | null;
      };
      const rows = await inUserTransaction(sql, userId, (tx) => tx<AuditRow[]>`
        select suggestion_id, channel_id, surface, status, suggested_payload, basis, requested_by_user_id, created_at,
               confirmation_id, decision, decided_by_user_id, decided_by_role, applied_payload, decided_at
          from app_private.get_assist_suggestion_audit(${suggestionId}::uuid)
      `);
      const row = rows[0];
      if (!row) return null;
      const suggestion = toSuggestion(row.channel_id, row);
      const confirmation: AssistConfirmation | null = row.confirmation_id && row.decision && row.decided_by_user_id && row.decided_by_role
        ? {
            schemaVersion: 'v1',
            confirmationId: row.confirmation_id,
            suggestionId: row.suggestion_id,
            decision: row.decision,
            decidedByUserId: row.decided_by_user_id,
            decidedByRole: row.decided_by_role,
            appliedPayload: row.applied_payload,
            decidedAt: row.decided_at ? row.decided_at.toISOString() : suggestion.createdAt,
          }
        : null;
      return { ...suggestion, confirmation };
    },
  };
}
