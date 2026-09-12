import type { Sql, TransactionSql } from 'postgres';
import type { ChannelMembership, SeatStore } from '../domain/seat-store.js';

// Same per-request-user transaction wrapper as apps/api/src/db/channel-store.ts
// (inUserTransaction) — duplicated here rather than imported since that
// helper isn't exported, and this is a new, independently-owned store.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

function membershipFromRow(row: { channel_id: string; user_id: string; role: string; created_at: Date; revoked_at: Date | null }): ChannelMembership {
  return {
    schemaVersion: 'v1',
    channelId: row.channel_id,
    userId: row.user_id,
    role: row.role as ChannelMembership['role'],
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

export function createSqlSeatStore(sql: Sql): SeatStore {
  return {
    async setMemberRole(actingUserId, channelId, targetUserId, role) {
      return inUserTransaction(sql, actingUserId, async (tx) => {
        // app_private.set_channel_membership_role (0104) is the sole
        // enforcement point: it re-asserts owner/admin authorization and
        // the moderator seat limit itself, bypassing the table's own RLS
        // as security definer. This store never writes channel_memberships
        // directly.
        const rows = await tx<{ channel_id: string; user_id: string; role: string; created_at: Date; revoked_at: Date | null }[]>`
          select
            membership_channel_id as channel_id,
            membership_user_id as user_id,
            membership_role as role,
            membership_created_at as created_at,
            membership_revoked_at as revoked_at
          from app_private.set_channel_membership_role(${channelId}::uuid, ${targetUserId}::uuid, ${role})
        `;
        const row = rows[0];
        if (!row) throw new Error('Membership change returned no row');
        return membershipFromRow(row);
      });
    },
  };
}
