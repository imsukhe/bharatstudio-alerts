import type { Sql, TransactionSql } from 'postgres';
import {
  CapabilityKillEventError,
  type CapabilityKillEvent,
  type CapabilityKillEventStore,
  type FireGlobalKillInput,
  type KillExtensionRequest,
  type ProposeKillExtensionInput,
} from '../domain/capability-kill-events.js';

// Migration 0155, Job 2. Same session-scoped-transaction pattern as
// apps/api/src/db/capability-change-management-store.ts. Writes -- takes
// the MAIN pool, never derivedReadSql.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function hasSqlstate(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : '';
}

// Classifies the SQLSTATEs packages/db/migrations/
// 0155_v1_ctl_emergency_kill_and_owner.sql's Job 2 functions can raise
// into exactly one CapabilityKillEventErrorReason. Message-text matching
// where one SQLSTATE covers several distinct business outcomes -- the
// same technique apps/api/src/db/capability-change-management-store.ts
// already uses for 22023.
function classify(error: unknown): CapabilityKillEventError {
  const message = errorMessage(error);
  if (hasSqlstate(error, '55000')) return new CapabilityKillEventError('blocked_on_missing_review', message);
  if (hasSqlstate(error, '23505')) return new CapabilityKillEventError('duplicate_action', message);
  if (hasSqlstate(error, '42501')) return new CapabilityKillEventError('self_action_forbidden', message);
  if (hasSqlstate(error, '23514')) return new CapabilityKillEventError('invalid_input', message);
  if (message.includes('does not exist')) return new CapabilityKillEventError('capability_not_found', message);
  if (message.includes('kill event not found')) return new CapabilityKillEventError('kill_event_not_found', message);
  if (message.includes('extension request not found')) return new CapabilityKillEventError('extension_request_not_found', message);
  return new CapabilityKillEventError('invalid_input', message);
}

type KillEventRow = {
  id: string;
  capability_key: string;
  fired_by: string;
  fired_at: Date;
  reason: string;
  affected_channel_count: number;
  live_channel_count: number;
  expires_at: Date;
  ratified_by: string | null;
  ratified_at: Date | null;
  escalated_to_owner: boolean;
  reverted: boolean;
  reviewed: boolean;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_text: string | null;
};

function fromRow(row: KillEventRow): CapabilityKillEvent {
  return {
    schemaVersion: 'v1',
    id: row.id,
    capabilityKey: row.capability_key,
    firedBy: row.fired_by,
    firedAt: row.fired_at.toISOString(),
    reason: row.reason,
    affectedChannelCount: row.affected_channel_count,
    liveChannelCount: row.live_channel_count,
    expiresAt: row.expires_at.toISOString(),
    ratifiedBy: row.ratified_by,
    ratifiedAt: row.ratified_at ? row.ratified_at.toISOString() : null,
    escalatedToOwner: row.escalated_to_owner,
    reverted: row.reverted,
    reviewed: row.reviewed,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
    reviewText: row.review_text,
  };
}

