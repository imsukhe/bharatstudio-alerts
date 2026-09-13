// L23: AI assist, bounded — the provider seam.
//
// NO MODEL PROVIDER IS CHOSEN OR INTEGRATED HERE. There is no dated
// evidence for any provider's terms, data handling, or retention, and
// choosing one is a privacy decision requiring counsel (governance/AGENTS.md:28),
// not an engineering one. This file defines the interface a future provider
// integration would implement, and ships the only implementation that runs
// today: a local, deterministic, zero-network generator. Wiring a real
// provider behind AssistSuggestionProvider is a later, deliberate choice —
// swapping the implementation passed into registerAssistRoutes — never a
// side effect of this task.
//
// DATA CONTRACT — exactly what a future provider call would receive, and
// what it never would:
//
//   WOULD cross the seam (AssistGenerationRequest, below):
//     - surface (one of the five closed enum values)
//     - channel tier ('free' | 'pro' | 'creator' | 'studio')
//     - aggregated, non-identifying signals already computed server-side
//       for the surface (e.g. "average queue idle seconds", a target
//       locale code like 'hi-IN', a draft title string the creator typed
//       for challenge-copy assistance)
//     - the channel's own existing config values relevant to the surface
//       (e.g. current alert style keys/values) — configuration, not people
//
//   NEVER crosses the seam, under any circumstance, from any caller of
//   this interface:
//     - donor / viewer names, handles, or any identity field
//     - donor / viewer message text (the actual tip/alert message content)
//     - payment data of any kind (amounts tied to a person, payment IDs,
//       provider references, payout/bank details)
//     - viewer session, device, or contact identifiers
//     - any field not explicitly listed in AssistGenerationRequest below
//
// The type below is intentionally narrow — narrower than "whatever object
// is easy to pass" — so that a future provider integration cannot silently
// widen what crosses the seam without changing this file's shape, which is
// the point at which that widening becomes a reviewable, deliberate change.

import type { AssistSurface } from './assist-types.js';

export type AssistGenerationRequest = {
  surface: AssistSurface;
  tier: 'free' | 'pro' | 'creator' | 'studio';
  /** Non-identifying signal, e.g. { averageQueueIdleSeconds: 97 } or { targetLocale: 'hi-IN' } or { draftTitle: 'Shave my head at target' }. */
  signal: Record<string, string | number | boolean>;
};

export type AssistGenerationOutput = {
  suggestedPayload: Record<string, unknown>;
  basis: string;
};

export interface AssistSuggestionProvider {
  generate(request: AssistGenerationRequest): Promise<AssistGenerationOutput>;
}

// The shipping default. Purely rule-based, no network call, no external
// dependency — satisfies "define the seam; do not fill it" by construction
// rather than by policy. Every branch below only ever reads `request`,
// never anything wider (no access to a store, no ambient user/session data),
// which is what keeps this implementation honest about the data contract
// above: it CANNOT leak personal data because it never receives any.
export function createLocalAssistProvider(): AssistSuggestionProvider {
  return {
    async generate(request: AssistGenerationRequest): Promise<AssistGenerationOutput> {
      switch (request.surface) {
        case 'config': {
          const idle = Number(request.signal.averageQueueIdleSeconds ?? 0);
          return {
            suggestedPayload: { suggestedQueueMode: idle > 60 ? 'auto_advance' : 'manual' },
            basis: `rule: average queue idle ${idle}s`,
          };
        }
        case 'challenge_copy': {
          const title = String(request.signal.draftTitle ?? 'Untitled challenge');
          return {
            suggestedPayload: { suggestedDescription: `Help us reach the goal: ${title}. Every contribution counts!` },
            basis: 'rule: templated encouragement copy from draft title',
          };
        }
        case 'translation': {
          const locale = String(request.signal.targetLocale ?? 'en');
          return {
            suggestedPayload: { targetLocale: locale, translatedText: null },
            basis: `rule: translation stub for locale ${locale} (no provider integrated)`,
          };
        }
        case 'alert_style': {
          return {
            suggestedPayload: { suggestedDisplayMs: request.tier === 'free' ? 4000 : 6000 },
            basis: `rule: tier-appropriate display duration for ${request.tier}`,
          };
        }
        case 'moderation': {
          const flagged = Boolean(request.signal.matchedFlaggedTerm);
          return {
            suggestedPayload: { suggestedAction: flagged ? 'hold' : 'approve' },
            basis: flagged ? 'rule: message matched a flagged-term list entry' : 'rule: no flagged-term match',
          };
        }
      }
    },
  };
}
