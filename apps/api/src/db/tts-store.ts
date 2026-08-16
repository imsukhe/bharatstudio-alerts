import type { Sql } from 'postgres';
import type { TtsStore } from '../domain/tts-store.js';
import type { TtsAudio, TtsLocale } from '../tts/provider.js';

export function createSqlTtsStore(sql: Sql): TtsStore {
  return {
    async getEventInput(eventId) {
      const rows = await sql<{
        event_id: string;
        message: string;
        locale: TtsLocale;
        voice_id: string | null;
        model: string | null;
        enabled: boolean;
        eligible: boolean;
      }[]>`
        select event_id, message, locale, voice_id, model, enabled, eligible
          from app_private.get_alert_tts_input(${eventId}::uuid)
      `;
      const row = rows[0];
      return row ? {
        eventId: row.event_id,
        message: row.message,
        locale: row.locale,
        ...(row.voice_id ? { voiceId: row.voice_id } : {}),
        ...(row.model ? { model: row.model } : {}),
        enabled: row.enabled,
        eligible: row.eligible,
      } : null;
    },
    async storeAudio(eventId, audio) {
      const rows = await sql<{ artifact_id: string }[]>`
        select app_private.store_alert_tts_audio(
          ${eventId}::uuid,
          ${Buffer.from(audio.audioBase64, 'base64')},
          ${audio.mimeType},
          ${audio.durationMs ?? null},
          ${audio.cacheKey}
        ) as artifact_id
      `;
      if (!rows[0]?.artifact_id) throw new Error('TTS artifact was not stored');
      return rows[0].artifact_id;
    },
  };
}
