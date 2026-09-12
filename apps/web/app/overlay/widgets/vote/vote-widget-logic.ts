/*
 * Pure, DOM-free helpers for the support-vote overlay widget — mirrors
 * ../goal/goal-widget-logic.ts's own pattern (testable directly, no
 * browser/useParams context needed).
 */

export type OverlayVoteOption = { optionKey: string; label: string; voteCount: number };
export type OverlayVoteTally = { schemaVersion: 'v1'; options: OverlayVoteOption[]; resolved: boolean; resolvedOptionKey: string | null };

export function isOverlayVoteTally(value: unknown): value is OverlayVoteTally {
  if (!isExactRecord(value, ['schemaVersion', 'options', 'resolved', 'resolvedOptionKey']) || value.schemaVersion !== 'v1'
    || !Array.isArray(value.options) || value.options.length > 16 || typeof value.resolved !== 'boolean'
    || (value.resolvedOptionKey !== null && !isBoundedString(value.resolvedOptionKey, 80))) return false;
  return value.options.every((option) => {
    return isExactRecord(option, ['optionKey', 'label', 'voteCount'])
      && isBoundedString(option.optionKey, 80) && isBoundedString(option.label, 160)
      && isNonNegativeSafeInteger(option.voteCount);
  });
}

export function totalVotes(tally: Pick<OverlayVoteTally, 'options'>): number {
  return tally.options.reduce((sum, option) => sum + Math.max(0, option.voteCount), 0);
}

export function optionPercent(option: OverlayVoteOption, tally: Pick<OverlayVoteTally, 'options'>): number {
  const total = totalVotes(tally);
  if (total <= 0) return 0;
  return Math.round((Math.max(0, option.voteCount) / total) * 100);
}
import { isBoundedString, isExactRecord, isNonNegativeSafeInteger } from '../shared/response-validation';
