/*
 * Media / Meme Queue module — §6 catalogue module #20, with the minimum
 * schema behind it (migration 0146, URL-hardened by migration 0148 — see
 * that migration's header for the finding this file's `playbackUrl`
 * posture fixes).
 *
 * Reads the `/v1/overlay-widgets/:overlayId/media-queue` snapshot
 * (`app_private.list_overlay_media_queue`) through the host page's
 * injected `fetchSnapshot`, on the SAME shared `MasterCanvasConnection`
 * and the SAME shared rAF loop every other module uses. It opens no
 * connection, no session and no transport of its own — a plain
 * `connection.subscribe()` snapshot consumer, exactly like the lobby
 * status and giveaway/tournament cards.
 *
 * CREATOR-ONLY. VIEWERS CANNOT SUBMIT (owner decision, 2026-09-17;
 * register row MED-20). This file has no field, no element and no code
 * path capable of writing anything back — it is a pure, one-directional
 * reader of a server-computed snapshot, exactly like every other Canvas
 * module. There is no submission endpoint, no approval queue and no
 * viewer-facing write surface anywhere near this file.
 *
 * NO THIRD-PARTY CODE, EVER, AND NO ARBITRARY THIRD-PARTY ORIGIN EITHER
 * (§9.1.1, §19.1, PRF-13). Before migration 0148, this module rendered a
 * creator-supplied URL to ANY host on the internet — an <img>/<video> src
 * is decode-only (no script execution, no DOM access), so that was never
 * an XSS hole, but it let the canvas contact an origin BharatStudio never
 * chose, degrading OBS reliability/performance, leaking the creator's IP
 * to that host on every poll, and letting served bytes change after the
 * creator queued them. `playbackUrl` / `thumbnailPlaybackUrl` are now
 * resolved SERVER-SIDE ONLY (apps/api/src/db/media-queue-overlay-
 * store.ts) from a content-key fragment against the API's own configured
 * CDN base (`config.mediaCdnBaseUrl`) — never a caller- or
 * database-supplied host. That base is CONFIGURED BUT UNSET in every
 * environment today, so `playbackUrl` is null for every item until it is
 * provisioned, and `hasSomethingToShow` (./media-queue-logic.ts) treats a
 * null playbackUrl exactly like "nothing live": THIS MODULE RENDERS
 * NOTHING until a real CDN base exists, the same honest posture the
 * Sponsor Card and Soundboard modules already have — it does not
 * degrade gracefully into rendering a broken image; it paints nothing at
 * all, which is the true state of an asset with no resolvable location.
 *
 * `playbackUrl` / `thumbnailPlaybackUrl` are handed ONLY to an `<img>` or
 * `<video>` element's `src` attribute below — never to a script, an
 * iframe or a stylesheet, and there is no code path in this file capable
 * of doing so. `isMediaQueueState` (./media-queue-logic.ts) additionally
 * rejects any mime type outside the closed image/video allow-list, and
 * any non-https/non-null playbackUrl, before this file ever sees one, so
 * nothing here can even be asked to render something else.
 *
 * "CURRENT AND NEXT" AS A PRELOAD MECHANISM, NOT A DISPLAY ONE. The
 * snapshot carries at most one 'next' entry alongside 'current' — this
 * module NEVER renders 'next' visibly. It is used purely to warm the
 * browser's cache for the asset that follows, via a fixed pool of two
 * hidden, permanently-`opacity: 0` preload elements, so that when the
 * creator advances the queue the following asset is already decoded
 * rather than causing a visible stall on a live broadcast.
 *
 * AGGREGATE-FREE AND ID-FREE, AND THIS FILE IS THE LAST LINE, NOT THE
 * FIRST. The read returns at most two entries with seven declared
 * fields; the API route narrows a second time
 * (`projectOverlayMediaQueue`); and `isMediaQueueState` here rejects any
 * payload carrying a key, a slot count or an array length it does not
 * expect. Three independent narrowings, so the guarantee does not rest
 * on any one of them holding.
 *
 * COMPOSITE-ONLY (PRF-03). `render()` writes only `opacity`,
 * `transform`, element `src`/`poster` attributes (a resource reference,
 * not a style) and text content. There is no layout property animated
 * per frame. Fixed sizing and positioning are declared once in
 * `activate()`'s element setup.
 *
 * BOUNDED DOM (§19.5). Six elements total — a wrapper, a visible `<img>`,
 * a visible `<video>`, and a hidden preload pair (`<img>`, `<video>`) —
 * created once in `activate()` and reused forever. There is no per-item
 * element to append: the SAME two visible elements are reused for every
 * media item that ever plays, toggled by `mediaKind` rather than
 * multiplied by it.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import {
  currentEntry,
  hasSomethingToShow,
  isMediaQueueState,
  nextEntry,
  type MediaQueueEntry,
  type MediaQueueState,
} from './media-queue-logic';

export interface MediaQueueModuleOptions {
  container: HTMLElement;
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<MediaQueueState | null>;
  reducedMotion: () => boolean;
}

export function createMediaQueueModule(options: MediaQueueModuleOptions): CanvasModuleDefinition {
  let ready = false;
  let wrapperEl: HTMLElement;
  let currentImgEl: HTMLImageElement;
  let currentVideoEl: HTMLVideoElement;
  let preloadImgEl: HTMLImageElement;
  let preloadVideoEl: HTMLVideoElement;

  let latestState: MediaQueueState = [];
  let lastRenderedCurrentUrl: string | null = null;
  let lastRenderedNextUrl: string | null = null;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;

  function ensureElements() {
    if (ready) return;
    const doc = options.container.ownerDocument;
    options.container.textContent = '';
    // Nothing is shown until a real snapshot lands. An overlay that has
    // never connected and a channel with nothing live in rotation look
    // identical on screen — correct, since neither has anything to show.
    options.container.style.opacity = '0';

    wrapperEl = doc.createElement('div');
    wrapperEl.dataset.role = 'media-queue-card';
    wrapperEl.style.position = 'relative';
    wrapperEl.style.overflow = 'hidden';

    currentImgEl = doc.createElement('img');
    currentImgEl.dataset.role = 'media-queue-current-image';
    currentImgEl.style.display = 'block';
    currentImgEl.style.maxWidth = '100%';
    currentImgEl.style.opacity = '0';

    currentVideoEl = doc.createElement('video');
    currentVideoEl.dataset.role = 'media-queue-current-video';
    currentVideoEl.style.display = 'block';
    currentVideoEl.style.maxWidth = '100%';
    currentVideoEl.style.opacity = '0';
    currentVideoEl.muted = true;
    currentVideoEl.playsInline = true;
    currentVideoEl.loop = true;

    // Preload pair. PERMANENTLY invisible and never appended where a
    // viewer could see them — their only job is to make the browser
    // fetch and decode the 'next' asset ahead of time. Not part of the
    // visible wrapper.
    preloadImgEl = doc.createElement('img');
    preloadImgEl.dataset.role = 'media-queue-preload-image';
    preloadImgEl.style.display = 'none';
    preloadVideoEl = doc.createElement('video');
    preloadVideoEl.dataset.role = 'media-queue-preload-video';
    preloadVideoEl.style.display = 'none';
    preloadVideoEl.muted = true;
    preloadVideoEl.preload = 'auto';

    wrapperEl.append(currentImgEl, currentVideoEl);
    options.container.append(wrapperEl, preloadImgEl, preloadVideoEl);

    wrapperEl.style.transition = options.reducedMotion() ? 'none' : 'opacity 240ms ease, transform 240ms ease';
    wrapperEl.style.transform = 'translateY(-4px)';

    ready = true;
  }

  async function refetch() {
    const token = ++fetchToken;
    const result = await options.fetchSnapshot().catch(() => null);
    if (token !== fetchToken) return;
    latestState = result && isMediaQueueState(result) ? result : [];
  }

  function applyPreload(entry: MediaQueueEntry | null) {
    // No playbackUrl (migration 0148: mediaCdnBaseUrl unset) means
    // nothing to preload -- same honest "cannot display" posture as the
    // visible render path below.
    const url = entry?.playbackUrl ?? null;
    if (url === lastRenderedNextUrl) return;
    lastRenderedNextUrl = url;
    if (!entry || !url) {
      preloadImgEl.removeAttribute('src');
      preloadVideoEl.removeAttribute('src');
      return;
    }
    if (entry.mediaKind === 'video') {
      preloadVideoEl.src = url;
      preloadImgEl.removeAttribute('src');
    } else {
      preloadImgEl.src = url;
      preloadVideoEl.removeAttribute('src');
    }
  }

  return {
    key: 'media_meme_queue',
    activate() {
      ensureElements();
      unsubscribeConnection = options.connection.subscribe(() => { void refetch(); });
    },
    deactivate() {
      unsubscribeConnection?.();
      unsubscribeConnection = undefined;
      fetchToken += 1;
    },
    render() {
      ensureElements();
      const live = currentEntry(latestState);
      applyPreload(nextEntry(latestState));

      // hasSomethingToShow is false both when there is no live entry AND
      // when the live entry's playbackUrl is null (migration 0148:
      // mediaCdnBaseUrl unset today) -- render nothing in either case,
      // the same honest "cannot display until GCS/CDN exists" posture
      // the Sponsor Card and Soundboard already have. `live.playbackUrl`
      // is re-checked explicitly right below (not merely inferred from
      // the helper) so this file never assigns a null src.
      if (!hasSomethingToShow(latestState) || !live || !live.playbackUrl) {
        if (options.container.style.opacity !== '0') options.container.style.opacity = '0';
        if (wrapperEl.style.transform !== 'translateY(-4px)') wrapperEl.style.transform = 'translateY(-4px)';
        if (currentImgEl.style.opacity !== '0') currentImgEl.style.opacity = '0';
        if (currentVideoEl.style.opacity !== '0') currentVideoEl.style.opacity = '0';
        return;
      }
      const playbackUrl = live.playbackUrl;

      if (playbackUrl !== lastRenderedCurrentUrl) {
        lastRenderedCurrentUrl = playbackUrl;
        if (live.mediaKind === 'video') {
          currentVideoEl.src = playbackUrl;
          if (live.thumbnailPlaybackUrl) currentVideoEl.poster = live.thumbnailPlaybackUrl;
          // `play()` can be refused (autoplay policy, before the first
          // user gesture) or, in a test DOM without real media decoding,
          // simply not return a promise at all -- guarded rather than
          // assumed, since there is no error surface on a broadcast
          // overlay to report either case to.
          const playResult: unknown = currentVideoEl.play();
          if (playResult && typeof (playResult as Promise<void>).catch === 'function') {
            void (playResult as Promise<void>).catch(() => {});
          }
          currentImgEl.removeAttribute('src');
        } else {
          currentImgEl.src = playbackUrl;
          currentImgEl.alt = live.title;
          currentVideoEl.removeAttribute('src');
        }
      }

      const showVideo = live.mediaKind === 'video';
      const videoOpacity = showVideo ? '1' : '0';
      const imageOpacity = showVideo ? '0' : '1';
      if (currentVideoEl.style.opacity !== videoOpacity) currentVideoEl.style.opacity = videoOpacity;
      if (currentImgEl.style.opacity !== imageOpacity) currentImgEl.style.opacity = imageOpacity;

      if (options.container.style.opacity !== '1') options.container.style.opacity = '1';
      if (wrapperEl.style.transform !== 'translateY(0)') wrapperEl.style.transform = 'translateY(0)';
    },
  };
}
