import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { hashViewerPassword, verifyViewerPassword } from '../domain/viewer-password.js';
import type {
  ViewerDashboardRow,
  ViewerDeletionResult,
  ViewerSessionPrincipal,
  ViewerSessionSummary,
  ViewerSignupResult,
  ViewerStore,
} from '../domain/viewer-store.js';
import { createSqlViewerResetStore } from './viewer-reset-store.js';
import { createSqlViewerProfileStore } from './viewer-profile-store.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function inViewerTransaction<T>(sql: Sql, viewerAccountId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.viewer_id', ${viewerAccountId}, true)`;
    return callback(tx);
  });
  return result as T;
}

export function createSqlViewerStore(sql: Sql, sessionTtlDays = 30): ViewerStore {
  // index.ts's call site (`createSqlViewerStore(sql)`) is frozen for this
  // batch, so the reset store's one extra dependency (the web origin, to
  // build the emailed reset link) is read from the same env var app.ts's
  // own config.ts already requires at startup (APP_ORIGIN), rather than
  // added as a new constructor parameter nothing would pass. The fallback
  // only matters for a store built directly in a unit test.
  const resetStore = createSqlViewerResetStore(sql, process.env.APP_ORIGIN ?? 'http://localhost:3000');
  const profileStore = createSqlViewerProfileStore(sql);
  async function issueSession(viewerAccountId: string, deviceLabel: string): Promise<ViewerSignupResult> {
    const accessToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionTtlDays * 24 * 60 * 60 * 1000);
    const rows = await sql<{ session_id: string; viewer_account_id: string; expires_at: Date }[]>`
      select session_id, viewer_account_id, expires_at
        from app_private.create_viewer_session(
          ${randomUUID()}, ${viewerAccountId}::uuid, ${hashToken(accessToken)}, ${deviceLabel}, ${expiresAt}
        )
    `;
    const row = rows[0];
    if (!row) throw new Error('Viewer session creation returned no row');
    return { accessToken, viewerAccountId: row.viewer_account_id, expiresAt: row.expires_at.toISOString() };
  }

  return {
    async signup(email, password, displayName, deviceLabel) {
      const viewerAccountId = randomUUID();
      const passwordHash = hashViewerPassword(password);
      await sql`select viewer_account_id from app_private.create_viewer_account(${viewerAccountId}::uuid, ${email}, ${passwordHash}, ${displayName ?? null})`;
      return issueSession(viewerAccountId, deviceLabel);
    },
    async login(email, password, deviceLabel) {
      const rows = await sql<{ id: string; password_hash: string | null; closed_at: Date | null }[]>`
        select id, password_hash, closed_at from app_private.find_viewer_account_by_email(${email})
      `;
      const row = rows[0];
      if (!row || row.closed_at || !verifyViewerPassword(password, row.password_hash)) return null;
      return issueSession(row.id, deviceLabel);
    },
    async lookup(accessToken) {
      const rows = await sql<{ session_id: string; viewer_account_id: string; expires_at: Date }[]>`
        select session_id, viewer_account_id, expires_at from app_private.lookup_viewer_session(${hashToken(accessToken)})
      `;
      const row = rows[0];
      return row ? { sessionId: row.session_id, viewerAccountId: row.viewer_account_id, expiresAt: row.expires_at.toISOString() } : null;
    },
    async listSessions(viewerAccountId): Promise<ViewerSessionSummary[]> {
      return inViewerTransaction(sql, viewerAccountId, async (tx) => {
        const rows = await tx<{ session_id: string; created_at: Date; last_seen_at: Date; expires_at: Date; device_label: string | null }[]>`
          select session_id, created_at, last_seen_at, expires_at, device_label
            from app_private.list_viewer_sessions(${viewerAccountId}::uuid)
        `;
        return rows.map((row) => ({
          sessionId: row.session_id,
          createdAt: row.created_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
          deviceLabel: row.device_label,
        }));
      });
    },
    async revokeSession(viewerAccountId, sessionId) {
      return inViewerTransaction(sql, viewerAccountId, async (tx) => {
        const rows = await tx<{ revoke_viewer_session: boolean }[]>`
          select app_private.revoke_viewer_session(${viewerAccountId}::uuid, ${sessionId}::uuid)
        `;
        return Boolean(rows[0]?.revoke_viewer_session);
      });
    },
    async getDashboard(viewerAccountId): Promise<ViewerDashboardRow[]> {
      return inViewerTransaction(sql, viewerAccountId, async (tx) => {
        const rows = await tx<{
          channel_id: string; channel_handle: string; channel_display_name: string;
          first_supported_at: Date; last_supported_at: Date;
          lifetime_amount_paise: string; tip_count: string; challenge_count: string; member_state: 'none' | 'active' | 'lapsed';
        }[]>`
          select channel_id, channel_handle, channel_display_name, first_supported_at, last_supported_at,
                 lifetime_amount_paise, tip_count, challenge_count, member_state
            from app_private.get_viewer_dashboard(${viewerAccountId}::uuid)
        `;
        return rows.map((row) => ({
          channelId: row.channel_id,
          channelHandle: row.channel_handle,
          channelDisplayName: row.channel_display_name,
          firstSupportedAt: row.first_supported_at.toISOString(),
          lastSupportedAt: row.last_supported_at.toISOString(),
          lifetimeAmountPaise: row.lifetime_amount_paise,
          tipCount: row.tip_count,
          challengeCount: row.challenge_count,
          memberState: row.member_state,
        }));
      });
    },
    async requestDeletion(viewerAccountId): Promise<ViewerDeletionResult> {
      return inViewerTransaction(sql, viewerAccountId, async (tx) => {
        const rows = await tx<{ request_viewer_account_deletion: ViewerDeletionResult }[]>`
          select app_private.request_viewer_account_deletion(${viewerAccountId}::uuid)
        `;
        const record = rows[0]?.request_viewer_account_deletion;
        if (!record) throw new Error('Viewer deletion returned no erasure record');
        return record;
      });
    },
    requestPasswordReset: resetStore.requestReset,
    resetPassword: resetStore.resetPassword,
    profile: profileStore,
  };
}

export type { ViewerStore };
