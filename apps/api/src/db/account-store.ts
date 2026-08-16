import type { Sql, TransactionSql } from 'postgres';
import type { AccountStore, ActiveDocument, PrivacyRequest } from '../domain/account-store.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx) => { await tx`select set_config('app.user_id', ${userId}, true)`; return callback(tx); }) as T;
}

export function createSqlAccountStore(sql: Sql): AccountStore {
  return {
    async listActiveDocuments() {
      const rows = await sql<{ document_key: ActiveDocument['documentKey']; version: string; content_hash: string; published_at: Date | null }[]>`
        select document_key, version, content_hash, published_at from app_private.list_active_terms_documents()
      `;
      return rows.map((row) => ({ documentKey: row.document_key, version: row.version, contentHash: row.content_hash, publishedAt: row.published_at?.toISOString() ?? null }));
    },
    async acceptDocument(userId, documentKey, version, contentHash) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ accepted: boolean }[]>`
          select app_private.accept_terms_document(${userId}::uuid, ${documentKey}, ${version}, ${contentHash}) as accepted
        `;
        return rows[0]?.accepted ?? false;
      });
    },
    async hasAcceptedActiveDocuments(userId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ accepted: boolean }[]>`select app_private.has_accepted_active_terms(${userId}::uuid) as accepted`;
        return rows[0]?.accepted ?? false;
      });
    },
    async createPrivacyRequest(userId, requestType, details) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ request_id: string; request_type: PrivacyRequest['requestType']; status: PrivacyRequest['status']; created_at: Date }[]>`
          select request_id, request_type, status, created_at from app_private.create_privacy_request(${userId}::uuid, ${requestType}, ${details})
        `;
        const row = rows[0]; if (!row) throw new Error('Privacy request was not created');
        return { requestId: row.request_id, requestType: row.request_type, status: row.status, createdAt: row.created_at.toISOString() };
      });
    },
    async listPrivacyRequests(userId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ request_id: string; request_type: PrivacyRequest['requestType']; details: string; status: PrivacyRequest['status']; created_at: Date; updated_at: Date; resolved_at: Date | null; resolution_note: string | null }[]>`
          select request_id, request_type, details, status, created_at, updated_at, resolved_at, resolution_note from app_private.list_privacy_requests(${userId}::uuid)
        `;
        return rows.map((row) => ({ requestId: row.request_id, requestType: row.request_type, details: row.details, status: row.status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), resolvedAt: row.resolved_at?.toISOString() ?? null, resolutionNote: row.resolution_note }));
      });
    },
    async exportAccount(userId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ export: Record<string, unknown> }[]>`select app_private.get_account_export(${userId}::uuid) as export`;
        if (!rows[0]?.export) throw new Error('Account export was not created');
        return rows[0].export;
      });
    },
    async closeAccount(userId, reason) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ close_current_account: Date }[]>`select app_private.close_current_account(${userId}::uuid, ${reason})`;
        if (!rows[0]?.close_current_account) throw new Error('Account could not be closed');
        return rows[0].close_current_account.toISOString();
      });
    },
  };
}
