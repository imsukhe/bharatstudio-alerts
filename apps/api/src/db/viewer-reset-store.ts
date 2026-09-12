import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { hashViewerPassword } from '../domain/viewer-password.js';
import type { ViewerPasswordResetStore } from '../domain/viewer-reset-store.js';

// Short-lived by design (see migration 0088's header) — a wide window on a
// password-reset link is a wider account-takeover window if the email is
// ever intercepted.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

// Same SHA-256 fingerprint convention as apps/api/src/db/overlay-store.ts:8-9
// and viewer-store.ts's own session token hashing — the plaintext token is
// never passed to SQL, stored in a column, or logged.
function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// The plaintext token travels only in this URL, inside the emailed
// message body (see 0088's header + email_outbox payload). It is placed in
// the URL FRAGMENT, not a query string, so it never reaches a server
// access log or a Referer header — the same choice overlay-store.ts makes
// for its own bearer token.
function resetUrl(webOrigin: string, token: string): string {
  const origin = webOrigin.replace(/\/+$/, '');
  return `${origin}/viewer/reset-password#token=${encodeURIComponent(token)}`;
}

export function createSqlViewerResetStore(sql: Sql, webOrigin: string): ViewerPasswordResetStore {
  return {
    async requestReset(email) {
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await sql`
        select app_private.request_viewer_password_reset(
          ${randomUUID()}::uuid, ${email}, ${fingerprint(token)}, ${expiresAt}, ${resetUrl(webOrigin, token)}
        )
      `;
      // No result to inspect: request_viewer_password_reset is a silent
      // no-op server-side on a non-matching email (enumeration defence),
      // so this resolves the same way either way.
    },
    async resetPassword(token, newPassword) {
      const rows = await sql<{ viewer_account_id: string | null }[]>`
        select viewer_account_id from app_private.consume_viewer_password_reset_token(
          ${fingerprint(token)}, ${hashViewerPassword(newPassword)}
        )
      `;
      return Boolean(rows[0]?.viewer_account_id);
    },
  };
}
