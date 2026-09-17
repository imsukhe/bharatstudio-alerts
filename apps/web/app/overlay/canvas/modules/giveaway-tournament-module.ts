/*
 * Giveaway / Tournament Card module — §6 catalogue module #17, with the
 * minimum §17 schema behind it (migration 0142), built on top of module
 * #16's lobby (migration 0140) rather than beside it (§17.2).
 *
 * Reads the `/v1/overlay-widgets/:overlayId/giveaway-tournament` snapshot
 * (`app_private.list_overlay_giveaway_tournament`) through the host page's
 * injected `fetchSnapshot`, on the SAME shared `MasterCanvasConnection`
 * and the SAME shared rAF loop every other module uses. It opens no
 * connection, no session and no transport of its own, and it schedules no
 * timer and no frame of its own — the countdown ticks on the runtime's
 * existing per-frame `render(timestampMs)` call, which is precisely what
 * that one loop exists for. It is a plain `connection.subscribe()`
 * snapshot consumer, exactly like the lobby status card.
 *
 * NO THIRD-PARTY CODE, EVER (§9.1.1, PRF-13). Like every other module,
 * this one's options are plain values and function references. There is no
 * field here for a URL, an HTML string, a stylesheet or a script, so
 * nothing external can be smuggled onto the Canvas through it — the type
 * has no slot for one.
 *
 * AGGREGATE STATE ONLY, AND THIS FILE IS THE LAST LINE, NOT THE FIRST. The
 * read returns six aggregate columns; the API route narrows a second time
 * (`projectOverlayGiveawayTournament`); and `isGiveawayTournamentState`
 * here rejects any payload carrying a key it does not expect. Three
 * independent narrowings, so the guarantee does not rest on any one of
 * them holding.
 *
 * THERE IS NOTHING IN THIS FILE THAT COULD PAINT A WINNER, and that is the
 * correct outcome rather than an omission. §17.1 permits a winner
 * announcement only WITH CONSENT and no consent mechanism exists in this
 * schema; a winner is a participant identifier on an aggregate-only path;
 * and nothing could produce one, because the mechanic is not built (§17.1,
 * decided 2026-09-13; GIV-07 stays Blocked) and "the creator records who
 * won" is an invented surface the owner's 2026-09-16 decision names
 * outright. There is likewise no element, field or column here for a
 * prize, an escrow, a delivery state, an address or a claim link:
 * BharatStudio never holds, escrows, ships or guarantees a prize, and the
 * creator is the promoter.
 *
 * AND NO BRACKET TREE. A tree needs participant labels, which §16 already
 * ruled need an opt-in mechanism that does not exist. This module paints
 * bracket PROGRESS — round, total rounds, matches done, matches held —
 * which needs no label at all.
 *
 * WHEN THE CARD IS VISIBLE, DECIDED DELIBERATELY. It shows whenever either
 * half is live, INCLUDING a giveaway with zero entries: "a giveaway is
 * open and it closes in twelve minutes" is the invitation the card exists
 * to deliver. It renders nothing at all when the snapshot is null — an
 * unrecognised, expired, revoked or foreign token, a channel with nothing
 * running, a concluded tournament, and a channel without the §30.3
 * Creator+/Events Pack entitlement all look identical on screen, which is
 * correct: none of them has anything to tell a viewer.
 *
 * COMPOSITE-ONLY (PRF-03). `render()` writes only `opacity` and
 * `transform`, plus text content. The fill bar is a `scaleX` on an
 * absolutely positioned child — the same shape the goal ladder and the
 * lobby card use — never a width. Fixed padding, position, typography and
 * the track's height are declared once in `activate()`'s element setup,
 * which §19.5 explicitly distinguishes from animating them.
 *
 * BOUNDED DOM (§19.5). Six elements, created once, reused forever. Each
 * line is written by replacing one text node's contents, never by
 * appending a node per update — and there is no per-person element to
 * append in the first place, because there is no per-person data.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';
import {
  formatGiveawayLine,
  formatTournamentLine,
  hasSomethingToShow,
  isGiveawayTournamentState,
  tournamentFillRatio,
  type GiveawayTournamentState,
} from './giveaway-tournament-logic';

export interface GiveawayTournamentModuleOptions {
  container: HTMLElement;
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<GiveawayTournamentState | null>;
  reducedMotion: () => boolean;
  labelStyle?: CanvasTextStyle;
  /** Injected so the countdown is testable without faking a global clock.
   *  Defaults to the wall clock; see the logic file's header for the
   *  clock-skew cost this carries and why the alternative is worse. */
  now?: () => number;
}

