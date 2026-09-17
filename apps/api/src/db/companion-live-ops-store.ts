import type { Sql, TransactionSql } from 'postgres';
import type {
  CompanionLiveOpsResult,
  CompanionLiveOpsStore,
  CompanionRecentAction,
  CompanionStreamMarker,
  CompanionStreamWrapSession,
  CompanionWrapPreparedItem,
} from '../domain/companion-live-ops.js';

// CMP-94/CMP-22/CMP-30 (migration 0161). WIRED TO THE MAIN `sql` POOL,
// NOT `derivedReadSql` -- the same structural choice db/safe-mode-
// store.ts records for itself: this file carries creator/moderator
// WRITE paths (create/delete marker, begin/confirm/generate wrap
// stream) alongside its reads, not a pure widget/dashboard derived
// read. RT-12: no manifest entry required and none added -- this
// file's basename contains neither "overlay" nor "master-canvas" (rule
// 2), none of its functions are `list_overlay_*` (rule 1), and
// apps/api/src/index.ts constructs it with `sql`, not `derivedReadSql`
// (rule 3).

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

function pgMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return 'request rejected';
}

// Every write path in this store raises 42501 for "not authorized" (no
// qualifying role, wrong channel, or a session identity mismatch) --
// migration 0161's own functions never distinguish those, on purpose
// (see safe-mode-store.ts's own note: a distinguishing answer would
// itself leak whether the channel exists). 22023/P0002 are this
// migration's own caller-facing rule violations (cap reached, already
// deleted, wrong wrap-session state, not found) and are safe to surface
// verbatim -- their messages carry no PII or secret.
async function runWrite<T>(fn: () => Promise<T>): Promise<CompanionLiveOpsResult<T>> {
  try {
    const value = await fn();
    return { outcome: 'ok', value };
  } catch (error) {
    if (isPgErrorWithCode(error, '42501')) return { outcome: 'not_found' };
    if (isPgErrorWithCode(error, '22023') || isPgErrorWithCode(error, 'P0002')) return { outcome: 'rejected', message: pgMessage(error) };
    throw error;
  }
}

type MarkerRow = { marker_id: string; marker_type: string; label: string; marker_at: Date; actor_user_id?: string; created_at: Date };
function toMarker(row: MarkerRow): CompanionStreamMarker {
  return {
    markerId: row.marker_id,
    markerType: row.marker_type as CompanionStreamMarker['markerType'],
    label: row.label,
    markerAt: row.marker_at.toISOString(),
    actorUserId: row.actor_user_id,
    createdAt: row.created_at.toISOString(),
  };
}

