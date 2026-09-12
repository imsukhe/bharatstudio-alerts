/*
 * Pure, DOM-free helpers extracted out of page.tsx so they can be unit
 * tested directly — mirrors ../goal/goal-widget-logic.ts's own pattern of
 * testing the logic separately from the [overlayId] page component, which
 * needs a real browser/useParams context.
 */

export type ChallengeKind = 'stake' | 'bounty';
export type ChallengeState = 'draft' | 'active' | 'succeeded' | 'failed' | 'cancelled';

export type OverlayChallenge = {
  schemaVersion: 'v1';
  challengeId: string;
  title: string;
  kind: ChallengeKind;
  targetAmountPaise: number;
  state: ChallengeState;
  progressPaise: number;
  targetReached: boolean;
};

/**
 * Locked product copy — identical string to
 * apps/api/src/domain/challenge-store.ts's CHALLENGE_FAILURE_COPY. Not
 * imported directly (the widget has no server-side module graph access,
 * only the JSON the API sends), but kept byte-identical here on purpose
 * so a contributor sees the same sentence on the overlay as on the
 * dashboard. See this task's report, "The no-refund consequence".
 */
export const CHALLENGE_FAILURE_COPY =
  'Contributing to a challenge is a tip to the creator, not an escrowed payment — BharatStudio holds no funds and cannot issue a refund. If this challenge fails or is cancelled, your contribution stays with the creator; only the creator can refund you, and only from their own connected payment provider.';

export function isOverlayChallenge(value: unknown): value is OverlayChallenge {
  if (!isExactRecord(value, ['schemaVersion', 'challengeId', 'title', 'kind', 'targetAmountPaise', 'state', 'progressPaise', 'targetReached'])) return false;
  return value.schemaVersion === 'v1' && isBoundedString(value.challengeId, 128) && isBoundedString(value.title, 160)
    && (value.kind === 'stake' || value.kind === 'bounty')
    && isNonNegativeSafeInteger(value.targetAmountPaise) && isNonNegativeSafeInteger(value.progressPaise)
    && typeof value.targetReached === 'boolean'
    && (value.state === 'draft' || value.state === 'active' || value.state === 'succeeded' || value.state === 'failed' || value.state === 'cancelled');
}

export function progressPercent(challenge: Pick<OverlayChallenge, 'progressPaise' | 'targetAmountPaise'>): number {
  if (challenge.targetAmountPaise <= 0) return 0;
  return Math.min(100, Math.round((challenge.progressPaise / challenge.targetAmountPaise) * 100));
}

export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

/** A draft challenge has not started and is never shown on stream. */
export function isWidgetVisible(challenge: OverlayChallenge): boolean {
  return challenge.state !== 'draft';
}
import { isBoundedString, isExactRecord, isNonNegativeSafeInteger } from '../shared/response-validation';
