import type { Sql, TransactionSql } from 'postgres';
import type { ClaimedEmail, EmailKind, EmailOutboxCompletionStatus, EmailOutboxStore } from '../domain/email.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

export function createSqlEmailOutboxStore(sql: Sql): EmailOutboxStore {
  return {
    async claimPending(limit): Promise<ClaimedEmail[]> {
      const rows = await sql<{
        id: string; kind: EmailKind; recipient_user_id: string; recipient_email: string | null;
        recipient_email_verified: boolean; channel_id: string | null; payload: Record<string, unknown>; attempt_count: number;
      }[]>`
        select id, kind, recipient_user_id, recipient_email, recipient_email_verified, channel_id, payload, attempt_count
          from app_private.claim_pending_emails(${limit})
      `;
      return rows.map((row): ClaimedEmail => ({
        id: row.id, kind: row.kind, recipientUserId: row.recipient_user_id, recipientEmail: row.recipient_email,
        recipientEmailVerified: row.recipient_email_verified, channelId: row.channel_id, payload: row.payload, attemptCount: row.attempt_count,
      }));
    },
    async complete(id, status: EmailOutboxCompletionStatus, error): Promise<void> {
      await sql`select app_private.complete_email_outbox_entry(${id}::uuid, ${status}, ${error})`;
    },
    async enqueueDpdpExportEmail(userId): Promise<void> {
      await inUserTransaction(sql, userId, (tx) => tx`
        select app_private.enqueue_dpdp_export_email(${userId}::uuid)
      `);
    },
  };
}
