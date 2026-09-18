import type { Sql, TransactionSql } from 'postgres';
import type { AdminPasskeyStore, PendingPasskeyRecovery, StoredPasskey } from '../domain/admin-passkeys.js';

async function inSessionTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => { await tx`select set_config('app.user_id', ${userId}, true)`; return callback(tx); }) as Promise<T>;
}

export function createSqlAdminPasskeyStore(sql: Sql): AdminPasskeyStore {
  return {
    async list({ userId, sessionId }) {
      return inSessionTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ credential_id: string; public_key: Uint8Array; counter: string; transports: string[]; aaguid: string }[]>`
          select credential_id, public_key, counter, transports, aaguid from app_private.admin_list_passkeys(${sessionId}::uuid)`;
        return rows.map((r): StoredPasskey => ({ credentialId: r.credential_id, publicKey: r.public_key, counter: Number(r.counter), transports: r.transports, aaguid: r.aaguid }));
      });
    },
    async begin(input) { await inSessionTransaction(sql, input.userId, async (tx) => { await tx`select app_private.admin_begin_webauthn_challenge(${input.challengeId}::uuid, ${input.sessionId}::uuid, ${input.ceremony}, ${input.challengeHash}, ${input.expiresAt})`; }); },
    async finishRegistration(input) { await inSessionTransaction(sql, input.userId, async (tx) => { await tx`select app_private.admin_finish_passkey_registration(${input.challengeId}::uuid, ${input.sessionId}::uuid, ${input.challengeHash}, ${input.credentialId}, ${Buffer.from(input.publicKey)}, ${input.counter}, ${input.transports}, ${input.aaguid})`; }); },
    async finishAssertion(input) { return inSessionTransaction(sql, input.userId, async (tx) => { const rows = await tx<{ admin_finish_passkey_assertion: Date }[]>`select app_private.admin_finish_passkey_assertion(${input.challengeId}::uuid, ${input.sessionId}::uuid, ${input.challengeHash}, ${input.credentialId}, ${input.counter})`; const at = rows[0]?.admin_finish_passkey_assertion; if (!at) throw new Error('MFA verification timestamp missing'); return at.toISOString(); }); },
    async isVerified(input) { return inSessionTransaction(sql, input.userId, async (tx) => { const rows = await tx<{ admin_session_mfa_verified: boolean }[]>`select app_private.admin_session_mfa_verified(${input.sessionId}::uuid, ${input.maxAgeSeconds})`; return rows[0]?.admin_session_mfa_verified === true; }); },
    async requestRecovery(input) { return inSessionTransaction(sql, input.userId, async (tx) => { const rows = await tx<{ admin_request_passkey_recovery: string }[]>`select app_private.admin_request_passkey_recovery(${input.sessionId}::uuid)`; const id = rows[0]?.admin_request_passkey_recovery; if (!id) throw new Error('Passkey recovery id missing'); return id; }); },
    async listPendingRecoveries(input) { return inSessionTransaction(sql, input.userId, async (tx) => {
      const rows = await tx<{ recovery_id: string; target_user_id: string; target_display_name: string; requested_at: Date; expires_at: Date; owner_approved: boolean; staff_approved: boolean }[]>`
        select * from app_private.admin_list_pending_passkey_recoveries(${input.sessionId}::uuid)`;
      return rows.map((row): PendingPasskeyRecovery => ({ recoveryId: row.recovery_id, targetUserId: row.target_user_id, targetDisplayName: row.target_display_name, requestedAt: row.requested_at.toISOString(), expiresAt: row.expires_at.toISOString(), ownerApproved: row.owner_approved, staffApproved: row.staff_approved }));
    }); },
    async approveRecovery(input) { return inSessionTransaction(sql, input.userId, async (tx) => {
      const rows = await tx<{ status: 'awaiting_second_approval' | 'completed'; completed_at: Date | null }[]>`
        select * from app_private.admin_approve_passkey_recovery(${input.sessionId}::uuid, ${input.recoveryId}::uuid)`;
      const result = rows[0];
      if (!result) throw new Error('Passkey recovery approval result missing');
      return { status: result.status, completedAt: result.completed_at?.toISOString() ?? null };
    }); },
  };
}
