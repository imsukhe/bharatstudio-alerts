import type { Sql, TransactionSql } from 'postgres';
import type { IngestFailureActionResult, IngestFailureAdminStore, IngestFailureEntry, IngestFailurePage } from '../domain/ingest-failure-admin.js';

// Same per-call role-scoping pattern as db/admin-store.ts's own
// inUserTransaction (duplicated, not imported, because that helper is not
// exported and this file must not edit admin-store.ts this pass): every
// statement runs with app.user_id set for the duration of one transaction
// so app_private.is_platform_admin() (and the new functions below) can
// resolve the caller via app_private.current_user_id().
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

const NOT_FOUND_SQLSTATE = '22023';

function hasSqlstate(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code;
}

type CursorPosition = { createdAt: string; id: string };

function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): CursorPosition | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      parsed && typeof parsed === 'object' &&
      typeof (parsed as { createdAt?: unknown }).createdAt === 'string' &&
      typeof (parsed as { id?: unknown }).id === 'string'
    ) {
      return parsed as CursorPosition;
    }
  } catch {
    // fall through to null — an unparsable cursor starts the list over
    // rather than 500ing.
  }
  return null;
}

type IngestFailureRow = {
  id: string; channel_id: string; channel_handle: string; source_id: string;
  source_event_type: string | null; sqlstate_code: string | null; error_detail: string; created_at: Date;
};

function toEntry(row: IngestFailureRow): IngestFailureEntry {
  return {
    id: row.id, channelId: row.channel_id, channelHandle: row.channel_handle, sourceId: row.source_id,
    sourceEventType: row.source_event_type, sqlstateCode: row.sqlstate_code, errorDetail: row.error_detail,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * SQL-backed IngestFailureAdminStore.
 *
 * The SECURITY DEFINER functions below are defined by migration
 * `0099_v1_l15_ingest_failure_admin_surface.sql`, and this store is composed
 * into the admin route by buildApp/index when SQL is configured. Every query
 * remains user-scoped in a transaction, so the database performs the final
 * platform-admin authorization check.
 */
export function createSqlIngestFailureStore(sql: Sql): IngestFailureAdminStore {
  return {
    async listIngestFailures(userId, limit, cursor): Promise<IngestFailurePage> {
      const position = decodeCursor(cursor);
      const rows = await inUserTransaction(sql, userId, (tx) => tx<IngestFailureRow[]>`
        select id, channel_id, channel_handle, source_id, source_event_type, sqlstate_code, error_detail, created_at
          from app_private.list_youtube_ingest_failures(
            ${position?.createdAt ?? null}::timestamptz,
            ${position?.id ?? null}::uuid,
            ${limit}
          )
      `);
      const entries = rows.map(toEntry);
      const last = rows[rows.length - 1];
      const nextCursor = rows.length === limit && last ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id }) : null;
      return { entries, nextCursor };
    },
    async getIngestFailure(userId, id): Promise<IngestFailureEntry | null> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<IngestFailureRow[]>`
        select id, channel_id, channel_handle, source_id, source_event_type, sqlstate_code, error_detail, created_at
          from app_private.get_youtube_ingest_failure(${id}::uuid)
      `);
      const row = rows[0];
      return row ? toEntry(row) : null;
    },
    async acknowledgeIngestFailure(userId, id, note): Promise<IngestFailureActionResult | null> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ id: string; acknowledged_at: Date }[]>`
          select id, acknowledged_at
            from app_private.acknowledge_youtube_ingest_failure(${id}::uuid, ${userId}::uuid, ${note})
        `);
        const row = rows[0];
        return row ? { id: row.id, acknowledgedAt: row.acknowledged_at.toISOString() } : null;
      } catch (error) {
        if (hasSqlstate(error, NOT_FOUND_SQLSTATE)) return null;
        throw error;
      }
    },
  };
}
