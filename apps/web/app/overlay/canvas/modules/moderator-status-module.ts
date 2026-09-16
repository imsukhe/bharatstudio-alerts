/*
 * Moderator Status Card module — §6 catalogue module #12. Slice 5 built
 * the held half; safe mode (migration 0138) completes it.
 *
 * Reads the `/v1/overlay-widgets/:overlayId/moderator-status` snapshot
 * (migration 0138's `app_private.list_overlay_moderator_status`) through
 * the host page's injected `fetchSnapshot`, on the SAME shared
 * `MasterCanvasConnection` and the SAME shared rAF loop every other
 * module uses. It opens no connection, no session and no transport of
 * its own, and it schedules no timer or frame of its own — it is a plain
 * `connection.subscribe()` snapshot consumer, exactly like the goal
 * ladder and the challenge board, and deliberately NOT a consumer of
 * Support Theater's event-payload/acknowledgement path.
 *
 * NO THIRD-PARTY CODE, EVER (§9.1.1, PRF-13). Like every other module,
 * this one's options are plain values and function references. There is
 * no field here for a URL, an HTML string, a stylesheet or a script, so
 * nothing external can be smuggled onto the Canvas through it — the type
 * has no slot for one.
 *
 * NEVER PRIVATE CONTENT (§6), AND THIS FILE IS THE LAST LINE, NOT THE
 * FIRST. The read returns two columns (`held_count`, `safe_mode`); the
 * API route narrows a second time (`projectModeratorStatus`); and
 * `isModeratorStatus` here rejects any payload carrying a key it does
 * not expect. Three independent narrowings, so the guarantee does not
 * rest on any one of them holding.
 *
 * WHEN THE CARD IS VISIBLE, DECIDED DELIBERATELY. It shows when
 * something is held OR when safe mode is on — safe mode alone is enough,
 * because it is the REASON nothing is reaching the overlay and a creator
 * staring at a silent canvas needs to know that. Quiet and off, it
 * renders NOTHING: the container stays at `opacity: 0` with empty text.
 * No "All clear", no "Nothing held", no tick. That half is slice 5's
 * decision, preserved: a permanent zero badge is chrome a viewer stares
 * at for an entire broadcast while carrying no information (§19.5's
 * "idle modules cost nothing" posture), and a reassuring string would be
 * a claim about moderation state this module has no authority to make.
 * It hides again the moment both go quiet — it does not latch on.
 *
 * NOT CHAT, AND NOT THE QUEUE-PAUSED FLAG. The label reads "safe mode
 * on" and "N held for review" — held alert deliveries awaiting a
 * moderator, not chat messages (§6's "messages held" wording predates
 * the schema and was corrected in §6 itself). `safeMode` is the
 * creator's own per-channel switch (owner decision, 2026-09-16), never
 * automatic and never `alert_queues.is_paused`, which migration 0138
 * still does not read.
 *
 * COMPOSITE-ONLY (PRF-03). `render()` writes only `opacity` and
 * `transform`. The card's entrance is a small `translateY` plus a fade;
 * its fixed padding/position/typography are declared once in
 * `activate()`'s element setup, which §19.5 explicitly distinguishes
 * from animating them.
 *
 * BOUNDED DOM (§19.5). Three elements, created once, reused forever. The
 * count is written by replacing one text node's contents, never by
 * appending a node per update.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';
import { formatModeratorStatusLabel, hasSomethingToShow, isModeratorStatus, type ModeratorStatus } from './moderator-status-logic';

export interface ModeratorStatusModuleOptions {
  container: HTMLElement;
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<ModeratorStatus | null>;
  reducedMotion: () => boolean;
  countStyle?: CanvasTextStyle;
}

export function createModeratorStatusModule(options: ModeratorStatusModuleOptions): CanvasModuleDefinition {
  const countStyle = options.countStyle ?? defaultCanvasTextStyles().amount;

  let ready = false;
  let cardEl: HTMLElement;
  let dotEl: HTMLElement;
  let labelEl: HTMLElement;
  let latestStatus: ModeratorStatus | null = null;
  let dirty = false;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;

  function ensureElements() {
    if (ready) return;
    const doc = options.container.ownerDocument;
    options.container.textContent = '';
    // Nothing is shown until a real snapshot lands AND that snapshot has
    // something held. An overlay that has never connected, and an overlay
    // on a channel with a quiet queue, look identical on screen — which
    // is correct: neither has anything to tell the creator.
    options.container.style.opacity = '0';

    cardEl = doc.createElement('div');
    cardEl.dataset.role = 'moderator-status-card';
    cardEl.style.display = 'flex';
    cardEl.style.alignItems = 'center';
    cardEl.style.gap = '8px';

    // A purely decorative marker. It carries no state of its own and is
    // never coloured or toggled by moderation status — the card's own
    // visibility is the entire signal.
    dotEl = doc.createElement('span');
    dotEl.dataset.role = 'moderator-status-dot';
    dotEl.setAttribute('aria-hidden', 'true');

    labelEl = doc.createElement('span');
    labelEl.dataset.role = 'moderator-status-label';
    labelEl.style.fontFamily = countStyle.fontFamily;

    cardEl.append(dotEl, labelEl);
    options.container.appendChild(cardEl);

    // Declared once, here, not written per frame — §19.5 permits
    // declaring a transition, not animating a layout property.
    cardEl.style.transition = options.reducedMotion() ? 'none' : 'opacity 240ms ease, transform 240ms ease';
    cardEl.style.transform = 'translateY(-4px)';

    ready = true;
  }

  async function refetch() {
    const token = ++fetchToken;
    const result = await options.fetchSnapshot().catch(() => null);
    // Superseded by a later fetch (or by deactivate(), which also bumps
    // the token) — discard it rather than render a stale answer as
    // current.
    if (token !== fetchToken) return;
    latestStatus = result && isModeratorStatus(result) ? result : null;
    dirty = true;
  }

  return {
    key: 'moderator_status_card',
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
      const status = latestStatus;

      // Quiet-and-off, and the no-answer case, both render nothing, and
      // deliberately render the SAME nothing: neither one has anything
      // to tell a creator, and distinguishing them on a broadcast
      // overlay would mean inventing copy for a state that is not worth
      // a pixel.
      if (!hasSomethingToShow(status)) {
        if (options.container.style.opacity !== '0') options.container.style.opacity = '0';
        if (cardEl.style.opacity !== '0') cardEl.style.opacity = '0';
        if (cardEl.style.transform !== 'translateY(-4px)') cardEl.style.transform = 'translateY(-4px)';
        if (labelEl.textContent !== '') labelEl.textContent = '';
        return;
      }

      // One text node, one string, both halves of the status in it. The
      // card does not gain an element when safe mode turns on — §19.5's
      // bounded DOM is three elements created once, whatever the state.
      const label = formatModeratorStatusLabel(status as ModeratorStatus);
      if (labelEl.textContent !== label) labelEl.textContent = label;
      if (options.container.style.opacity !== '1') options.container.style.opacity = '1';
      if (cardEl.style.opacity !== '1') cardEl.style.opacity = '1';
      if (cardEl.style.transform !== 'translateY(0)') cardEl.style.transform = 'translateY(0)';
    },
  };
}
