/*
 * Pure, DOM-free helpers extracted out of page.tsx so they can be unit
 * tested directly — mirrors this codebase's own pattern of testing
 * overlay-policy.ts/tts-fallback.ts rather than the [overlayId] page
 * component itself, which needs a real browser/useParams context.
 */

export type OverlayGoal = {
  schemaVersion: 'v1';
  goalId: string;
  title: string;
  targetAmountPaise: number;
  window: 'stream' | 'daily' | 'monthly' | 'open';
  progressPaise: number;
  reached: boolean;
};

export function isOverlayGoal(value: unknown): value is OverlayGoal {
  if (!isExactRecord(value, ['schemaVersion', 'goalId', 'title', 'targetAmountPaise', 'window', 'progressPaise', 'reached'])) return false;
  return value.schemaVersion === 'v1' && isBoundedString(value.goalId, 128) && isBoundedString(value.title, 160)
    && isNonNegativeSafeInteger(value.targetAmountPaise) && isNonNegativeSafeInteger(value.progressPaise)
    && (value.window === 'stream' || value.window === 'daily' || value.window === 'monthly' || value.window === 'open')
    && typeof value.reached === 'boolean';
}

export function progressPercent(goal: Pick<OverlayGoal, 'progressPaise' | 'targetAmountPaise'>): number {
  if (goal.targetAmountPaise <= 0) return 0;
  return Math.min(100, Math.round((goal.progressPaise / goal.targetAmountPaise) * 100));
}

export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}
import { isBoundedString, isExactRecord, isNonNegativeSafeInteger } from '../shared/response-validation';
