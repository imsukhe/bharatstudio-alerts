/*
 * Boss Fight module (§6 #4): "A visual skin over an ordinary support
 * goal — not a new mechanic." This task's own §1(c) is explicit that
 * adding a table, an event type, or a second progress computation is a
 * misreading of that sentence. So this file is deliberately almost
 * nothing: it reads the exact same `/v1/overlay-goals/:overlayId`
 * snapshot the Community Goal Ladder module reads (goal-ladder-
 * module.ts), and calls the SAME `progressPercent`/`formatRupees`/
 * `isOverlayGoal` helpers from goal-widget-logic.ts — imported, not
 * re-implemented. The only thing this module owns is a different DOM
 * shape/labels ("boss health" framing instead of a goal-ladder framing)
 * over that identical data.
 *
 * "Boss health" is rendered as the goal's own progress, inverted for the
 * bar-drains-as-the-boss-takes-damage read a "boss fight" visual implies
 * — 1 - progressPercent(goal)/100 — which is arithmetic on the existing
 * function's output, not a second computation of progress itself. The
 * underlying truth (how much has been raised, whether the goal is
 * reached) is never recomputed here.
 *
 * COMPOSITE-ONLY (PRF-03): identical technique to goal-ladder-module.ts
 * — a static-size track element created once, `transform: scaleX()` for
 * the health fill, never `width`/`height`.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';
import { formatRupees, isOverlayGoal, progressPercent, type OverlayGoal } from '../../widgets/goal/goal-widget-logic';

export interface BossFightModuleOptions {
  container: HTMLElement;
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<OverlayGoal | null>;
  reducedMotion: () => boolean;
  titleStyle?: CanvasTextStyle;
  amountStyle?: CanvasTextStyle;
}

export function createBossFightModule(options: BossFightModuleOptions): CanvasModuleDefinition {
  const titleStyle = options.titleStyle ?? defaultCanvasTextStyles().title;
  const amountStyle = options.amountStyle ?? defaultCanvasTextStyles().amount;

  let ready = false;
  let titleEl: HTMLElement;
  let trackEl: HTMLElement;
  let healthEl: HTMLElement;
  let amountsEl: HTMLElement;
  let latestGoal: OverlayGoal | null = null;
  let dirty = false;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;

  function ensureElements() {
    if (ready) return;
    const doc = options.container.ownerDocument;
    options.container.textContent = '';
    options.container.style.opacity = '0'; // nothing to show until the first real snapshot lands

    titleEl = doc.createElement('div');
    titleEl.dataset.role = 'boss-fight-title';
    titleEl.style.fontFamily = titleStyle.fontFamily;

    trackEl = doc.createElement('div');
    trackEl.dataset.role = 'boss-fight-track';
    // Static size set once — never written to again (PRF-03).
    trackEl.style.position = 'relative';
    trackEl.style.overflow = 'hidden';
    trackEl.style.height = '14px';

    healthEl = doc.createElement('div');
    healthEl.dataset.role = 'boss-fight-health';
    healthEl.style.position = 'absolute';
    healthEl.style.inset = '0';
    healthEl.style.transformOrigin = 'left center';
    healthEl.style.transform = 'scaleX(1)'; // full health until the first snapshot lowers it
    healthEl.style.transition = options.reducedMotion() ? 'none' : 'transform 400ms ease';

    amountsEl = doc.createElement('div');
    amountsEl.dataset.role = 'boss-fight-amounts';
    amountsEl.style.fontFamily = amountStyle.fontFamily;

    trackEl.appendChild(healthEl);
    options.container.append(titleEl, trackEl, amountsEl);
    ready = true;
  }

  async function refetch() {
    const token = ++fetchToken;
    const result = await options.fetchSnapshot().catch(() => null);
    if (token !== fetchToken) return; // superseded — discard, never render as current
    latestGoal = result && isOverlayGoal(result) ? result : null;
    dirty = true;
  }

  return {
    key: 'boss_fight',
    activate() {
      ensureElements();
      unsubscribeConnection = options.connection.subscribe(() => { void refetch(); });
    },
    deactivate() {
      unsubscribeConnection?.();
      unsubscribeConnection = undefined;
      fetchToken += 1;
      dirty = false;
    },
    render() {
      if (!dirty) return;
      dirty = false;
      ensureElements();
      const goal = latestGoal;
      if (!goal) {
        if (options.container.style.opacity !== '0') options.container.style.opacity = '0';
        return;
      }
      if (options.container.style.opacity !== '1') options.container.style.opacity = '1';
      if (titleEl.textContent !== goal.title) titleEl.textContent = goal.title;
      // The ONLY computation this module performs on top of the shared
      // progressPercent(goal) — inverting it for a "remaining boss
      // health" read. Never a second source of truth for progress.
      const remainingFraction = Math.max(0, 1 - progressPercent(goal) / 100);
      const nextTransform = `scaleX(${remainingFraction})`;
      if (healthEl.style.transform !== nextTransform) healthEl.style.transform = nextTransform;
      const amountsText = `${formatRupees(goal.progressPaise)} / ${formatRupees(goal.targetAmountPaise)}${goal.reached ? ' — Boss defeated!' : ''}`;
      if (amountsEl.textContent !== amountsText) amountsEl.textContent = amountsText;
    },
  };
}
