/*
 * Challenge Board module (§6 #8), NARROWED TO CURRENT-ONLY THIS SLICE —
 * PRF-02 slice 4's own §1(b) and `active/tasks/PRF-02.md`'s Slice 4
 * section carry the full reasoning; this header only summarises. §6 says
 * "Current / next / completed", but
 * `app_private.list_overlay_challenge` (migration 0109, ~lines 344–368)
 * returns exactly the single most-recently-updated public challenge for
 * the channel, `limit 1` — there is no "next" (no priority/queue column
 * exists, only `created_at`/`updated_at`) and no "completed" list to
 * read. Opus's decision: ship current-only, matching the existing
 * contract exactly — this module reads the SAME
 * `/v1/overlay-challenges/:overlayId` endpoint and the SAME
 * `OverlayChallenge` shape the standalone challenge widget
 * (`../../widgets/challenge/[overlayId]/page.tsx`) already reads. NO new
 * endpoint, NO new query. "Next"/"completed" are deferred to a follow-up
 * slice pending a product decision on what ordering even means.
 *
 * THE PROTECTED STRING (§15.4.2, this task's own §1(c)):
 * `CHALLENGE_FAILURE_COPY` is IMPORTED, never re-declared, from
 * `../../widgets/challenge/challenge-widget-logic.ts` — the same import
 * the standalone widget page itself uses, and the same pattern
 * goal-ladder-module.ts already set (importing `goal-widget-logic.ts`
 * rather than forking it). That web-side copy is kept byte-identical to
 * `apps/api/src/domain/challenge-store.ts`'s own copy — see
 * `challenge-failure-copy-parity.test.ts`, which reads the API file's
 * source text directly (the two packages have no shared import boundary)
 * and asserts the two strings match verbatim, so a future edit to one
 * cannot silently diverge from the other.
 *
 * NO OVERRIDE SLOT EXISTS FOR IT: `ChallengeBoardModuleOptions` has no
 * field of any kind for supplying alternate failure/refund copy, and
 * nothing in this file reads one. There is nothing here for a future
 * customisation surface (§15.4.3) to accidentally wire an override
 * through — the string can only ever be the one this module imports.
 * `challenge-board-module.test.ts`'s "an unrelated/extra option can never
 * substitute for the protected copy" case proves this at the call site,
 * not only by the type signature.
 *
 * THE HONEST REGISTER — never refund/reversal/escrow/funds-held language
 * OTHER than the one sanctioned, honest sentence: a succeeded challenge
 * renders only a plain "Succeeded!" state label, exactly like the
 * standalone widget — nothing about money changes hands differently.
 * `CHALLENGE_FAILURE_COPY` itself is shown ONLY on a resolved
 * (failed/cancelled) challenge, exactly where the standalone widget shows
 * it, and it is the only place in this module's rendered output where
 * refund-adjacent words ever appear — because it is the one place this
 * product needs to say, honestly, that no refund is coming from us. The
 * nearest primary-source analogue (YouTube Super Chat Goals: on failure,
 * the revenue is the creator's, start a new goal — no refund, no punitive
 * framing) is the register this copy already matches.
 *
 * COMPOSITE-ONLY (PRF-03): corrects the standalone widget's own
 * `.challenge-widget-fill { transition: width 400ms ease }` — progress is
 * expressed as `transform: scaleX()` on a fixed-size track, exactly like
 * goal-ladder-module.ts and boss-fight-module.ts.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';
import {
  CHALLENGE_FAILURE_COPY,
  formatRupees,
  isOverlayChallenge,
  isWidgetVisible,
  progressPercent,
  type OverlayChallenge,
} from '../../widgets/challenge/challenge-widget-logic';

const STATE_LABELS: Record<OverlayChallenge['state'], string> = {
  draft: '',
  active: 'In progress',
  succeeded: 'Succeeded!',
  failed: 'Did not happen',
  cancelled: 'Cancelled',
};

export interface ChallengeBoardModuleOptions {
  container: HTMLElement;
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<OverlayChallenge | null>;
  reducedMotion: () => boolean;
  titleStyle?: CanvasTextStyle;
  amountStyle?: CanvasTextStyle;
  labelStyle?: CanvasTextStyle;
  messageStyle?: CanvasTextStyle;
}

export function createChallengeBoardModule(options: ChallengeBoardModuleOptions): CanvasModuleDefinition {
  const titleStyle = options.titleStyle ?? defaultCanvasTextStyles().title;
  const amountStyle = options.amountStyle ?? defaultCanvasTextStyles().amount;
  const labelStyle = options.labelStyle ?? defaultCanvasTextStyles().label;
  const messageStyle = options.messageStyle ?? defaultCanvasTextStyles().message;

  let ready = false;
  let titleEl: HTMLElement;
  let stateEl: HTMLElement;
  let trackEl: HTMLElement;
  let fillEl: HTMLElement;
  let amountsEl: HTMLElement;
  let copyEl: HTMLElement;
  let latestChallenge: OverlayChallenge | null = null;
  let dirty = false;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;

  function ensureElements() {
    if (ready) return;
    const doc = options.container.ownerDocument;
    options.container.textContent = '';
    options.container.style.opacity = '0'; // nothing to show until the first real snapshot lands

    titleEl = doc.createElement('div');
    titleEl.dataset.role = 'challenge-board-title';
    titleEl.style.fontFamily = titleStyle.fontFamily;

    stateEl = doc.createElement('div');
    stateEl.dataset.role = 'challenge-board-state';
    stateEl.style.fontFamily = labelStyle.fontFamily;

    trackEl = doc.createElement('div');
    trackEl.dataset.role = 'challenge-board-track';
    // Static size set once at creation — never written to again (PRF-03
    // forbids ANIMATING a layout property, not declaring a fixed one).
    trackEl.style.position = 'relative';
    trackEl.style.overflow = 'hidden';
    trackEl.style.height = '14px';

    fillEl = doc.createElement('div');
    fillEl.dataset.role = 'challenge-board-fill';
    fillEl.style.position = 'absolute';
    fillEl.style.inset = '0';
    fillEl.style.transformOrigin = 'left center';
    fillEl.style.transform = 'scaleX(0)';
    fillEl.style.transition = options.reducedMotion() ? 'none' : 'transform 400ms ease';

    amountsEl = doc.createElement('div');
    amountsEl.dataset.role = 'challenge-board-amounts';
    amountsEl.style.fontFamily = amountStyle.fontFamily;

    // The protected copy's own element — see file header. No option of
    // any kind feeds this element's text; it is set exactly once below,
    // always from the imported CHALLENGE_FAILURE_COPY constant.
    copyEl = doc.createElement('p');
    copyEl.dataset.role = 'challenge-board-failure-copy';
    copyEl.style.fontFamily = messageStyle.fontFamily;
    copyEl.style.opacity = '0';

    trackEl.appendChild(fillEl);
    options.container.append(titleEl, stateEl, trackEl, amountsEl, copyEl);
    ready = true;
  }

  async function refetch() {
    const token = ++fetchToken;
    const result = await options.fetchSnapshot().catch(() => null);
    if (token !== fetchToken) return; // superseded — discard, never render as current
    latestChallenge = result && isOverlayChallenge(result) ? result : null;
    dirty = true;
  }

  return {
    key: 'challenge_board',
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
      const challenge = latestChallenge;
      // A draft challenge is never shown on stream (matches the
      // standalone widget's own isWidgetVisible rule) — same treatment as
      // "no challenge configured".
      if (!challenge || !isWidgetVisible(challenge)) {
        if (options.container.style.opacity !== '0') options.container.style.opacity = '0';
        return;
      }
      if (options.container.style.opacity !== '1') options.container.style.opacity = '1';

      if (titleEl.textContent !== challenge.title) titleEl.textContent = challenge.title;
      const stateText = STATE_LABELS[challenge.state];
      if (stateEl.textContent !== stateText) stateEl.textContent = stateText;

      const scale = String(progressPercent(challenge) / 100);
      const nextTransform = `scaleX(${scale})`;
      if (fillEl.style.transform !== nextTransform) fillEl.style.transform = nextTransform;

      const amountsText = `${formatRupees(challenge.progressPaise)} / ${formatRupees(challenge.targetAmountPaise)}`;
      if (amountsEl.textContent !== amountsText) amountsEl.textContent = amountsText;

      // Exactly the standalone widget's own rule: the protected copy shows
      // ONLY on a resolved (failed/cancelled) challenge, and ONLY the
      // imported, unmodifiable constant — never anything else.
      const resolved = challenge.state === 'failed' || challenge.state === 'cancelled';
      if (resolved) {
        if (copyEl.textContent !== CHALLENGE_FAILURE_COPY) copyEl.textContent = CHALLENGE_FAILURE_COPY;
        if (copyEl.style.opacity !== '1') copyEl.style.opacity = '1';
      } else if (copyEl.style.opacity !== '0') {
        copyEl.style.opacity = '0';
        copyEl.textContent = '';
      }
    },
  };
}
