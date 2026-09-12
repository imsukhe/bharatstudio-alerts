import type { TtsAudio, TtsLocale } from '../tts/provider.js';

export type TtsEventInput = {
  eventId: string;
  message: string;
  locale: TtsLocale;
  voiceId?: string;
  model?: string;
  enabled: boolean;
  eligible: boolean;
};

export interface TtsStore {
  getEventInput(eventId: string): Promise<TtsEventInput | null>;
  storeAudio(eventId: string, audio: TtsAudio): Promise<string>;
  // Durable write-back for MASTER-PLAN §10.3 item 5 (browser/device TTS
  // fallback): records WHY premium synthesis was skipped for an
  // entitlement/quota reason (never for plain ineligibility) so the overlay
  // stream can tell the browser to speak the visible message instead of
  // going silent. Optional so a caller that has not wired quota metering
  // (see routes/tts.ts's own optional quotaMeter) keeps working unmetered.
  storeFallbackReason?(eventId: string, reason: 'tier_not_entitled' | 'quota_exhausted'): Promise<void>;
}
