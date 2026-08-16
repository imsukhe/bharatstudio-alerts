import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { OverlayAudioStore } from '../domain/overlay-audio-store.js';

function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSqlOverlayAudioStore(sql: Sql): OverlayAudioStore {
  return {
    async read(token, overlayId, artifactId) {
      const rows = await sql<{ audio_bytes: Buffer; mime_type: string; duration_ms: number | null }[]>`
        select audio_bytes, mime_type, duration_ms
          from app_private.get_overlay_tts_audio(${overlayId}::uuid, ${fingerprint(token)}, ${artifactId}::uuid)
      `;
      const row = rows[0];
      return row ? { bytes: row.audio_bytes, mimeType: row.mime_type, durationMs: row.duration_ms } : null;
    },
  };
}
