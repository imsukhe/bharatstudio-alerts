import type { Sql } from 'postgres';
import type { TtsAudio, TtsCache } from '../tts/provider.js';

export function createSqlTtsCache(sql: Sql): TtsCache {
  return {
    async get(cacheKey) {
      const rows = await sql<{ audio_bytes: Buffer; mime_type: 'audio/wav'; duration_ms: number | null; cache_key: string }[]>`
        select audio_bytes, mime_type, duration_ms, cache_key
          from app_private.get_alert_tts_cache(${cacheKey})
      `;
      const row = rows[0];
      return row ? { audioBase64: row.audio_bytes.toString('base64'), mimeType: row.mime_type, durationMs: row.duration_ms ?? undefined, cacheKey: row.cache_key } : null;
    },
    async put(audio: TtsAudio) {
      await sql`
        select app_private.put_alert_tts_cache(
          ${audio.cacheKey}, ${Buffer.from(audio.audioBase64, 'base64')},
          ${audio.mimeType}, ${audio.durationMs ?? null}
        )
      `;
    },
  };
}
