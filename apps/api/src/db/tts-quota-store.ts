import type { Sql } from 'postgres';
import type { TtsQuotaMeter, TtsQuotaOutcome } from '../domain/tts-quota.js';

export function createSqlTtsQuotaMeter(sql: Sql): TtsQuotaMeter {
  return {
    async meter(eventId, characterCount): Promise<TtsQuotaOutcome> {
      const rows = await sql<{ allowed: boolean; remaining: number; reason: string | null }[]>`
        select allowed, remaining, reason
          from app_private.meter_tts_usage(${eventId}::uuid, ${characterCount}::integer)
      `;
      const row = rows[0];
      if (!row) throw new Error('TTS quota metering did not return a result');
      if (row.allowed) return { allowed: true, remaining: row.remaining };
      const reason = row.reason === 'tier_not_entitled' ? 'tier_not_entitled' : 'quota_exhausted';
      return { allowed: false, reason, remaining: row.remaining };
    },
    async release(eventId, characterCount): Promise<void> {
      await sql`select app_private.release_tts_usage_reservation(${eventId}::uuid, ${characterCount}::integer)`;
    },
  };
}
