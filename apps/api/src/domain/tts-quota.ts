// L03 TTS character metering (MASTER-PLAN §3.2/§10.3 item 4). Resolves
// channel/tier from the already-durable alert event itself (never from a
// caller-supplied value), so the hard stop can't be argued around from the
// route layer.
export type TtsQuotaOutcome =
  // §19.0 RT-03 correction 2026-09-16 (migration 0134): an allowed meter
  // returns the id of the durable reservation row it just wrote. That id --
  // never a character count -- is what release() consumes, which is what
  // makes release idempotent and month-correct. `null` means the meter
  // charged nothing (a zero-character message), so there is nothing to
  // release.
  | { allowed: true; remaining: number; reservationId: string | null }
  | { allowed: false; reason: 'tier_not_entitled' | 'quota_exhausted'; remaining: number };

export interface TtsQuotaMeter {
  meter(eventId: string, characterCount: number): Promise<TtsQuotaOutcome>;
  // §19.0 RT-03 / RT-03.6 (blocking acceptance test, not an assumption): a
  // failed synthesis must not consume premium characters. meter() settles
  // the charge immediately, before the provider call, so every synthesis
  // failure path after a successful meter() call must release that
  // reservation before responding.
  //
  // Releasing the same reservation twice is a no-op, and a release always
  // credits the billing month the reservation was CHARGED to even if the
  // month has since rolled over. Both properties are enforced by
  // app_private.release_tts_usage_reservation's own durable state (0134),
  // not by this interface's callers -- 0128 left them as a caller-side
  // invariant written in a comment, and a comment is not enforcement.
  release(reservationId: string): Promise<void>;
}
