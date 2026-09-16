/*
 * Milestone Celebration module (§6 #13): "One reusable animation fired by
 * verified state transitions." PRF-02 slice 4's own §1(a) is explicit
 * about which transitions and why they cost nothing new: the
 * **false→true edges** on `goal.reached` and on the paid vote's
 * `resolved`, both already present in the snapshots the Canvas already
 * fetches for the Community Goal Ladder / Boss Fight and Tug-of-War Vote
 * modules (`goal-widget-logic.ts`'s `OverlayGoal.reached`,
 * `tug-of-war-vote-logic.ts`'s `TugOfWarVoteTally.resolved`) — NO new
 * endpoint, NO new query, NO new event. This module is handed the SAME
 * `fetchGoalSnapshot`/`fetchVoteSnapshot` functions the host page already
 * built for the goal/vote modules (exactly the precedent
 * boss-fight-module.ts already set by reusing `fetchGoalSnapshot`
 * verbatim rather than duplicating it) — it does not own a second source
 * of truth for either field, only a second, independent read of the same
 * one.
 *
 * ONE REUSABLE ANIMATION, NOT ONE PER TRIGGER (§6's own wording: "One
 * reusable animation"): there is exactly one pair of DOM
 * elements/render path here, driven by whichever trigger fired
 * (`pendingLabel` is the only thing that differs between a goal-reached
 * celebration and a vote-resolved celebration) — never a second
 * implementation per module. Boss Fight rides the SAME goal object
 * Community Goal Ladder reads, so a goal's false→true edge is one
 * celebration shared by both surfaces, not two.
 *
 * NOT WIRED TO A CHALLENGE. Opus's decision (c), recorded in
 * `active/tasks/PRF-02.md`'s Slice 4 section: Challenge Board is
 * current-only this slice and exposes no target-reached edge a client can
 * observe cleanly (no distinct "just crossed the target" signal — only a
 * `state`/`targetReached` snapshot that could already be true the first
 * time this module ever sees it, same ambiguity `isRisingEdge` exists to
 * resolve for goal/vote, but wiring a third source here would go beyond
 * this task's named scope). Revisit when #8 grows past current-only.
 *
 * NOT SUPPORT THEATER'S ACKNOWLEDGEMENT STREAM. This is deliberately the
 * SAME shape every other snapshot module already uses —
 * `connection.subscribe()`, a plain "something may have changed, go
 * re-read" signal — never `connection.subscribeToEvents()`/
 * `acknowledge()`. Reaching for the acknowledgement stream here would be
 * exactly the transport mistake slice 3's Correction warns against: a
 * second, wrongly-scoped connection concern grafted onto a module that
 * has no acknowledgement semantics of its own.
 *
 * REDUCED MOTION — A GENUINELY STATIC ALTERNATIVE, NOT A SHORTER
 * ANIMATION (§15.4.3 "Reduced-motion variant of every animation", this
 * task's own §1(a) instruction: "a badge or banner swap, not merely
 * slower motion"): this module owns TWO separate, always-present DOM
 * elements — `milestone-celebration-animated` (a transform/opacity
 * pulse-and-fade burst, CSS-transitioned) and
 * `milestone-celebration-badge` (a distinct element with its own
 * text/colour affordance, opacity toggled with NO transition at all, so
 * its appearance is instantaneous rather than merely a faster version of
 * the same motion). Exactly one of the two is ever made visible per
 * trigger, chosen by `reducedMotion()` at render time — a reduced-motion
 * viewer sees the badge appear and disappear as a discrete state change,
 * never the burst played at a shorter duration.
 *
 * COMPOSITE-ONLY (PRF-03): both elements are driven exclusively by
 * `opacity`/`transform` — no width/height/top/left, ever.
 *
 * BOUNDED DOM: exactly four elements, created once in `ensureElements()`
 * and never appended to or recycled — this module never grows its own
 * DOM regardless of how many times it fires.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';
import { isOverlayGoal, type OverlayGoal } from '../../widgets/goal/goal-widget-logic';
import { isTugOfWarVoteTally, type TugOfWarVoteTally } from './tug-of-war-vote-logic';
import { isRisingEdge, type ObservedBoolean } from './milestone-celebration-logic';

// An engineering default for how long the celebration stays visible before
// clearing itself — same class of value as DEFAULT_THEATER_AGGREGATE_POOL_SIZE
// / the existing modules' transition durations; no authority states this
// number. Deliberately the SAME duration for both the animated burst and
// the static badge — the point of the reduced-motion path is a different
// PRESENTATION, not a shorter window to notice it in.
export const MILESTONE_CELEBRATION_VISIBLE_MS = 4_000;

export const GOAL_REACHED_LABEL = 'Goal reached!';
export const VOTE_RESOLVED_LABEL = 'Vote resolved!';

export interface MilestoneCelebrationModuleOptions {
  container: HTMLElement;
  /** The Canvas's ONE shared connection, used only as a re-read signal
   * (`subscribe`) — see file header, "NOT SUPPORT THEATER'S
   * ACKNOWLEDGEMENT STREAM." */
  connection: MasterCanvasConnection;
  /** Reused verbatim from the host page — the SAME function the goal
   * ladder/boss fight modules already call. No second source of truth. */
  fetchGoalSnapshot: () => Promise<OverlayGoal | null>;
  /** Reused verbatim from the host page — the SAME function the
   * tug-of-war vote module already calls. */
  fetchVoteSnapshot: () => Promise<TugOfWarVoteTally | null>;
  reducedMotion: () => boolean;
  labelStyle?: CanvasTextStyle;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export function createMilestoneCelebrationModule(options: MilestoneCelebrationModuleOptions): CanvasModuleDefinition {
  const labelStyle = options.labelStyle ?? defaultCanvasTextStyles().label;
  const setTimeoutImpl = options.setTimeoutImpl ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutImpl = options.clearTimeoutImpl ?? globalThis.clearTimeout.bind(globalThis);

  let ready = false;
  let burstEl: HTMLElement;
  let burstLabelEl: HTMLElement;
  let badgeEl: HTMLElement;
  let badgeLabelEl: HTMLElement;

  // Edge-tracking state deliberately lives for the LIFETIME OF THIS MODULE
  // OBJECT, not reset by activate()/deactivate() — see milestone-
  // celebration-logic.ts's header. Resetting it on every re-activation
  // (e.g. an OBS scene toggling visible/hidden) would make `undefined` the
  // starting point again and could either miss a genuine transition that
  // happened while inactive, or (worse) treat an already-true value seen
  // for the first time after reactivation as fresh — this module avoids
  // both by never forgetting what it last observed.
  let lastGoalReached: ObservedBoolean;
  let lastVoteResolved: ObservedBoolean;

  let visible = false;
  let pendingLabel = '';
  let dirty = false;
  let hideTimer: ReturnType<typeof setTimeoutImpl> | undefined;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;

  function ensureElements() {
    if (ready) return;
    const doc = options.container.ownerDocument;
    options.container.textContent = '';

    burstEl = doc.createElement('div');
    burstEl.dataset.role = 'milestone-celebration-animated';
    burstEl.style.opacity = '0';
    burstEl.style.transform = 'scale(0.85)';
    burstEl.style.transformOrigin = 'center center';
    // Composite-only (PRF-03): opacity + transform, CSS-transitioned — the
    // ANIMATED path. Never used when reducedMotion() is true (see render).
    burstEl.style.transition = 'opacity 250ms ease, transform 250ms ease';
    burstLabelEl = doc.createElement('span');
    burstLabelEl.dataset.role = 'milestone-celebration-animated-label';
    burstLabelEl.style.fontFamily = labelStyle.fontFamily;
    burstEl.appendChild(burstLabelEl);

    // THE STATIC ALTERNATIVE — a distinct badge element, not the animated
    // element replayed without a transition. Deliberately NO `transition`
    // is ever set on this element: its opacity flips from 0 to 1 (and
    // back) instantaneously, so what a reduced-motion viewer perceives is
    // the badge's own colour/border/text appearing as a discrete state
    // change — never motion, even brief motion.
    badgeEl = doc.createElement('div');
    badgeEl.dataset.role = 'milestone-celebration-badge';
    badgeEl.style.opacity = '0';
    badgeLabelEl = doc.createElement('span');
    badgeLabelEl.dataset.role = 'milestone-celebration-badge-label';
    badgeLabelEl.style.fontFamily = labelStyle.fontFamily;
    badgeEl.appendChild(badgeLabelEl);

    options.container.append(burstEl, badgeEl);
    ready = true;
  }

  function fire(label: string) {
    pendingLabel = label;
    visible = true;
    dirty = true;
    if (hideTimer !== undefined) clearTimeoutImpl(hideTimer);
    hideTimer = setTimeoutImpl(() => {
      hideTimer = undefined;
      visible = false;
      dirty = true;
    }, MILESTONE_CELEBRATION_VISIBLE_MS);
  }

  async function refetch() {
    const token = ++fetchToken;
    const [goalResult, voteResult] = await Promise.all([
      options.fetchGoalSnapshot().catch(() => null),
      options.fetchVoteSnapshot().catch(() => null),
    ]);
    if (token !== fetchToken) return; // superseded — discard, never act on a stale read

    if (goalResult && isOverlayGoal(goalResult)) {
      if (isRisingEdge(lastGoalReached, goalResult.reached)) fire(GOAL_REACHED_LABEL);
      lastGoalReached = goalResult.reached;
    }
    if (voteResult && isTugOfWarVoteTally(voteResult)) {
      if (isRisingEdge(lastVoteResolved, voteResult.resolved)) fire(VOTE_RESOLVED_LABEL);
      lastVoteResolved = voteResult.resolved;
    }
  }

  return {
    key: 'milestone_celebration',
    activate() {
      ensureElements();
      unsubscribeConnection = options.connection.subscribe(() => { void refetch(); });
    },
    deactivate() {
      unsubscribeConnection?.();
      unsubscribeConnection = undefined;
      fetchToken += 1; // any in-flight fetch response is now discarded on arrival
      if (hideTimer !== undefined) { clearTimeoutImpl(hideTimer); hideTimer = undefined; }
      visible = false;
      dirty = false;
      // Hide immediately on deactivation (e.g. OBS scene went hidden mid-
      // celebration) — never leave a stale burst/badge visible. Edge-
      // tracking state (lastGoalReached/lastVoteResolved) is intentionally
      // NOT reset here — see the field declarations above.
      if (ready) { burstEl.style.opacity = '0'; badgeEl.style.opacity = '0'; }
    },
    render() {
      if (!dirty) return;
      dirty = false;
      ensureElements();
      const reduced = options.reducedMotion();
      const showBurst = visible && !reduced;
      const showBadge = visible && reduced;

      if (showBurst) {
        if (burstLabelEl.textContent !== pendingLabel) burstLabelEl.textContent = pendingLabel;
        if (burstEl.style.opacity !== '1') { burstEl.style.opacity = '1'; burstEl.style.transform = 'scale(1)'; }
      } else if (burstEl.style.opacity !== '0') {
        burstEl.style.opacity = '0';
        burstEl.style.transform = 'scale(0.85)';
      }

      if (showBadge) {
        if (badgeLabelEl.textContent !== pendingLabel) badgeLabelEl.textContent = pendingLabel;
        if (badgeEl.style.opacity !== '1') badgeEl.style.opacity = '1';
      } else if (badgeEl.style.opacity !== '0') {
        badgeEl.style.opacity = '0';
      }
    },
  };
}
