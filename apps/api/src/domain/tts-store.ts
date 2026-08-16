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
}
