import { bracketFor, truncateMessage, type OverlayConfig, type OverlayItem } from '../overlay-policy';

/**
 * MASTER-PLAN §10.3 item 5 — browser/device TTS fallback.
 *
 * Fires only when the API durably recorded (apps/api/src/routes/tts.ts,
 * migration 0096's app_private.store_alert_tts_fallback_reason) that premium
 * synthesis was skipped for an entitlement/quota reason — never for plain
 * ineligibility (a creator who never turned TTS on for this bracket), and
 * never as a client-side guess. This function is read-only presentation
 * logic: it does not call the API, so engaging it can never consume paid
 * quota — the quota meter (packages/db/migrations/0081/0096) is the only
 * thing that ever increments alert_tts_usage_monthly.
 */
export type BrowserTtsFallback =
  | { engage: false }
  | { engage: true; text: string; locale: string };

const FALLBACK_REASONS = new Set(['tier_not_entitled', 'quota_exhausted']);

export function browserTtsFallback(item: OverlayItem, config: OverlayConfig, hadProviderAudioUrl: boolean): BrowserTtsFallback {
  if (hadProviderAudioUrl) return { engage: false };
  const bracket = bracketFor(item, config);
  if (!config.tts.enabled || !bracket.ttsEligible) return { engage: false };
  const reason = item.payload.ttsFallbackReason;
  if (typeof reason !== 'string' || !FALLBACK_REASONS.has(reason)) return { engage: false };
  const text = truncateMessage(item.payload.message, bracket.charLimit);
  if (!text) return { engage: false };
  return { engage: true, text, locale: config.locale };
}

/**
 * MASTER-PLAN §3.4/§10.3 item 7 — watermark on Free only. `watermark` is
 * computed server-side (migration 0096's app_private.get_overlay_events,
 * `coalesce(tier, 'free') = 'free'`) so the overlay never has to re-derive
 * tier itself; it only renders what the API already decided.
 */
export function shouldShowWatermark(item: OverlayItem): boolean {
  return item.payload.watermark === true;
}

type SpeechWindow = typeof window & {
  speechSynthesis?: SpeechSynthesis;
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
};

/**
 * Best-effort only. A browser with no Web Speech API (or one that throws)
 * must degrade to text-only — the visual card is already on screen — never
 * to a thrown error and never to the paid-provider chime.
 */
export function speakWithBrowserTts(text: string, locale: string): void {
  try {
    if (typeof window === 'undefined') return;
    const target = window as SpeechWindow;
    const synth = target.speechSynthesis;
    const UtteranceCtor = target.SpeechSynthesisUtterance;
    if (!synth || !UtteranceCtor) return;
    const utterance = new UtteranceCtor(text);
    utterance.lang = locale;
    synth.cancel();
    synth.speak(utterance);
  } catch {
    // Degrade to text-only silently — see function comment.
  }
}

export function cancelBrowserTts(): void {
  try {
    if (typeof window === 'undefined') return;
    (window as SpeechWindow).speechSynthesis?.cancel();
  } catch {
    // No-op — cancellation is best-effort cleanup only.
  }
}
