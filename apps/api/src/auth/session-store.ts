import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { GoogleIdentity } from './google.js';

export type SessionPrincipal = {
  sessionId: string;
  userId: string;
  expiresAt: string;
};

export type CurrentUser = {
  schemaVersion: 'v1';
  userId: string;
  displayName: string | null;
  channels: Array<{ channelId: string; role: string }>;
};

type SessionStore = {
  create(identity: GoogleIdentity, deviceLabel: string): Promise<{ accessToken: string; principal: SessionPrincipal }>;
  lookup(accessToken: string): Promise<SessionPrincipal | null>;
  getCurrentUser(userId: string): Promise<CurrentUser>;
  list(userId: string): Promise<Array<{ sessionId: string; createdAt: string; lastSeenAt: string; current: boolean; deviceLabel: string | null }>>;
  revoke(userId: string, sessionId: string): Promise<boolean>;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

export function createSqlSessionStore(sql: Sql, sessionTtlDays = 30): SessionStore {
  return {
    async create(identity, deviceLabel) {
      const accessToken = randomBytes(48).toString('base64url');
      const expiresAt = new Date(Date.now() + sessionTtlDays * 24 * 60 * 60 * 1000);
      const rows = await sql<{ user_id: string; session_id: string; expires_at: Date }[]>`
        select user_id, session_id, expires_at
          from app_private.create_user_session(
            ${randomUUID()}, ${identity.subject}, ${identity.displayName},
            ${hashToken(accessToken)}, ${deviceLabel}, ${expiresAt}, ${randomUUID()}
          )
      `;
      const row = rows[0];
      if (!row) throw new Error('Session creation returned no row');
      return {
        accessToken,
        principal: { sessionId: row.session_id, userId: row.user_id, expiresAt: row.expires_at.toISOString() },
      };
    },
    async lookup(accessToken) {
      const rows = await sql<{ session_id: string; user_id: string; expires_at: Date }[]>`
        select session_id, user_id, expires_at
          from app_private.lookup_session(${hashToken(accessToken)})
      `;
      const row = rows[0];
      return row ? { sessionId: row.session_id, userId: row.user_id, expiresAt: row.expires_at.toISOString() } : null;
    },
    async getCurrentUser(userId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const users = await tx<{ id: string; display_name: string | null }[]>`
          select id, display_name from app_users where id = ${userId}::uuid
        `;
        const user = users[0];
        if (!user) throw new Error('Authenticated user not found');
        const channels = await tx<{ channel_id: string; role: string }[]>`
          select channel_id, role from channel_memberships
           where user_id = ${userId}::uuid and revoked_at is null
           order by created_at asc
        `;
        return {
          schemaVersion: 'v1',
          userId: user.id,
          displayName: user.display_name,
          channels: channels.map((channel) => ({ channelId: channel.channel_id, role: channel.role })),
        };
      });
    },
    async list(userId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ id: string; created_at: Date; last_seen_at: Date; device_label: string; revoked_at: Date | null }[]>`
          select id, created_at, last_seen_at, device_label, revoked_at
            from user_sessions
           where user_id = ${userId}::uuid and revoked_at is null and expires_at > current_timestamp
           order by last_seen_at desc
        `;
        return rows.map((row) => ({
          sessionId: row.id,
          createdAt: row.created_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          current: false,
          deviceLabel: row.device_label,
        }));
      });
    },
    async revoke(userId, sessionId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          update user_sessions
             set revoked_at = current_timestamp
           where id = ${sessionId}::uuid
             and user_id = ${userId}::uuid
             and revoked_at is null
          returning id
        `;
        return Boolean(rows[0]);
      });
    },
  };
}

export type { SessionStore };