type WrapSessionRow = {
  wrap_session_id: string; status: string; obs_stopped_confirmed: boolean; broadcast_complete_confirmed: boolean;
  confirmed_stop_at: Date | null; window_since: Date | null; window_until: Date | null; summary: unknown;
  created_at: Date; updated_at: Date;
};
function toWrapSession(row: WrapSessionRow): CompanionStreamWrapSession {
  return {
    wrapSessionId: row.wrap_session_id,
    status: row.status as CompanionStreamWrapSession['status'],
    obsStoppedConfirmed: row.obs_stopped_confirmed,
    broadcastCompleteConfirmed: row.broadcast_complete_confirmed,
    confirmedStopAt: row.confirmed_stop_at?.toISOString() ?? null,
    windowSince: row.window_since?.toISOString() ?? null,
    windowUntil: row.window_until?.toISOString() ?? null,
    summary: row.summary,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createSqlCompanionLiveOpsStore(sql: Sql): CompanionLiveOpsStore {
  return {
    async createStreamMarker(userId, channelId, label, markerType, markerAt) {
      return runWrite(async () => {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<MarkerRow[]>`
          select marker_id, marker_type, label, marker_at, created_at
            from app_private.create_companion_stream_marker(${channelId}::uuid, ${userId}::uuid, ${label}, ${markerType}, ${markerAt}::timestamptz)
        `);
        const row = rows[0];
        if (!row) throw new Error('stream marker was not created');
        return toMarker(row);
      });
    },

    async deleteStreamMarker(userId, channelId, markerId) {
      return runWrite(async () => {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ marker_id: string; deleted_at: Date }[]>`
          select marker_id, deleted_at from app_private.delete_companion_stream_marker(${channelId}::uuid, ${userId}::uuid, ${markerId}::uuid)
        `);
        const row = rows[0];
        if (!row) throw new Error('stream marker was not deleted');
        return { markerId: row.marker_id, deletedAt: row.deleted_at.toISOString() };
      });
    },

    async listStreamMarkers(userId, channelId) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<MarkerRow[]>`
        select marker_id, marker_type, label, marker_at, actor_user_id, created_at
          from app_private.list_companion_stream_markers(${channelId}::uuid, null, null)
      `);
      // An empty result is ambiguous between "no markers yet" and "not a
      // member" by construction (the SQL function returns zero rows for
      // both) -- treated as ok/empty rather than not_found, matching
      // list_companion_stream_markers' own SETOF-style RETURN with no
      // separate existence probe, and because an empty marker list for a
      // channel the caller CAN see is an entirely ordinary state.
      return { outcome: 'ok', value: rows.map(toMarker) };
    },

    async getRecentActions(userId, channelId, limit) {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        action_id: string; action: string; category: string; target_type: string; target_id: string | null;
        actor_user_id: string | null; occurred_at: Date; reversible: boolean; reason: string | null;
      }[]>`
        select action_id, action, category, target_type, target_id, actor_user_id, occurred_at, reversible, reason
          from app_private.get_companion_recent_actions(${channelId}::uuid, ${limit})
      `);
      const value: CompanionRecentAction[] = rows.map((row) => ({
        actionId: row.action_id, action: row.action, category: row.category as CompanionRecentAction['category'],
        targetType: row.target_type, targetId: row.target_id, actorUserId: row.actor_user_id,
        occurredAt: row.occurred_at.toISOString(), reversible: row.reversible, reason: row.reason,
      }));
      return { outcome: 'ok', value };
    },

    async beginWrapStream(userId, channelId) {
      return runWrite(async () => {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ wrap_session_id: string; status: string; created_at: Date }[]>`
          select wrap_session_id, status, created_at from app_private.begin_companion_stream_wrap(${channelId}::uuid, ${userId}::uuid)
        `);
        const row = rows[0];
        if (!row) throw new Error('wrap stream session was not created');
        return { wrapSessionId: row.wrap_session_id, status: row.status, createdAt: row.created_at.toISOString() };
      });
    },

    async confirmWrapStreamStop(userId, channelId, wrapSessionId, obsStoppedConfirmed, broadcastCompleteConfirmed) {
      return runWrite(async () => {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ wrap_session_id: string; status: string; confirmed_stop_at: Date | null }[]>`
          select wrap_session_id, status, confirmed_stop_at
            from app_private.confirm_companion_stream_stop(${channelId}::uuid, ${userId}::uuid, ${wrapSessionId}::uuid, ${obsStoppedConfirmed}, ${broadcastCompleteConfirmed})
        `);
        const row = rows[0];
        if (!row) throw new Error('wrap stream stop was not confirmed');
        return { wrapSessionId: row.wrap_session_id, status: row.status, confirmedStopAt: row.confirmed_stop_at?.toISOString() ?? null };
      });
    },

    async generateWrapStreamSummary(userId, channelId, wrapSessionId) {
      return runWrite(async () => {
        return inUserTransaction(sql, userId, async (tx) => {
          const rows = await tx<WrapSessionRow[]>`
            select wrap_session_id, status, window_since, window_until, summary
              from app_private.generate_companion_stream_wrap_summary(${channelId}::uuid, ${userId}::uuid, ${wrapSessionId}::uuid)
          `;
          const row = rows[0];
          if (!row) throw new Error('wrap stream summary was not generated');
          const sessionRows = await tx<WrapSessionRow[]>`
            select wrap_session_id, status, obs_stopped_confirmed, broadcast_complete_confirmed, confirmed_stop_at, window_since, window_until, summary, created_at, updated_at
              from app_private.get_companion_stream_wrap_session(${channelId}::uuid, ${wrapSessionId}::uuid)
          `;
          const full = sessionRows[0];
          if (!full) throw new Error('wrap stream session was not found after summary generation');
          return toWrapSession(full);
        });
      });
    },

    async getWrapStreamSession(userId, channelId, wrapSessionId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const sessionRows = await tx<WrapSessionRow[]>`
          select wrap_session_id, status, obs_stopped_confirmed, broadcast_complete_confirmed, confirmed_stop_at, window_since, window_until, summary, created_at, updated_at
            from app_private.get_companion_stream_wrap_session(${channelId}::uuid, ${wrapSessionId}::uuid)
        `;
        const sessionRow = sessionRows[0];
        if (!sessionRow) return { outcome: 'not_found' as const };

        const itemRows = await tx<{ item_id: string; item_kind: string; fire_mode: string; content: unknown; created_at: Date }[]>`
          select item_id, item_kind, fire_mode, content, created_at
            from app_private.list_companion_wrap_prepared_items(${channelId}::uuid, ${wrapSessionId}::uuid)
        `;
        const preparedItems: CompanionWrapPreparedItem[] = itemRows.map((row) => ({
          itemId: row.item_id, itemKind: row.item_kind as CompanionWrapPreparedItem['itemKind'],
          fireMode: row.fire_mode as CompanionWrapPreparedItem['fireMode'], content: row.content, createdAt: row.created_at.toISOString(),
        }));
        return { outcome: 'ok' as const, value: { session: toWrapSession(sessionRow), preparedItems } };
      });
    },
  };
}