export function createSqlCapabilityKillEventStore(sql: Sql): CapabilityKillEventStore {
  return {
    async fireKill(userId, input): Promise<CapabilityKillEvent> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<KillEventRow[]>`
          select id, capability_key, fired_by, fired_at, reason, affected_channel_count, live_channel_count,
                 expires_at, ratified_by, ratified_at, escalated_to_owner, reverted, reviewed, reviewed_by,
                 reviewed_at, review_text
            from app_private.staff_fire_global_kill(
              ${input.capabilityKey}, ${input.reason}, ${input.affectedChannelCount}, ${input.liveChannelCount}
            )
        `);
        const row = rows[0];
        if (!row) throw new CapabilityKillEventError('invalid_input', 'fire returned no row');
        return fromRow(row);
      } catch (error) {
        if (error instanceof CapabilityKillEventError) throw error;
        throw classify(error);
      }
    },
    async ratifyKill(userId, killEventId): Promise<CapabilityKillEvent> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<KillEventRow[]>`
          select id, capability_key, fired_by, fired_at, reason, affected_channel_count, live_channel_count,
                 expires_at, ratified_by, ratified_at, escalated_to_owner, reverted, reviewed, reviewed_by,
                 reviewed_at, review_text
            from app_private.staff_ratify_kill_event(${killEventId}::uuid)
        `);
        const row = rows[0];
        if (!row) throw new CapabilityKillEventError('kill_event_not_found', 'ratify returned no row');
        return fromRow(row);
      } catch (error) {
        if (error instanceof CapabilityKillEventError) throw error;
        throw classify(error);
      }
    },
    async proposeExtension(userId, input): Promise<KillExtensionRequest> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{
          id: string; kill_event_id: string; requested_by: string; requested_at: Date; new_expires_at: Date; reason: string;
        }[]>`
          select id, kill_event_id, requested_by, requested_at, new_expires_at, reason
            from app_private.staff_propose_kill_extension(${input.killEventId}::uuid, ${input.newExpiresAt}, ${input.reason})
        `);
        const row = rows[0];
        if (!row) throw new CapabilityKillEventError('invalid_input', 'propose extension returned no row');
        return {
          id: row.id, killEventId: row.kill_event_id, requestedBy: row.requested_by,
          requestedAt: row.requested_at.toISOString(), newExpiresAt: row.new_expires_at.toISOString(), reason: row.reason,
        };
      } catch (error) {
        if (error instanceof CapabilityKillEventError) throw error;
        throw classify(error);
      }
    },
    async approveExtension(userId, extensionRequestId): Promise<CapabilityKillEvent> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<KillEventRow[]>`
          select id, capability_key, fired_by, fired_at, reason, affected_channel_count, live_channel_count,
                 expires_at, ratified_by, ratified_at, escalated_to_owner, reverted, reviewed, reviewed_by,
                 reviewed_at, review_text
            from app_private.staff_approve_kill_extension(${extensionRequestId}::uuid)
        `);
        const row = rows[0];
        if (!row) throw new CapabilityKillEventError('extension_request_not_found', 'approve extension returned no row');
        return fromRow(row);
      } catch (error) {
        if (error instanceof CapabilityKillEventError) throw error;
        throw classify(error);
      }
    },
    async fileReview(userId, killEventId, reviewText): Promise<CapabilityKillEvent> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<KillEventRow[]>`
          select id, capability_key, fired_by, fired_at, reason, affected_channel_count, live_channel_count,
                 expires_at, ratified_by, ratified_at, escalated_to_owner, reverted, reviewed, reviewed_by,
                 reviewed_at, review_text
            from app_private.staff_file_kill_review(${killEventId}::uuid, ${reviewText})
        `);
        const row = rows[0];
        if (!row) throw new CapabilityKillEventError('kill_event_not_found', 'file review returned no row');
        return fromRow(row);
      } catch (error) {
        if (error instanceof CapabilityKillEventError) throw error;
        throw classify(error);
      }
    },
    async getKillEvent(userId, killEventId): Promise<CapabilityKillEvent | null> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<KillEventRow[]>`
        select id, capability_key, fired_by, fired_at, reason, affected_channel_count, live_channel_count,
               expires_at, ratified_by, ratified_at, escalated_to_owner, reverted, reviewed, reviewed_by,
               reviewed_at, review_text
          from app_private.staff_get_kill_event(${killEventId}::uuid)
      `);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async listKillEvents(userId, capabilityKey, limit): Promise<CapabilityKillEvent[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<KillEventRow[]>`
        select id, capability_key, fired_by, fired_at, reason, affected_channel_count, live_channel_count,
               expires_at, ratified_by, ratified_at, escalated_to_owner, reverted, reviewed, reviewed_by,
               reviewed_at, review_text
          from app_private.staff_list_kill_events(${capabilityKey}, ${limit})
      `);
      return rows.map(fromRow);
    },
  };
}
