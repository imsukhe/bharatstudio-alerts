/*
 * Sponsor Card module -- §6 catalogue module #11, with the minimum §11
 * schema behind it (migration 0145).
 *
 * Reads the `/v1/overlay-widgets/:overlayId/sponsor-card` snapshot
 * (`app_private.list_overlay_sponsor_card`) through the host page's
 * injected `fetchSnapshot`, on the SAME shared `MasterCanvasConnection`
 * and the SAME shared rAF loop every other module uses. It opens no
 * connection, no session and no transport of its own. It is a plain
 * `connection.subscribe()` snapshot consumer, exactly like the Stream
 * Mission and Giveaway/Tournament cards.
 *
 * NO THIRD-PARTY CODE, EVER (§9.1.1, PRF-13). Every import below is
 * first-party. There is no field on this module's options for a URL, an
 * HTML string, a stylesheet or a script, so nothing external can be
 * smuggled onto the Canvas through it -- the type has no slot for one.
 *
 * THE CARD RENDERS THE SPONSOR AND COUNTS NOTHING (owner decision,
 * 2026-09-17). This module never times how long it has been visible,
 * never counts how many times it has rendered, and never records a "shown
 * at" -- there is no local state here for any of the three, on top of the
 * snapshot type itself having no field for one (see
 * sponsor-card-logic.ts's header).
 *
 * THE LOGO IMAGE IS NOT YET WIRED TO REAL BYTES, AND THIS IS STATED
 * RATHER THAN FAKED. `logoStorageKey` is a tenant-scoped content-addressed
 * asset REFERENCE (migration 0145) -- no GCS/CDN client or byte-serving
 * endpoint exists anywhere in this repository yet (see the decision
 * record), so this module records the reference on the element as a data
 * attribute rather than inventing a fetch URL that would 404 in
 * production. When a byte-serving endpoint exists, wiring it is a
 * one-line change here (`imgEl.src = ...`); nothing about this module's
 * shape needs to change first. The sponsor NAME renders fully today,
 * independent of whether a logo is present.
 *
 * WHEN THE CARD IS VISIBLE, DECIDED DELIBERATELY. It shows only when the
 * snapshot is a real, non-null, structurally valid sponsor card --
 * disabled, outside its schedule, an unrecognised/expired/revoked/foreign
 * token, and a channel with no sponsor card at all all look identical on
 * screen (nothing), which is correct: none of them has anything to tell a
 * viewer, and this module has no way to tell them apart even if it wanted
 * to (the read collapses all four to the same answer).
 *
 * COMPOSITE-ONLY (PRF-03). `render()` writes only `opacity` and
 * `transform`, plus text content and one data attribute.
 *
 * BOUNDED DOM (§19.5). Three elements, created once, reused forever.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';
import { hasLogo, isSponsorCardSnapshot, type SponsorCardSnapshot } from './sponsor-card-logic';

export interface SponsorCardModuleOptions {
  container: HTMLElement;
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<SponsorCardSnapshot | null>;
  reducedMotion: () => boolean;
  kickerStyle?: CanvasTextStyle;
  nameStyle?: CanvasTextStyle;
}

export function createSponsorCardModule(options: SponsorCardModuleOptions): CanvasModuleDefinition {
  const kickerStyle = options.kickerStyle ?? defaultCanvasTextStyles().label;
  const nameStyle = options.nameStyle ?? defaultCanvasTextStyles().title;

  let ready = false;
  let cardEl: HTMLElement;
  let kickerEl: HTMLElement;
  let nameEl: HTMLElement;
  let latestSnapshot: SponsorCardSnapshot | null = null;
  let dirty = false;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;

  function ensureElements() {
    if (ready) return;
    const doc = options.container.ownerDocument;
    options.container.textContent = '';
    // Nothing is shown until the first real, valid snapshot lands.
    options.container.style.opacity = '0';

    cardEl = doc.createElement('div');
    cardEl.dataset.role = 'sponsor-card';
    cardEl.style.transformOrigin = 'left center';
    cardEl.style.transform = 'translateY(8px)';
    cardEl.style.transition = options.reducedMotion() ? 'none' : 'transform 260ms ease, opacity 260ms ease';

    kickerEl = doc.createElement('div');
    kickerEl.dataset.role = 'sponsor-card-kicker';
    kickerEl.style.fontFamily = kickerStyle.fontFamily;
    kickerEl.textContent = 'Sponsored by';

    nameEl = doc.createElement('div');
    nameEl.dataset.role = 'sponsor-card-name';
    nameEl.style.fontFamily = nameStyle.fontFamily;

    cardEl.append(kickerEl, nameEl);
    options.container.appendChild(cardEl);
    ready = true;
  }

  async function refetch() {
    const token = ++fetchToken;
    const result = await options.fetchSnapshot().catch(() => null);
    if (token !== fetchToken) return; // superseded — discard, never render as current
    latestSnapshot = result && isSponsorCardSnapshot(result) ? result : null;
    dirty = true;
  }

  return {
    key: 'sponsor_card',
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
      ensureElements();
      if (!dirty) return;
      dirty = false;

      const snapshot = latestSnapshot;
      if (!snapshot) {
        if (options.container.style.opacity !== '0') options.container.style.opacity = '0';
        if (cardEl.style.transform !== 'translateY(8px)') cardEl.style.transform = 'translateY(8px)';
        if (nameEl.textContent !== '') nameEl.textContent = '';
        delete cardEl.dataset.logoStorageKey;
        return;
      }

      if (options.container.style.opacity !== '1') options.container.style.opacity = '1';
      if (cardEl.style.transform !== 'translateY(0px)') cardEl.style.transform = 'translateY(0px)';
      if (nameEl.textContent !== snapshot.sponsorName) nameEl.textContent = snapshot.sponsorName;

      // The logo reference is recorded, not fetched -- see this file's
      // header on why no <img src> is set yet.
      if (hasLogo(snapshot)) {
        if (cardEl.dataset.logoStorageKey !== snapshot.logoStorageKey!) {
          cardEl.dataset.logoStorageKey = snapshot.logoStorageKey!;
        }
      } else {
        delete cardEl.dataset.logoStorageKey;
      }
    },
  };
}
