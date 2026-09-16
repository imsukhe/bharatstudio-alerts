/*
 * Pure, DOM-free helpers for the Tug-of-War Vote module — mirrors
 * ../../widgets/goal/goal-widget-logic.ts's and
 * ../../widgets/vote/vote-widget-logic.ts's own pattern (testable
 * directly, no browser/useParams context needed).
 *
 * TRANSPARENCY DEFINITION (this task's §1(b), recorded in full in
 * reviews/2026-09-16-prf-02-slice-2-implementation.md — no market
 * precedent exists for a real-money paid vote's fairness model, so this
 * is a deliberate, written product decision, not a copy of anything):
 *
 *   A two-sided paid vote is transparent when a viewer and a creator can
 *   both see that the displayed bar follows from what was actually paid
 *   — never from a value that could diverge from the durable record.
 *   Concretely, this module:
 *     1. Never holds its own running total. `totalPaidAmountPaise` and
 *        `optionPaidFraction` below are pure functions of the CURRENT
 *        server response, recomputed from scratch on every render — there
 *        is no counter field anywhere in this module that persists across
 *        fetches and could drift from the server's own tally.
 *     2. Renders the exact rupee amount for each side, not only a
 *        percentage — a percentage alone can visually round away a
 *        divergence; the amount is the thing that was actually paid.
 *     3. Reads from the exact same money-derived tally
 *        (app_private.list_overlay_tug_of_war_vote, 0132) that the
 *        creator's own dashboard tally
 *        (app_private.paid_support_vote_tally, 0108, unchanged) and the
 *        standalone OBS paid-vote widget both read — one join, one
 *        answer, three surfaces, never three separate derivations that
 *        could disagree.
 */

export type TugOfWarVoteOption = { optionKey: string; label: string; amountPaise: number };
export type TugOfWarVoteTally = {
  schemaVersion: 'v1';
  votingMode: 'paid';
  options: TugOfWarVoteOption[];
  resolved: boolean;
  resolvedOptionKey: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isOption(value: unknown): value is TugOfWarVoteOption {
  const row = record(value);
  return !!row && exactKeys(row, ['optionKey', 'label', 'amountPaise'])
    && typeof row.optionKey === 'string' && row.optionKey.length > 0 && row.optionKey.length <= 80
    && typeof row.label === 'string' && row.label.length > 0 && row.label.length <= 160
    && isNonNegativeSafeInteger(row.amountPaise);
}

// "Two-sided" (§6) is enforced structurally here, not merely assumed by
// the renderer: exactly two options, or this is not a valid tally.
export function isTugOfWarVoteTally(value: unknown): value is TugOfWarVoteTally {
  const row = record(value);
  if (!row || !exactKeys(row, ['schemaVersion', 'votingMode', 'options', 'resolved', 'resolvedOptionKey'])) return false;
  if (row.schemaVersion !== 'v1' || row.votingMode !== 'paid') return false;
  if (!Array.isArray(row.options) || row.options.length !== 2 || !row.options.every(isOption)) return false;
  if (typeof row.resolved !== 'boolean') return false;
  if (row.resolvedOptionKey !== null && !(typeof row.resolvedOptionKey === 'string' && row.resolvedOptionKey.length <= 80)) return false;
  return true;
}

export function totalPaidAmountPaise(tally: Pick<TugOfWarVoteTally, 'options'>): number {
  return tally.options.reduce((sum, option) => sum + Math.max(0, option.amountPaise), 0);
}

// The side's share of the total, in [0, 1] — 0.5/0.5 (an even split, drawn
// as a bar meeting exactly in the middle) when nothing has been paid yet,
// never a division by zero.
export function optionPaidFraction(option: TugOfWarVoteOption, tally: Pick<TugOfWarVoteTally, 'options'>): number {
  const total = totalPaidAmountPaise(tally);
  if (total <= 0) return 0.5;
  return Math.max(0, option.amountPaise) / total;
}

export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}
