import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type {
  YoutubeConnection,
  YoutubeConnectionStore,
  YoutubeFinalizeConnectionInput,
  YoutubeOAuthStateRecord,
} from '../domain/youtube-connection.js';
import type { NotificationTokenProtector } from '../notifications/token-crypto.js';

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  }) as T;
}

type ConnectionRow = {
  connection_id: string;
  external_channel_id: string;
  external_channel_title: string | null;
  granted_scopes: string[];
  status: YoutubeConnection['status'];
  created_at: Date;
  updated_at: Date;
  revoked_at?: Date | null;
};

function fromRow(row: ConnectionRow): YoutubeConnection {
  return {
    schemaVersion: 'v1',
    connectionId: row.connection_id,
    externalChannelId: row.external_channel_id,
    externalChannelTitle: row.external_channel_title,
    grantedScopes: row.granted_scopes,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

// tokenProtector reuses the existing NotificationTokenProtector mechanism
// (apps/api/src/notifications/token-crypto.ts — AES-256-GCM ciphertext +
// SHA-256 fingerprint). No new crypto is introduced here: this store never
// sees or writes plaintext token material to SQL.
export function createSqlYoutubeConnectionStore(sql: Sql, tokenProtector: NotificationTokenProtector): YoutubeConnectionStore {
  return {
    async list(userId, channelId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<ConnectionRow[]>`
          select connection_id, external_channel_id, external_channel_title,
                 granted_scopes, status, created_at, updated_at, revoked_at
            from app_private.get_youtube_connections(${channelId}::uuid)
        `;
        return rows.map(fromRow);
      });
    },
    async beginOAuth(userId, channelId, params) {
      await inUserTransaction(sql, userId, async (tx) => {
        await tx`
          select app_private.begin_youtube_oauth(
            ${randomUUID()}::uuid, ${channelId}::uuid, ${userId}::uuid,
            ${params.state}, ${params.codeVerifier}, ${params.redirectUri}
          )
        `;
      });
    },
    async consumeOAuthState(state) {
      const rows = await sql<{ channel_id: string; user_id: string; code_verifier: string; redirect_uri: string }[]>`
        select channel_id, user_id, code_verifier, redirect_uri
          from app_private.consume_youtube_oauth_state(${state})
      `;
      const row = rows[0];
      if (!row) throw new Error('OAuth state consumption returned no row');
      const record: YoutubeOAuthStateRecord = {
        channelId: row.channel_id,
        userId: row.user_id,
        codeVerifier: row.code_verifier,
        redirectUri: row.redirect_uri,
      };
      return record;
    },
    async finalizeConnection(userId, channelId, input: YoutubeFinalizeConnectionInput) {
      const accessTokenCiphertext = tokenProtector.encrypt(input.accessToken);
      const accessTokenFingerprint = tokenProtector.fingerprint(input.accessToken);
      const refreshTokenCiphertext = input.refreshToken ? tokenProtector.encrypt(input.refreshToken) : null;
      const refreshTokenFingerprint = input.refreshToken ? tokenProtector.fingerprint(input.refreshToken) : null;
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<ConnectionRow[]>`
          select connection_id, external_channel_id, external_channel_title,
                 granted_scopes, status, created_at, updated_at
            from app_private.finalize_youtube_connection(
              ${randomUUID()}::uuid, ${channelId}::uuid, ${userId}::uuid,
              ${input.externalChannelId}, ${input.externalChannelTitle},
              ${input.scopes},
              ${accessTokenCiphertext}, ${accessTokenFingerprint},
              ${refreshTokenCiphertext}, ${refreshTokenFingerprint},
              ${input.tokenExpiresAt}
            )
        `;
        if (!rows[0]) throw new Error('Youtube connection finalize returned no row');
        return fromRow(rows[0]);
      });
    },
    async revoke(userId, channelId, connectionId) {
      return inUserTransaction(sql, userId, async (tx) => {
        const rows = await tx<{ revoked: boolean }[]>`
          select app_private.revoke_youtube_connection(${channelId}::uuid, ${userId}::uuid, ${connectionId}::uuid) as revoked
        `;
        return rows[0]?.revoked ?? false;
      });
    },
  };
}
