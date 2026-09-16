/*
 * Tug-of-War Vote module (§6 #3): "Two-sided transparent result bar."
 * Rides the slice-1 runtime exactly like every other module — one shared
 * connection tells it WHEN to re-read (master-canvas-connection.ts), its
 * own REST snapshot fetch (`/v1/overlay-widgets/:overlayId/tug-of-war-
 * vote`, backed by apps/api/src/db/vote-payment-sql-store.ts's
 * createSqlTugOfWarVoteOverlayStore — the EXISTING paid-vote
 * infrastructure, not a parallel one) is the only source of a displayed
 * value, and every DOM write happens inside render(), driven by the one
 * shared rAF loop.
 *
 * TWO BARS, ANCHORED AT OPPOSITE ENDS: the left side's fill grows from
 * the left edge (`transform-origin: left`, `scaleX(fractionA)`); the
 * right side's fill grows from the right edge (`transform-origin: right`,
 * `scaleX(fractionB)`). Since fractionA + fractionB === 1 (see
 * tug-of-war-vote-logic.ts's optionPaidFraction), the two fills always
 * meet at exactly the point that represents the real ratio of money paid
 * — composite-only (PRF-03), never a layout-triggering width.
 *
 * TRANSPARENCY (this task's §1(b) — full definition and reasoning in
 * tug-of-war-vote-logic.ts's header and reviews/2026-09-16-prf-02-
 * slice-2-implementation.md): both the fraction (the bar) and the exact
 * rupee amount for each side are rendered from the SAME fetched tally,
 * recomputed on every render — there is no running counter anywhere in
 * this module that could diverge from the durable record.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';
import {
  formatRupees,
  isTugOfWarVoteTally,
  optionPaidFraction,
  totalPaidAmountPaise,
  type TugOfWarVoteTally,
} from './tug-of-war-vote-logic';

export interface TugOfWarVoteModuleOptions {
  container: HTMLElement;
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<TugOfWarVoteTally | null>;
  reducedMotion: () => boolean;
  labelStyle?: CanvasTextStyle;
  amountStyle?: CanvasTextStyle;
}

export function createTugOfWarVoteModule(options: TugOfWarVoteModuleOptions): CanvasModuleDefinition {
  const labelStyle = options.labelStyle ?? defaultCanvasTextStyles().label;
  const amountStyle = options.amountStyle ?? defaultCanvasTextStyles().amount;

  let ready = false;
  let trackEl: HTMLElement;
  let leftFillEl: HTMLElement;
  let rightFillEl: HTMLElement;
  let leftLabelEl: HTMLElement;
  let rightLabelEl: HTMLElement;
  let statusEl: HTMLElement;
  let latestTally: TugOfWarVoteTally | null = null;
  let dirty = false;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;

  function ensureElements() {
    if (ready) return;
    const doc = options.container.ownerDocument;
    options.container.textContent = '';
    options.container.style.opacity = '0'; // nothing to show until the first real snapshot lands

    trackEl = doc.createElement('div');
    trackEl.dataset.role = 'tug-of-war-track';
    // Static size set once at creation — never written to again (PRF-03
    // forbids ANIMATING a layout property, not declaring a fixed one).
    trackEl.style.position = 'relative';
    trackEl.style.overflow = 'hidden';
    trackEl.style.height = '18px';

    leftFillEl = doc.createElement('div');
    leftFillEl.dataset.role = 'tug-of-war-left-fill';
    leftFillEl.style.position = 'absolute';
    leftFillEl.style.inset = '0';
    leftFillEl.style.transformOrigin = 'left center';
    leftFillEl.style.transform = 'scaleX(0.5)';
    leftFillEl.style.transition = options.reducedMotion() ? 'none' : 'transform 300ms ease';

    rightFillEl = doc.createElement('div');
    rightFillEl.dataset.role = 'tug-of-war-right-fill';
    rightFillEl.style.position = 'absolute';
    rightFillEl.style.inset = '0';
    rightFillEl.style.transformOrigin = 'right center';
    rightFillEl.style.transform = 'scaleX(0.5)';
    rightFillEl.style.transition = options.reducedMotion() ? 'none' : 'transform 300ms ease';

    leftLabelEl = doc.createElement('div');
    leftLabelEl.dataset.role = 'tug-of-war-left-label';
    leftLabelEl.style.fontFamily = labelStyle.fontFamily;

    rightLabelEl = doc.createElement('div');
    rightLabelEl.dataset.role = 'tug-of-war-right-label';
    rightLabelEl.style.fontFamily = labelStyle.fontFamily;

    statusEl = doc.createElement('div');
    statusEl.dataset.role = 'tug-of-war-status';
    statusEl.style.fontFamily = amountStyle.fontFamily;

    trackEl.append(leftFillEl, rightFillEl);
    options.container.append(leftLabelEl, trackEl, rightLabelEl, statusEl);
    ready = true;
  }

  async function refetch() {
    const token = ++fetchToken;
    const result = await options.fetchSnapshot().catch(() => null);
    if (token !== fetchToken) return; // superseded — discard, never render as current
    latestTally = result && isTugOfWarVoteTally(result) ? result : null;
    dirty = true;
  }

  return {
    key: 'tug_of_war_vote',
    activate() {
      ensureElements();
      unsubscribeConnection = options.connection.subscribe(() => { void refetch(); });
    },
    deactivate() {
      unsubscribeConnection?.();
      unsubscribeConnection = undefined;
      fetchToken += 1; // any in-flight fetch response is now discarded on arrival
      dirty = false;
    },
    render() {
      if (!dirty) return;
      dirty = false;
      ensureElements();
      const tally = latestTally;
      if (!tally) {
        if (options.container.style.opacity !== '0') options.container.style.opacity = '0';
        return;
      }
      if (options.container.style.opacity !== '1') options.container.style.opacity = '1';

      const [optionA, optionB] = tally.options; // exactly two — enforced by isTugOfWarVoteTally
      const fractionA = optionPaidFraction(optionA, tally);
      const fractionB = optionPaidFraction(optionB, tally);
      const totalPaise = totalPaidAmountPaise(tally);

      const leftTransform = `scaleX(${fractionA})`;
      if (leftFillEl.style.transform !== leftTransform) leftFillEl.style.transform = leftTransform;
      const rightTransform = `scaleX(${fractionB})`;
      if (rightFillEl.style.transform !== rightTransform) rightFillEl.style.transform = rightTransform;

      const leftText = `${optionA.label} — ${formatRupees(optionA.amountPaise)}${totalPaise > 0 ? ` (${Math.round(fractionA * 100)}%)` : ''}`;
      if (leftLabelEl.textContent !== leftText) leftLabelEl.textContent = leftText;
      const rightText = `${optionB.label} — ${formatRupees(optionB.amountPaise)}${totalPaise > 0 ? ` (${Math.round(fractionB * 100)}%)` : ''}`;
      if (rightLabelEl.textContent !== rightText) rightLabelEl.textContent = rightText;

      // Transparency (§1(b)): the total actually paid is always shown
      // alongside the result — never only a bar, and never a resolved
      // claim not backed by the same tally row that produced it.
      const winnerLabel = tally.resolvedOptionKey === optionA.optionKey ? optionA.label
        : tally.resolvedOptionKey === optionB.optionKey ? optionB.label : null;
      const statusText = tally.resolved
        ? `Total ${formatRupees(totalPaise)} — Resolved${winnerLabel ? `: ${winnerLabel}` : ' — no votes paid'}`
        : `Total ${formatRupees(totalPaise)}`;
      if (statusEl.textContent !== statusText) statusEl.textContent = statusText;
    },
  };
}
