import type { Sql, TransactionSql } from 'postgres';
import type {
  SponsorCard,
  SponsorCardStore,
  UpsertSponsorCardInput,
  UpsertSponsorCardResult,
} from '../domain/sponsor-card-store.js';

// PRF-02 slice 7, creator side of §6 module #11 (migration 0145).
//
// WIRED TO THE MAIN `sql` POOL, NOT `derivedReadSql` -- the identical
// position db/stream-mission-store.ts, db/lobby-status-store.ts and
// db/safe-mode-store.ts occupy. This file carries the creator WRITE path
// plus the creator's own read of the current sponsor card. The
// overlay-facing read lives in its own file
// (db/sponsor-card-overlay-store.ts) precisely so that it CAN be wired to
// `derivedReadSql` and CAN be seen by every rule of
// scan-required-queries.mjs -- see that file's own header.
//
// NO TIER CHECK EXISTS IN THIS FILE, AND NONE MAY BE ADDED (§12.6).
// `sponsor_card` is already one of migration 0131's twenty catalogue
// keys; the §30.3 module-count cap is the only gate on whether the CANVAS
// renders this card, and it lives entirely inside migration 0131.

async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

type SponsorCardRow = {
  sponsor_card_id: string;
  sponsor_name: string;
  logo_content_sha256: string | null;
  logo_mime_type: string | null;
  logo_byte_size: number | null;
  logo_storage_key: string | null;
  enabled: boolean;
  schedule_starts_at: Date | null;
  schedule_ends_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toSponsorCard(row: SponsorCardRow): SponsorCard {
  return {
    schemaVersion: 'v1',
    sponsorCardId: row.sponsor_card_id,
    sponsorName: row.sponsor_name,
    logoContentSha256: row.logo_content_sha256,
    logoMimeType: row.logo_mime_type,
    logoByteSize: row.logo_byte_size === null ? null : Number(row.logo_byte_size),
    logoStorageKey: row.logo_storage_key,
    enabled: row.enabled,
    scheduleStartsAt: row.schedule_starts_at ? row.schedule_starts_at.toISOString() : null,
    scheduleEndsAt: row.schedule_ends_at ? row.schedule_ends_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

export function createSqlSponsorCardStore(sql: Sql): SponsorCardStore {
  async function readCurrent(userId: string, channelId: string): Promise<SponsorCard | null> {
    const rows = await inUserTransaction(sql, userId, (tx) => tx<SponsorCardRow[]>`
      select sponsor_card_id, sponsor_name, logo_content_sha256, logo_mime_type, logo_byte_size,
             logo_storage_key, enabled, schedule_starts_at, schedule_ends_at, created_at, updated_at
        from app_private.list_channel_sponsor_card(${channelId}::uuid)
    `);
    const row = rows[0];
    return row ? toSponsorCard(row) : null;
  }

  return {
    getCurrent: readCurrent,

    async upsert(userId, channelId, input: UpsertSponsorCardInput): Promise<UpsertSponsorCardResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.upsert_sponsor_card(
            ${channelId}::uuid,
            ${input.sponsorName},
            ${input.logoContentSha256},
            ${input.logoMimeType},
            ${input.logoByteSize},
            ${input.enabled},
            ${input.scheduleStartsAt}::timestamptz,
            ${input.scheduleEndsAt}::timestamptz
          )
        `);
      } catch (error) {
        // 42501 = insufficient_privilege, raised for a non-owner/admin.
        // 22023 = invalid_parameter_value, raised for a name outside the
        //         1-120 bound, a malformed logo triple, or a malformed
        //         schedule pair -- see migration 0145's own function body.
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const sponsorCard = await readCurrent(userId, channelId);
      return sponsorCard ? { outcome: 'ok', sponsorCard } : { outcome: 'invalid' };
    },
  };
}
