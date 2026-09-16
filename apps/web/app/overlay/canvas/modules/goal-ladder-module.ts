/*
 * Community Goal Ladder module. Reuses the existing goal domain helpers
 * (apps/web/app/overlay/widgets/goal/goal-widget-logic.ts —
 * isOverlayGoal/progressPercent/formatRupees) rather than forking them;
 * the existing standalone goal widget page
 * (apps/web/app/overlay/widgets/goal/[overlayId]/page.tsx) reads the same
 * `/v1/overlay-goals/:overlayId` endpoint this module's `fetchSnapshot`
 * is expected to call.
 *
 * COMPOSITE-ONLY (PRF-03) — the one correction against the existing
 * standalone widget worth calling out: that page animates the fill bar
 * with `.goal-widget-fill { transition: width 400ms ease }`, i.e. it
 * animates `width`, a layout-triggering property. This module never does
 * — the fill bar has a fixed-size track element created once, and
 * progress is expressed as `transform: scaleX(progress / 100)` with
 * `transform-origin: left`, which only ever triggers compositing.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';
import { formatRupees, isOverlayGoal, progressPercent, type OverlayGoal } from '../../widgets/goal/goal-widget-logic';

export interface GoalLadderModuleOptions {
  container: HTMLElement;
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<OverlayGoal | null>;
  reducedMotion: () => boolean;
  titleStyle?: CanvasTextStyle;
  amountStyle?: CanvasTextStyle;
}

export function createGoalLadderModule(options: GoalLadderModuleOptions): CanvasModuleDefinition {
  const titleStyle = options.titleStyle ?? defaultCanvasTextStyles().title;
  const amountStyle = options.amountStyle ?? defaultCanvasTextStyles().amount;

  let ready = false;
  let titleEl: HTMLElement;
  let trackEl: HTMLElement;
  let fillEl: HTMLElement;
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
    titleEl.dataset.role = 'goal-ladder-title';
    titleEl.style.fontFamily = titleStyle.fontFamily;

    trackEl = doc.createElement('div');
    trackEl.dataset.role = 'goal-ladder-track';
    // A STATIC size set once at creation is not an animation — PRF-03
    // forbids animating a layout property, not declaring one. Nothing
    // below ever writes trackEl.style.width/height after this.
    trackEl.style.position = 'relative';
    trackEl.style.overflow = 'hidden';
    trackEl.style.height = '14px';

    fillEl = doc.createElement('div');
    fillEl.dataset.role = 'goal-ladder-fill';
    fillEl.style.position = 'absolute';
    fillEl.style.inset = '0';
    fillEl.style.transformOrigin = 'left center';
    fillEl.style.transform = 'scaleX(0)';
    fillEl.style.transition = options.reducedMotion() ? 'none' : 'transform 400ms ease';

    amountsEl = doc.createElement('div');
    amountsEl.dataset.role = 'goal-ladder-amounts';
    amountsEl.style.fontFamily = amountStyle.fontFamily;

    trackEl.appendChild(fillEl);
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
    key: 'community_goal_ladder',
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
      const scale = String(progressPercent(goal) / 100);
      const nextTransform = `scaleX(${scale})`;
      if (fillEl.style.transform !== nextTransform) fillEl.style.transform = nextTransform;
      const amountsText = `${formatRupees(goal.progressPaise)} / ${formatRupees(goal.targetAmountPaise)}${goal.reached ? ' — Goal reached!' : ''}`;
      if (amountsEl.textContent !== amountsText) amountsEl.textContent = amountsText;
    },
  };
}
