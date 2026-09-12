// L03 TTS character metering (MASTER-PLAN §3.2/§10.3 item 4). Resolves
// channel/tier from the already-durable alert event itself (never from a
// caller-supplied value), so the hard stop can't be argued around from the
// route layer.
export type TtsQuotaOutcome =
  | { allowed: true; remaining: number }
  | { allowed: false; reason: 'tier_not_entitled' | 'quota_exhausted'; remaining: number };

export interface TtsQuotaMeter {
  meter(eventId: string, characterCount: number): Promise<TtsQuotaOutcome>;
}