export function createGiveawayTournamentModule(options: GiveawayTournamentModuleOptions): CanvasModuleDefinition {
  const labelStyle = options.labelStyle ?? defaultCanvasTextStyles().amount;
  const now = options.now ?? (() => Date.now());

  let ready = false;
  let cardEl: HTMLElement;
  let kickerEl: HTMLElement;
  let giveawayEl: HTMLElement;
  let tournamentEl: HTMLElement;
  let trackEl: HTMLElement;
  let fillEl: HTMLElement;
  let latestState: GiveawayTournamentState | null = null;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;

  function ensureElements() {
    if (ready) return;
    const doc = options.container.ownerDocument;
    options.container.textContent = '';
    // Nothing is shown until a real snapshot lands. An overlay that has
    // never connected, a channel with nothing running, and a channel
    // without the entitlement look identical on screen — which is correct:
    // none of them has anything to tell a viewer.
    options.container.style.opacity = '0';

    cardEl = doc.createElement('div');
    cardEl.dataset.role = 'giveaway-tournament-card';
    cardEl.style.display = 'flex';
    cardEl.style.flexDirection = 'column';
    cardEl.style.gap = '4px';

    // A fixed label, never a data-driven one. It names what the numbers
    // are without naming anyone taking part.
    kickerEl = doc.createElement('span');
    kickerEl.dataset.role = 'giveaway-tournament-kicker';
    kickerEl.textContent = 'Live now';

    giveawayEl = doc.createElement('span');
    giveawayEl.dataset.role = 'giveaway-line';
    giveawayEl.style.fontFamily = labelStyle.fontFamily;

    tournamentEl = doc.createElement('span');
    tournamentEl.dataset.role = 'tournament-line';
    tournamentEl.style.fontFamily = labelStyle.fontFamily;

    // A STATIC size set once at creation is not an animation — PRF-03
    // forbids animating a layout property, not declaring one. Nothing
    // below ever writes trackEl.style.width/height after this.
    trackEl = doc.createElement('div');
    trackEl.dataset.role = 'tournament-track';
    trackEl.style.position = 'relative';
    trackEl.style.overflow = 'hidden';
    trackEl.style.height = '6px';

    fillEl = doc.createElement('div');
    fillEl.dataset.role = 'tournament-fill';
    fillEl.style.position = 'absolute';
    fillEl.style.inset = '0';
    fillEl.style.transformOrigin = 'left center';
    fillEl.style.transform = 'scaleX(0)';
    fillEl.style.transition = options.reducedMotion() ? 'none' : 'transform 400ms ease';

    trackEl.appendChild(fillEl);
    cardEl.append(kickerEl, giveawayEl, tournamentEl, trackEl);
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
    latestState = result && isGiveawayTournamentState(result) ? result : null;
  }

  return {
    key: 'giveaway_tournament_card',
    activate() {
      ensureElements();
      unsubscribeConnection = options.connection.subscribe(() => { void refetch(); });
    },
    deactivate() {
      unsubscribeConnection?.();
      unsubscribeConnection = undefined;
      fetchToken += 1;
    },
    // Unlike the snapshot-only modules there is no `dirty` short-circuit
    // here, and that is deliberate: the entry window's countdown changes
    // every second with no new snapshot behind it. The per-frame work is
    // two string builds and a comparison, and nothing is WRITTEN unless
    // the rendered text or transform actually changed — so a card whose
    // second has not ticked over costs the same as an early return.
    render() {
      ensureElements();
      const state = latestState;

      if (!hasSomethingToShow(state)) {
        if (options.container.style.opacity !== '0') options.container.style.opacity = '0';
        if (cardEl.style.opacity !== '0') cardEl.style.opacity = '0';
        if (cardEl.style.transform !== 'translateY(-4px)') cardEl.style.transform = 'translateY(-4px)';
        if (fillEl.style.transform !== 'scaleX(0)') fillEl.style.transform = 'scaleX(0)';
        if (giveawayEl.textContent !== '') giveawayEl.textContent = '';
        if (tournamentEl.textContent !== '') tournamentEl.textContent = '';
        return;
      }

      const live = state as GiveawayTournamentState;
      // One text node per line, one string in each. The card does not gain
      // an element when entries arrive or a round advances — §19.5's
      // bounded DOM is six elements created once, whatever the state, and
      // there is no per-person element to add in any case.
      const giveawayLine = formatGiveawayLine(live, now());
      if (giveawayEl.textContent !== giveawayLine) giveawayEl.textContent = giveawayLine;
      const tournamentLine = formatTournamentLine(live);
      if (tournamentEl.textContent !== tournamentLine) tournamentEl.textContent = tournamentLine;

      const nextTransform = `scaleX(${String(tournamentFillRatio(live))})`;
      if (fillEl.style.transform !== nextTransform) fillEl.style.transform = nextTransform;
      // The track is hidden rather than removed when there is no bracket:
      // the element pool stays fixed at six, and opacity is a composite-
      // only write.
      const trackOpacity = tournamentLine === '' ? '0' : '1';
      if (trackEl.style.opacity !== trackOpacity) trackEl.style.opacity = trackOpacity;

      if (options.container.style.opacity !== '1') options.container.style.opacity = '1';
      if (cardEl.style.opacity !== '1') cardEl.style.opacity = '1';
      if (cardEl.style.transform !== 'translateY(0)') cardEl.style.transform = 'translateY(0)';
    },
  };
}
