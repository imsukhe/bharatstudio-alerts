import type { Sql, TransactionSql } from 'postgres';
import type {
  CreatorPackReviewAuditEntry,
  CreatorPackReviewDecision,
  CreatorPackReviewDetail,
  PendingCreatorPackEntry,
  StaffCreatorPackReviewStore,
} from '../domain/staff-creator-pack-review.js';

// Same isolation shape as apps/api/src/db/admin-store.ts's
// inUserTransaction — every call runs with app.user_id set for the
// caller, so app_private.is_platform_admin() (and app_private.
// current_user_id() inside staff_review_creator_pack_sticker) sees the
// real caller, never a shared/service identity.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

// 22023 ("invalid input") is the one legitimate non-exceptional failure
// this store maps to null (-> 404 at the route layer): reviewing an id
// that is not currently pending_review (never existed, or was already
// decided). Anything else — including 42501 permission-denied, which
// should never happen since isPlatformAdmin() is already checked before
// any of these are called — propagates and is handled generically by the
// route layer, same contract as admin-store.ts.
const INVALID_STATE_SQLSTATE = '22023';

function hasSqlstate(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code;
}

export function createSqlStaffCreatorPackReviewStore(sql: Sql): StaffCreatorPackReviewStore {
  return {
    async listPendingCreatorPacks(userId, limit): Promise<PendingCreatorPackEntry[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        id: string; channel_id: string; display_name: string; category: string;
        byte_size: number; creator_attested: boolean; created_at: Date;
      }[]>`
        select id, channel_id, display_name, category, byte_size, creator_attested, created_at
          from app_private.staff_list_pending_creator_pack_stickers(${limit})
      `);
      return rows.map((row): PendingCreatorPackEntry => ({
        id: row.id, channelId: row.channel_id, displayName: row.display_name, category: row.category,
        byteSize: row.byte_size, creatorAttested: row.creator_attested, createdAt: row.created_at.toISOString(),
      }));
    },
    async getCreatorPackForReview(userId, packStickerId): Promise<CreatorPackReviewDetail | null> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        id: string; channel_id: string; display_name: string; category: string;
        asset_bytes: Buffer; mime_type: string; byte_size: number;
        creator_attested: boolean; status: string; created_at: Date;
      }[]>`
        select id, channel_id, display_name, category, asset_bytes, mime_type, byte_size, creator_attested, status, created_at
          from app_private.staff_get_creator_pack_sticker_for_review(${packStickerId}::uuid)
      `);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id, channelId: row.channel_id, displayName: row.display_name, category: row.category,
        assetBase64: row.asset_bytes.toString('base64'), mimeType: row.mime_type, byteSize: row.byte_size,
        creatorAttested: row.creator_attested, status: row.status, createdAt: row.created_at.toISOString(),
      };
    },
    async reviewCreatorPack(userId, packStickerId, approved, reason): Promise<CreatorPackReviewDecision | null> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{
          id: string; status: string; decision: 'approved' | 'rejected'; reviewer_id: string; reviewed_at: Date;
        }[]>`
          select id, status, decision, reviewer_id, reviewed_at
            from app_private.staff_review_creator_pack_sticker(${packStickerId}::uuid, ${approved}, ${reason})
        `);
        const row = rows[0];
        if (!row) return null;
        return {
          id: row.id, status: row.status, decision: row.decision,
          reviewerId: row.reviewer_id, reviewedAt: row.reviewed_at.toISOString(),
        };
      } catch (error) {
        if (hasSqlstate(error, INVALID_STATE_SQLSTATE)) return null;
        throw error;
      }
    },
    async listReviewAudit(userId, packStickerId): Promise<CreatorPackReviewAuditEntry[]> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        id: string; reviewer_id: string; decision: 'approved' | 'rejected'; reason: string | null; reviewed_at: Date;
      }[]>`
        select id, reviewer_id, decision, reason, reviewed_at
          from app_private.staff_list_creator_pack_review_audit(${packStickerId}::uuid)
      `);
      return rows.map((row): CreatorPackReviewAuditEntry => ({
        id: row.id, reviewerId: row.reviewer_id, decision: row.decision, reason: row.reason, reviewedAt: row.reviewed_at.toISOString(),
      }));
    },
  };
}
