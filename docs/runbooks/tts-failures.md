# Runbook: TTS failures

**Metric:** `bsa_tts_failures_total{reason="provider_error"|"timeout"|"quota_exhausted"|"other"}` (counter, request-time — NOT YET WIRED)
**Source:** `ApiMetrics.recordTtsFailure` — `apps/api/src/observability/metrics.ts`
**Severity:** investigate same-shift once wired. Not financial (delivery still
happens visually, see below), but it's a paid-for feature silently degrading.

## Status: instrumentation exists, call site does not

This counter is defined and unit-tested
(`apps/api/test/l09-reliability-metrics.test.ts`), but nothing calls
`metrics.recordTtsFailure(...)` yet. The call belongs in
`apps/api/src/routes/tts.ts` `POST /internal/v1/tts/events/:eventId`, which
this task does not own. See the L09 build report, "Wiring needed", for the
exact call to add. `quota_exhausted` should NOT be recorded as a failure for
the existing `mode: 'chime', reason: quota.reason` early-return in that route
— that's expected tier-limit behavior (§3.2), not a failure; only record it if
you want to track exhaustion rate separately from provider failures, using a
different counter or label than the other three reasons.

## What fires (once wired)

- `provider_error` — the TTS provider (`TtsService.synthesize`, see
  `apps/api/src/tts/provider.ts`) returned an error rather than
  `{mode:'audio'}` or the documented `{mode:'chime', reason}`.
- `timeout` — the provider call exceeded its timeout.
- `other` — any failure that doesn't fit the above (e.g.
  `store.storeAudio` failing to persist a successfully synthesized artifact).

## What it means

Per `routes/tts.ts`'s own comment: "Failure to create an artifact must never
change delivery state" — a TTS failure degrades to a silent/visual-only alert
(`mode: 'chime'`), it never blocks the underlying LiveEvent delivery. That's
correct behavior, but it also means TTS failures are invisible to the creator
and to delivery-success metrics. This counter is the only place they show up.

## What to check first (once wired)

1. Is it one provider error or many? Check the failure-reason breakdown —
   `provider_error` spiking alone points at the TTS provider being down or
   rate-limiting; `other` spiking points at this API's own storage path
   (`TtsStore.storeAudio`, `apps/api/src/db/tts-store.ts`).
2. Cross-check `alert_tts_cache` hit rate isn't relevant here (cache hits
   never call the provider) — a failure spike means synthesis attempts, not
   cache misses, are failing.
3. Check whether `alert_tts_fallback_reason` is being written correctly for
   affected events (migration `0096_v1_l03_tts_fallback_and_amount_ladder.sql`)
   — the overlay's browser-voice fallback depends on that reason being
   recorded; if it's missing, the viewer/creator gets silence, not even a
   fallback voice.

## What to do

- Isolated `provider_error` blips: check the TTS provider's own status page.
- Sustained provider failures: this is a vendor incident, not a code bug —
  confirm the browser-fallback path (§10.3 item 5) is actually degrading
  gracefully rather than going silent, by spot-checking a live overlay.
- `other` failures: check `apps/api/src/db/tts-store.ts` write path and DB
  health directly; this indicates a storage problem, not a provider problem.

## Cannot be validated without a deployment

Nothing here has fired even once — the call site doesn't exist yet. No real
TTS provider failure has ever been observed through this counter. TTS spend
metering itself is also still open per MASTER-PLAN §10.3 item 4 ("Meter TTS
spend. Nothing does today.") — that is a separate, unmetered gap this counter
does not address.
