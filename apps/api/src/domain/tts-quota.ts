// L03 TTS character metering (MASTER-PLAN §3.2/§10.3 item 4). Resolves
// channel/tier from the already-durable alert event itself (never from a
// caller-supplied value), so the hard stop can't be argued around from the
// route layer.
export type TtsQuotaOutcome =
  | { allowed: true; remaining: number }
  | { allowed: false; reason: 'tier_not_entitled' | 'quota_exhausted'; remaining: number };

export interface TtsQuotaMeter {
  meter(eventId: string, characterCount: number): Promise<TtsQuotaOutcome>;
  // §19.0 RT-03 / RT-03.6 (blocking acceptance test, not an assumption): a
  // failed synthesis must not consume premium characters. meter() settles
  // the charge immediately, before the provider call, so every synthesis
  // failure path after a successful meter() call must release the same
  // characterCount back with this method before responding. A safe no-op
  // if the reservation no longer applies (e.g. the billing month rolled
  // over between reserve and release) -- it must never go negative and
  // must never manufacture quota that was not reserved.
  release(eventId: string, characterCount: number): Promise<void>;
}
