import { createHash } from 'node:crypto';

export const TTS_TIMEOUT_MS = 1_500;
export const SUPPORTED_TTS_LOCALES = ['en-IN', 'hi-IN', 'bn-IN', 'ta-IN', 'te-IN', 'mr-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'pa-IN', 'or-IN', 'as-IN', 'ur-IN'] as const;
export type TtsLocale = typeof SUPPORTED_TTS_LOCALES[number];

export type TtsSynthesisRequest = {
  text: string;
  locale: TtsLocale;
  voiceId?: string;
  model?: string;
};

export type TtsAudio = { audioBase64: string; mimeType: 'audio/wav'; durationMs?: number; cacheKey: string };

export interface TtsProvider {
  synthesize(request: TtsSynthesisRequest): Promise<TtsAudio>;
}

export interface TtsCache {
  get(cacheKey: string): Promise<TtsAudio | null>;
  put(audio: TtsAudio): Promise<void>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function boundedText(value: string): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!normalized || normalized.length > 500) throw new Error('TTS text is outside the approved bounds');
  return normalized;
}

function cacheKey(request: TtsSynthesisRequest, text: string): string {
  return createHash('sha256').update(JSON.stringify({ text, locale: request.locale, voiceId: request.voiceId ?? 'bulbul:v1', model: request.model ?? 'bulbul:v1' })).digest('hex');
}

export function createSarvamTtsProvider(
  apiKey: string,
  endpoint = 'https://api.sarvam.ai/text-to-speech',
  fetcher: FetchLike = fetch,
): TtsProvider {
  if (!apiKey.trim()) throw new Error('Sarvam API key is required');
  const parsedEndpoint = new URL(endpoint);
  if (parsedEndpoint.protocol !== 'https:') throw new Error('Sarvam endpoint must use HTTPS');
  return {
    async synthesize(request) {
      const text = boundedText(request.text);
      if (!SUPPORTED_TTS_LOCALES.includes(request.locale)) throw new Error('TTS locale is not supported');
      const response = await fetcher(parsedEndpoint.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-subscription-key': apiKey },
        body: JSON.stringify({ inputs: [text], target_language_code: request.locale, speaker: request.voiceId ?? 'bulbul:v1', model: request.model ?? 'bulbul:v1' }),
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error('TTS provider request failed');
      const body = await response.json() as { audios?: unknown; duration_ms?: unknown };
      const audioBase64 = Array.isArray(body.audios) && typeof body.audios[0] === 'string' ? body.audios[0] : '';
      if (!audioBase64 || audioBase64.length > 2_000_000) throw new Error('TTS provider returned invalid audio');
      return { audioBase64, mimeType: 'audio/wav', durationMs: typeof body.duration_ms === 'number' ? body.duration_ms : undefined, cacheKey: cacheKey(request, text) };
    },
  };
}

export type TtsSynthesisResult =
  | { mode: 'audio'; audio: TtsAudio; cacheHit: boolean }
  | { mode: 'chime'; reason: 'provider_timeout' | 'provider_failure' | 'not_configured' };

export type TtsService = ReturnType<typeof createTtsService>;

export function createTtsService(provider?: TtsProvider, cache?: TtsCache) {
  return {
    async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
      if (!provider) return { mode: 'chime', reason: 'not_configured' };
      const normalizedText = boundedText(request.text);
      const key = cacheKey(request, normalizedText);
      const cached = await cache?.get(key);
      if (cached) return { mode: 'audio', audio: cached, cacheHit: true };
      try {
        const audio = await provider.synthesize({ ...request, text: normalizedText });
        await cache?.put(audio);
        return { mode: 'audio', audio, cacheHit: false };
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        return { mode: 'chime', reason: message.includes('timeout') || message.includes('abort') ? 'provider_timeout' : 'provider_failure' };
      }
    },
  };
}
