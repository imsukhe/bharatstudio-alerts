import type { Sql, TransactionSql } from 'postgres';
import type {
  SafeSoundboardStore,
  SoundboardCatalogueEntry,
  SoundboardUpload,
  ToggleSoundboardCatalogueResult,
  TriggerSoundboardPlayResult,
  UploadSoundboardClipResult,
} from '../domain/safe-soundboard-store.js';

// PRF-02 slice 7, creator side of §6 module #6 (migration 0143).
//
// WIRED TO THE MAIN `sql` POOL, NOT `derivedReadSql` -- the identical
// position db/lobby-status-store.ts and db/giveaway-tournament-store.ts
// occupy, for the identical reason: this file carries creator WRITE
// paths plus the creator's own reads. The overlay-facing read lives in
// its own file (db/safe-soundboard-overlay-store.ts) precisely so it CAN
// be wired to `derivedReadSql`.
//
// NO TIER CHECK EXISTS IN THIS FILE, AND NONE MAY BE ADDED (§12.6). The
// §30.3 Pro+ module gate and the per-tier upload count ladder both live
// in SQL (migration 0143), inside app_private.soundboard_module_entitled
// and app_private.soundboard_upload_tier_limit respectively -- the
// former is called only from the overlay read, the latter only from
// upload_channel_soundboard_clip.
//
// THE ONLY GATE HERE IS THE ROLE GATE, and it lives in SQL:
// app_private.has_channel_role(channel, ['owner','admin']) inside
// migration 0143's own functions.
async function inUserTransaction<T>(sql: Sql, userId: string, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return callback(tx);
  });
  return result as T;
}

type CatalogueRow = {
  id: string;
  external_key: string;
  display_name: string;
  category: string;
  min_tier: string;
  byte_size: number;
  duration_seconds: number;
  enabled: boolean;
  updated_at: Date;
};

type UploadRow = {
  id: string;
  display_name: string;
  byte_size: number;
  duration_seconds: number;
  uploaded_at: Date;
};

function toCatalogueEntry(row: CatalogueRow): SoundboardCatalogueEntry {
  return {
    schemaVersion: 'v1',
    id: row.id,
    externalKey: row.external_key,
    displayName: row.display_name,
    category: row.category,
    minTier: row.min_tier as SoundboardCatalogueEntry['minTier'],
    byteSize: Number(row.byte_size),
    durationSeconds: Number(row.duration_seconds),
    enabled: row.enabled,
    updatedAt: row.updated_at.toISOString(),
  };
}

function toUpload(row: UploadRow): SoundboardUpload {
  return {
    schemaVersion: 'v1',
    id: row.id,
    displayName: row.display_name,
    byteSize: Number(row.byte_size),
    durationSeconds: Number(row.duration_seconds),
    uploadedAt: row.uploaded_at.toISOString(),
  };
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

export function createSqlSafeSoundboardStore(sql: Sql): SafeSoundboardStore {
  async function readCatalogue(userId: string, channelId: string): Promise<SoundboardCatalogueEntry[]> {
    const rows = await inUserTransaction(sql, userId, (tx) => tx<CatalogueRow[]>`
      select id, external_key, display_name, category, min_tier, byte_size, duration_seconds, enabled, updated_at
        from app_private.list_soundboard_catalogue_for_channel(${channelId}::uuid)
    `);
    return rows.map(toCatalogueEntry);
  }

  async function readUploads(userId: string, channelId: string): Promise<SoundboardUpload[]> {
    const rows = await inUserTransaction(sql, userId, (tx) => tx<UploadRow[]>`
      select id, display_name, byte_size, duration_seconds, uploaded_at
        from app_private.list_channel_soundboard_uploads(${channelId}::uuid)
    `);
    return rows.map(toUpload);
  }

  return {
    listCatalogue: readCatalogue,
    listUploads: readUploads,

    async setCatalogueEntryEnabled(userId, channelId, entryId, enabled): Promise<ToggleSoundboardCatalogueResult> {
      try {
        await inUserTransaction(sql, userId, (tx) => tx`
          select app_private.set_channel_soundboard_catalogue_enabled(${channelId}::uuid, ${entryId}::uuid, ${enabled})
        `);
      } catch (error) {
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
      const entries = await readCatalogue(userId, channelId);
      return { outcome: 'ok', entries };
    },

    async uploadClip(userId, channelId, input, caps): Promise<UploadSoundboardClipResult> {
      let uploadId: string | undefined;
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ outcome: string; upload_id: string }[]>`
          select outcome, upload_id from app_private.upload_channel_soundboard_clip(
            ${channelId}::uuid, ${input.displayName}, ${input.contentSha256}, ${input.mimeType},
            ${input.byteSize}::integer, ${input.durationSeconds}::integer, ${input.rightsAttested},
            ${caps.maxDurationSeconds ?? null}::integer, ${caps.maxByteSize ?? null}::integer
          )
        `);
        uploadId = rows[0]?.upload_id;
      } catch (error) {
        // 55000 = object_not_in_prerequisite_state, raised when either
        //         cap is unset -- the upload control is INERT (see
        //         0143's header). Never treated as "unlimited".
        if (isPgErrorWithCode(error, '55000')) return { outcome: 'caps_not_configured' };
        if (isPgErrorWithCode(error, '42501')) {
          // Two distinguishable reasons share this code in SQL (role gate
          // and the tier upload-count limit); the message text is the
          // only signal available without a second round trip, and both
          // are read-back-and-render-only distinctions for the client.
          const message = error instanceof Error ? error.message : '';
          if (message.includes('count limit')) return { outcome: 'tier_limit_reached' };
          return { outcome: 'forbidden' };
        }
        if (isPgErrorWithCode(error, '23505')) return { outcome: 'conflict' };
        if (isPgErrorWithCode(error, '22023')) {
          const message = error instanceof Error ? error.message : '';
          if (message.includes('rights attestation')) return { outcome: 'rights_not_attested' };
          if (message.includes('cap')) return { outcome: 'cap_exceeded' };
          return { outcome: 'invalid' };
        }
        throw error;
      }
      if (!uploadId) return { outcome: 'invalid' };
      const uploads = await readUploads(userId, channelId);
      const upload = uploads.find((candidate) => candidate.id === uploadId);
      return upload ? { outcome: 'ok', upload } : { outcome: 'invalid' };
    },

    async triggerPlay(userId, channelId, source): Promise<TriggerSoundboardPlayResult> {
      try {
        const rows = await inUserTransaction(sql, userId, (tx) => tx<{ trigger_soundboard_play: string }[]>`
          select app_private.trigger_soundboard_play(
            ${channelId}::uuid,
            ${source.catalogueEntryId ?? null}::uuid,
            ${source.uploadId ?? null}::uuid
          )
        `);
        const playId = rows[0]?.trigger_soundboard_play;
        return playId ? { outcome: 'ok', playId } : { outcome: 'invalid' };
      } catch (error) {
        if (isPgErrorWithCode(error, '42501')) return { outcome: 'forbidden' };
        if (isPgErrorWithCode(error, 'P0002')) return { outcome: 'not_found' };
        if (isPgErrorWithCode(error, '22023')) return { outcome: 'invalid' };
        throw error;
      }
    },
  };
}
