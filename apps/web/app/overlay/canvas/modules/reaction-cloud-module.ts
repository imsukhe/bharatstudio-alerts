/*
 * Reaction Cloud module — §6 catalogue module #5 (PRF-02 slice 6 /
 * PRF-06).
 *
 * Reads the `/v1/overlay-widgets/:overlayId/reaction-cloud` snapshot
 * (migration 0139's `app_private.list_overlay_reaction_cloud`) through
 * the host page's injected `fetchSnapshot`, on the SAME shared
 * `MasterCanvasConnection` and the SAME shared rAF loop every other
 * module uses. It opens no connection, no session and no transport of
 * its own, and it schedules no timer or frame of its own — it is a plain
 * `connection.subscribe()` snapshot consumer, exactly like the goal
 * ladder and the moderator status card, and deliberately NOT a consumer
 * of Support Theater's event-payload/acknowledgement path.
 *
 * ===================================================================
 * THERE IS NO SAMPLING IN THIS FILE, AND THAT IS THE POINT.
 * ===================================================================
 * §19.5: reactions are "sampled and rate-limited server-side BEFORE they
 * reach the canvas", and the cloud shows "a representative sample, never
 * every event". By the time a snapshot reaches this module it is already
 * `count(*)` grouped by curated-catalogue entry, already capped by the
 * configured display ceiling, both inside the SQL function. So this file
 * contains no `.slice()`, no cap, no dropping and no thinning of any
 * kind — it paints exactly what it was given. If you are ever tempted to
 * add a cap here, the thing that actually needs changing is
 * `REACTION_CLOUD_SAMPLE_MAX`, which is the configured-but-unset ceiling
 * the owner decided on.
 *
 * NO THIRD-PARTY CODE, EVER (§9.1.1, PRF-13). Like every other module,
 * this one's options are plain values and function references. There is
 * no field here for a URL, an HTML string, a stylesheet or a script, so
 * nothing external can be smuggled onto the Canvas through it — the type
 * has no slot for one. A reaction is a catalogue entry ID and a number;
 * no asset, no bytes and no remote reference travel on this path at all.
 *
 * NON-IDENTIFYING (§6 #5), AND THIS FILE IS THE LAST LINE, NOT THE
 * FIRST. The read returns four columns; the API route narrows a second
 * time (`projectReactionCloud`); and `isReactionCloud` here rejects any
 * payload carrying a key it does not expect. Three independent
 * narrowings, so the guarantee does not rest on any one of them holding.
 *
 * BOUNDED DOM (§19.5), AND ITS HONEST LIMIT. Glyph elements are a
 * RECYCLED POOL: the pool grows to the largest snapshot this module has
 * been given and then never grows again, and every later snapshot only
 * WRITES into that same pool. It never appends per reaction — an
 * 8-hour stream ends with the same node count it reached in its first
 * busy minute. What bounds that count is the SERVER's sample size, which
 * is the configured display ceiling when one is set, and otherwise the
 * number of distinct catalogue entries the channel can reach. That is a
 * real bound, not an unbounded one — but it is the catalogue's size, not
 * a small number, and tightening it is exactly what the ceiling is for.
 * No pool size is invented here to paper over that.
 *
 * COMPOSITE-ONLY (PRF-03). `render()` writes only `opacity` and
 * `transform`. A glyph's BASE position is ordinary centred flex-wrap flow
 * declared once in the host page's CSS; the cloud shape is a per-glyph
 * `translate(x%, y%) scale(s)` on top of it — never `left`, `top`,
 * `width`, `height` or `font-size`. The percentages resolve against the
 * glyph's own box, which is what a CSS transform percentage means, so no
 * container measurement is needed and no layout is ever read.
 *
 * STALE-DATA SAFETY (PRF-02.12): `fetchToken` invalidates any in-flight
 * fetch superseded by a newer one, or by deactivation — a slow response
 * can never land after a faster one and repaint the screen with a stale
 * cloud.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';
import {
  hasReactions,
  isReactionCloud,
  layoutReactionCloud,
  type ReactionCloudEntry,
} from './reaction-cloud-logic';

export interface ReactionCloudModuleOptions {
  container: HTMLElement;
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<ReactionCloudEntry[] | null>;
  reducedMotion: () => boolean;
  glyphStyle?: CanvasTextStyle;
}

export function createReactionCloudModule(options: ReactionCloudModuleOptions): CanvasModuleDefinition {
  const glyphStyle = options.glyphStyle ?? defaultCanvasTextStyles().name;

  let ready = false;
  let glyphs: HTMLElement[] = [];
  let latestEntries: ReactionCloudEntry[] | null = null;
  let dirty = false;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;

  function ensureContainer() {
    if (ready) return;
    options.container.textContent = '';
    // Nothing is shown until a real snapshot lands AND that snapshot has
    // at least one reaction. An overlay that has never connected and a
    // channel nobody has reacted to look identical on screen, which is
    // correct: neither has anything to say.
    options.container.style.opacity = '0';
    ready = true;
  }

  /**
   * Grows the recycled pool to `needed` and never shrinks it. Growth
   * happens only when a snapshot is larger than any seen before, so the
   * node count settles at the server's own sample size and then stays
   * constant for the rest of the session.
   */
  function ensurePool(needed: number) {
    ensureContainer();
    if (glyphs.length >= needed) return;
    const doc = options.container.ownerDocument;
    for (let index = glyphs.length; index < needed; index += 1) {
      const glyph = doc.createElement('span');
      glyph.dataset.role = 'reaction-cloud-glyph';
      // Declared once, here — not written per frame. §19.5 permits
      // declaring a layout property; it forbids animating one. The base
      // position is ordinary centred flex-wrap flow from the host page's
      // CSS; `render()` only ever adds drift and scale through
      // `transform`, so no `left`/`top`/`width`/`height` is ever written
      // on the frame path.
      glyph.style.whiteSpace = 'nowrap';
      glyph.style.fontFamily = glyphStyle.fontFamily;
      glyph.style.transformOrigin = 'center center';
      glyph.style.transition = options.reducedMotion() ? 'none' : 'opacity 200ms ease, transform 200ms ease';
      glyph.style.opacity = '0';
      options.container.appendChild(glyph);
      glyphs.push(glyph);
    }
  }

  async function refetch() {
    const token = ++fetchToken;
    const result = await options.fetchSnapshot().catch(() => null);
    // Superseded by a later fetch (or by deactivate(), which also bumps
    // the token) — discard it rather than render a stale cloud as current.
    if (token !== fetchToken) return;
    latestEntries = result && isReactionCloud(result) ? result : null;
    dirty = true;
  }

  return {
    key: 'reaction_cloud',
    activate() {
      ensureContainer();
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
      ensureContainer();
      const entries = latestEntries;

      // An empty cloud and a snapshot that never arrived render the same
      // nothing, and deliberately so: neither has anything to tell a
      // viewer, and distinguishing them on a broadcast overlay would mean
      // inventing copy for a state not worth a pixel. It hides again the
      // moment the cloud empties — it does not latch on.
      if (!hasReactions(entries)) {
        if (options.container.style.opacity !== '0') options.container.style.opacity = '0';
        for (const glyph of glyphs) {
          if (glyph.style.opacity !== '0') glyph.style.opacity = '0';
        }
        return;
      }

      const placements = layoutReactionCloud(entries!);
      ensurePool(placements.length);

      // Batch: every placement is pure arithmetic computed above, then
      // written below. No layout is read anywhere in this pass — no
      // offsetHeight, no getBoundingClientRect.
      for (let index = 0; index < glyphs.length; index += 1) {
        const glyph = glyphs[index]!;
        const placement = placements[index];
        if (!placement) {
          if (glyph.style.opacity !== '0') glyph.style.opacity = '0';
          continue;
        }
        if (glyph.textContent !== placement.label) glyph.textContent = placement.label;
        const transform = `translate(${placement.offsetXPercent.toFixed(2)}%, ${placement.offsetYPercent.toFixed(2)}%) scale(${placement.scale.toFixed(3)})`;
        if (glyph.style.transform !== transform) glyph.style.transform = transform;
        if (glyph.style.opacity !== '1') glyph.style.opacity = '1';
      }
      if (options.container.style.opacity !== '1') options.container.style.opacity = '1';
    },
  };
}
