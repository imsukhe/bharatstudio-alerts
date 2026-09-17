/*
 * Lobby Status Card module — §6 catalogue module #16, with the minimum §16
 * Lobby schema behind it (migration 0140).
 *
 * Reads the `/v1/overlay-widgets/:overlayId/lobby-status` snapshot
 * (`app_private.list_overlay_lobby_status`) through the host page's
 * injected `fetchSnapshot`, on the SAME shared `MasterCanvasConnection`
 * and the SAME shared rAF loop every other module uses. It opens no
 * connection, no session and no transport of its own, and it schedules no
 * timer or frame of its own — it is a plain `connection.subscribe()`
 * snapshot consumer, exactly like the goal ladder and the moderator status
 * card, and deliberately NOT a consumer of Support Theater's
 * event-payload/acknowledgement path.
 *
 * NO THIRD-PARTY CODE, EVER (§9.1.1, PRF-13). Like every other module,
 * this one's options are plain values and function references. There is no
 * field here for a URL, an HTML string, a stylesheet or a script, so
 * nothing external can be smuggled onto the Canvas through it — the type
 * has no slot for one.
 *
 * AGGREGATE STATUS ONLY (§16), AND THIS FILE IS THE LAST LINE, NOT THE
 * FIRST. The read returns three integer columns; the API route narrows a
 * second time (`projectOverlayLobbyStatus`); and `isLobbyStatus` here
 * rejects any payload carrying a key it does not expect. Three independent
 * narrowings, so the guarantee does not rest on any one of them holding.
 *
 * There is nothing in this file that could paint a room code, a password,
 * a seat token, a player identifier, an in-game name, a Discord name, a
 * viewer id, opted-in initials or an avatar — no element for one, no field
 * for one, and no column behind one.
 *
 * WHEN THE CARD IS VISIBLE, DECIDED DELIBERATELY. It shows whenever a
 * lobby is open, INCLUDING at 0/16 with an empty queue. That is the
 * opposite of the Moderator Status Card's zero rule, and the reason is the
 * opposite too: there a zero carries no information, here "a lobby is open
 * and it has sixteen seats" is the invitation the card exists to deliver.
 * It renders nothing at all when the snapshot is null — an unrecognised,
 * expired, revoked or foreign token, a channel with no open lobby, and a
 * channel without the §30.3 Creator+/Events Pack entitlement all look
 * identical on screen, which is correct: none of them has anything to tell
 * a viewer.
 *
 * COMPOSITE-ONLY (PRF-03). `render()` writes only `opacity` and
 * `transform`. The fill bar is a `scaleX` on an absolutely positioned
 * child — the same shape the goal ladder uses — never a width. The card's
 * entrance is a small `translateY` plus a fade. Its fixed
 * padding/position/typography and the track's fixed height are declared
 * once in `activate()`'s element setup, which §19.5 explicitly
 * distinguishes from animating them.
 *
 * BOUNDED DOM (§19.5). Five elements, created once, reused forever. The
 * label is written by replacing one text node's contents, never by
 * appending a node per update — and there is no per-person element to
 * append in the first place, because there is no per-person data.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';
import {
  formatLobbyStatusLabel,
  hasSomethingToShow,
  isLobbyStatus,
  lobbyFillRatio,
  type LobbyStatus,
} from './lobby-status-logic';

export interface LobbyStatusModuleOptions {
  container: HTMLElement;
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<LobbyStatus | null>;
  reducedMotion: () => boolean;
  labelStyle?: CanvasTextStyle;
}

export function createLobbyStatusModule(options: LobbyStatusModuleOptions): CanvasModuleDefinition {
  const labelStyle = options.labelStyle ?? defaultCanvasTextStyles().amount;

  let ready = false;
  let cardEl: HTMLElement;
  let kickerEl: HTMLElement;
  let trackEl: HTMLElement;
  let fillEl: HTMLElement;
  let labelEl: HTMLElement;
  let latestStatus: LobbyStatus | null = null;
  let dirty = false;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;

  function ensureElements() {
    if (ready) return;
    const doc = options.container.ownerDocument;
    options.container.textContent = '';
    // Nothing is shown until a real snapshot lands. An overlay that has
    // never connected, a channel with no lobby open, and a channel without
    // the entitlement look identical on screen — which is correct: none of
    // them has anything to tell a viewer.
    options.container.style.opacity = '0';

    cardEl = doc.createElement('div');
    cardEl.dataset.role = 'lobby-status-card';
    cardEl.style.display = 'flex';
    cardEl.style.flexDirection = 'column';
    cardEl.style.gap = '4px';

    // A fixed label, never a data-driven one. It names what the numbers
    // are without naming who is in the lobby.
    kickerEl = doc.createElement('span');
    kickerEl.dataset.role = 'lobby-status-kicker';
    kickerEl.textContent = 'Lobby';

    // A STATIC size set once at creation is not an animation — PRF-03
    // forbids animating a layout property, not declaring one. Nothing
    // below ever writes trackEl.style.width/height after this.
    trackEl = doc.createElement('div');
    trackEl.dataset.role = 'lobby-status-track';
    trackEl.style.position = 'relative';
    trackEl.style.overflow = 'hidden';
    trackEl.style.height = '8px';

    fillEl = doc.createElement('div');
    fillEl.dataset.role = 'lobby-status-fill';
    fillEl.style.position = 'absolute';
    fillEl.style.inset = '0';
    fillEl.style.transformOrigin = 'left center';
    fillEl.style.transform = 'scaleX(0)';
    fillEl.style.transition = options.reducedMotion() ? 'none' : 'transform 400ms ease';

    labelEl = doc.createElement('span');
    labelEl.dataset.role = 'lobby-status-label';
    labelEl.style.fontFamily = labelStyle.fontFamily;

    trackEl.appendChild(fillEl);
    cardEl.append(kickerEl, trackEl, labelEl);
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
    latestStatus = result && isLobbyStatus(result) ? result : null;
    dirty = true;
  }

  return {
    key: 'lobby_status',
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

      if (!hasSomethingToShow(status)) {
        if (options.container.style.opacity !== '0') options.container.style.opacity = '0';
        if (cardEl.style.opacity !== '0') cardEl.style.opacity = '0';
        if (cardEl.style.transform !== 'translateY(-4px)') cardEl.style.transform = 'translateY(-4px)';
        if (fillEl.style.transform !== 'scaleX(0)') fillEl.style.transform = 'scaleX(0)';
        if (labelEl.textContent !== '') labelEl.textContent = '';
        return;
      }

      const lobby = status as LobbyStatus;
      // One text node, one string, both halves of the status in it. The
      // card does not gain an element when the queue fills — §19.5's
      // bounded DOM is five elements created once, whatever the state, and
      // there is no per-person element to add in any case.
      const label = formatLobbyStatusLabel(lobby);
      if (labelEl.textContent !== label) labelEl.textContent = label;
      const nextTransform = `scaleX(${String(lobbyFillRatio(lobby))})`;
      if (fillEl.style.transform !== nextTransform) fillEl.style.transform = nextTransform;
      if (options.container.style.opacity !== '1') options.container.style.opacity = '1';
      if (cardEl.style.opacity !== '1') cardEl.style.opacity = '1';
      if (cardEl.style.transform !== 'translateY(0)') cardEl.style.transform = 'translateY(0)';
    },
  };
}
