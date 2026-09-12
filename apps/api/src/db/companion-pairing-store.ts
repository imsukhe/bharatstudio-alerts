import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { AlertStore, CompanionControlSession } from '../domain/alert-store.js';
import type {
  CompanionPairingClientType,
  CompanionPairingRequestView,
  CompanionPairingStore,
  DevicePairingPendingStatus,
  DevicePairingTokenResult,
} from '../domain/companion-pairing.js';

// Human-typeable, ambiguity-free alphabet: no 0/O/1/I. 24 letters + 8 digits
// = 32 symbols; see migration 0082's header for the full brute-force
// analysis (8 chars over this alphabet, short expiry, single use, and
// per-route rate limiting on the guessable endpoints).
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USER_CODE_LENGTH = 8;
const MAX_USER_CODE_ATTEMPTS = 8;
const PAIRING_TTL_MS = 1000 * 60 * 10; // 10 minutes — see migration 0082.
const POLL_INTERVAL_SECONDS = 5;

function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateUserCode(): string {
  let code = '';
  for (let i = 0; i < USER_CODE_LENGTH; i += 1) {
    code += USER_CODE_ALPHABET[randomInt(0, USER_CODE_ALPHABET.length)];
  }
  return code;
}

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  }) as T;
}

export function createSqlCompanionPairingStore(sql: Sql, alerts: AlertStore, verificationUri: string): CompanionPairingStore {
  return {
    async startDevicePairing(clientType, clientInstanceId, clientLabel) {
      const deviceCode = randomBytes(32).toString('base64url');
      const deviceCodeFingerprint = fingerprint(deviceCode);
      const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
      let attempt = 0;
      // The active-code unique index (migration 0082) turns a user_code
      // collision into a 23505 from Postgres rather than a logic error —
      // retry with a freshly generated code instead of surfacing it.
      for (;;) {
        attempt += 1;
        const userCode = generateUserCode();
        try {
          await sql`
            select app_private.start_companion_device_pairing(
              ${randomUUID()}::uuid,
              ${userCode},
              ${deviceCodeFingerprint},
              ${clientType},
              ${clientInstanceId},
              ${clientLabel},
              ${expiresAt.toISOString()}::timestamptz
            )
          `;
          return {
            schemaVersion: 'v1' as const,
            userCode,
            deviceCode,
            expiresIn: Math.floor(PAIRING_TTL_MS / 1000),
            interval: POLL_INTERVAL_SECONDS,
            verificationUri,
          };
        } catch (error) {
          const sqlState = (error as { code?: string }).code;
          if (sqlState === '23505' && attempt < MAX_USER_CODE_ATTEMPTS) continue;
          throw error;
        }
      }
    },

    async pollDeviceToken(deviceCode): Promise<DevicePairingTokenResult> {
      const rows = await sql<{
        status: DevicePairingPendingStatus | 'approved';
        channel_id: string | null;
        approved_by_user_id: string | null;
        client_type: CompanionPairingClientType | null;
        client_instance_id: string | null;
      }[]>`
        select status, channel_id, approved_by_user_id, client_type, client_instance_id
          from app_private.poll_companion_device_pairing(${fingerprint(deviceCode)}, ${POLL_INTERVAL_SECONDS})
      `;
      const row = rows[0];
      if (!row || row.status !== 'approved') {
        return { schemaVersion: 'v1', status: (row?.status as DevicePairingPendingStatus | undefined) ?? 'expired_token' };
      }
      if (!row.channel_id || !row.approved_by_user_id || !row.client_type || !row.client_instance_id) {
        // The SQL function only marks a row approved once channel_id,
        // approved_by_user_id and the original client identity are set — an
        // approved row missing any of them is a store bug, not a client-
        // facing pairing outcome, so this fails loudly rather than as
        // access_denied/expired_token.
        throw new Error('Companion pairing approval was incomplete');
      }
      const session: CompanionControlSession = await alerts.acquireCompanionControlSession(
        row.approved_by_user_id,
        row.channel_id,
        row.client_type,
        row.client_instance_id,
      );
      return { schemaVersion: 'v1', status: 'approved', session };
    },

    async getPairingRequest(userId, userCode): Promise<CompanionPairingRequestView | null> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{
        user_code: string;
        client_type: CompanionPairingClientType;
        client_label: string;
        state: CompanionPairingRequestView['state'];
        created_at: Date;
        expires_at: Date;
      }[]>`
        select user_code, client_type, client_label, state, created_at, expires_at
          from app_private.get_companion_pairing_request(${userCode})
      `);
      const row = rows[0];
      return row ? {
        schemaVersion: 'v1',
        userCode: row.user_code,
        clientType: row.client_type,
        clientLabel: row.client_label,
        state: row.state,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
      } : null;
    },

    async approvePairing(userId, userCode, channelId): Promise<boolean> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ approved: boolean }[]>`
        select app_private.approve_companion_pairing(${userCode}, ${channelId}::uuid, ${userId}::uuid) as approved
      `);
      return rows[0]?.approved ?? false;
    },

    async denyPairing(userId, userCode): Promise<boolean> {
      const rows = await inUserTransaction(sql, userId, (tx) => tx<{ denied: boolean }[]>`
        select app_private.deny_companion_pairing(${userCode}, ${userId}::uuid) as denied
      `);
      return rows[0]?.denied ?? false;
    },
  };
}
