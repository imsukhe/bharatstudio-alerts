/*
 * Safe Soundboard Alert module — §6 catalogue module #6, with the
 * minimum §18 schema behind it (migration 0143).
 *
 * Reads the `/v1/overlay-widgets/:overlayId/safe-soundboard` snapshot
 * (`app_private.list_overlay_soundboard_play`) through the host page's
 * injected `fetchSnapshot`, on the SAME shared `MasterCanvasConnection`
 * every other module uses. It opens no connection, no session and no
 * transport of its own, and schedules no timer/frame of its own — a new
 * poll arrives on the runtime's existing shared cadence, exactly like the
 * lobby status and giveaway/tournament cards.
 *
 * THE NAME IS ABOUT THE BROADCAST, NOT THE CONTENT — see
 * ./safe-soundboard-logic.ts's header. No UI copy here may claim a clip
 * is safe, approved, checked, reviewed, vetted or curated.
 *
 * NO THIRD-PARTY CODE, EVER (§9.1.1, PRF-13). `playbackUrl` is the ONLY
 * field capable of naming an external resource, and it is re-validated
 * https-or-null a THIRD time here (`isOverlaySoundboardPlay`), after the
 * SQL layer's narrow object-key character set and the API projection's
 * own https check — three independent narrowings. There is no field here
 * for arbitrary HTML, a script or a stylesheet at all.
 *
 * "QUEUE" IS "LATEST SUPERSEDES", STATED HERE TOO. A repeated poll that
 * returns the SAME playId is a no-op (`isNewPlay`); a poll that returns a
 * DIFFERENT playId while a clip is still playing stops the current clip
 * and starts the new one — there is no never-drop multi-item queue (see
 * migration 0143's header for why not). NO COOLDOWN is applied; none is
 * decided anywhere in this repository.
 *
 * AUDIO PLAYBACK, BEST-EFFORT. Mirrors support-theater-module.ts's own
 * `new Audio(objectUrl)` pattern, except the source here is the
 * server-resolved CDN URL directly (§19.1: GCS/CDN with a short-lived
 * SIGNED URL, which already carries its own auth in the query string —
 * unlike the TTS artifact route, no bearer-token fetch-then-blob step is
 * needed). A browser that refuses autoplay, or a network failure, fails
 * SILENTLY: the caption still shows briefly and nothing throws past this
 * module's boundary. `playbackUrl: null` (every environment today, since
 * no CDN base is configured — see db/safe-soundboard-overlay-store.ts)
 * renders the caption with no audio at all, which is the honest state of
 * an unconfigured deployment rather than a broken one.
 *
 * COMPOSITE-ONLY (PRF-03). `render()` writes only `opacity` and
 * `transform`, plus one text node's contents. One element pool, created
 * once, reused forever — there is no per-clip or per-trigger element to
 * append, because there is no per-trigger data beyond the single caption.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';
import {
  formatNowPlayingLabel,
  isNewPlay,
  isOverlaySoundboardPlay,
  type OverlaySoundboardPlay,
} from './safe-soundboard-logic';

/** How long the "now playing" caption stays visible after a NEW trigger,
 *  independent of the clip's own duration (which the browser's audio
 *  element already governs for playback itself). Not a product number —
 *  a presentation-only, structural display window for a text caption,
 *  the same category of value the giveaway/tournament card's own fixed
 *  240ms/400ms transition timings already are. */
const CAPTION_VISIBLE_MS = 4000;

export interface SafeSoundboardModuleOptions {
  container: HTMLElement;
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<OverlaySoundboardPlay | null>;
  reducedMotion: () => boolean;
  labelStyle?: CanvasTextStyle;
  /** Injectable for tests; defaults to `new Audio(url)`. */
  createAudio?: (url: string) => { play: () => Promise<void> | void; pause: () => void };
  /** Injected so the caption timer is testable without a real clock.
   *  Defaults to the wall clock. */
  now?: () => number;
}

export function createSafeSoundboardModule(options: SafeSoundboardModuleOptions): CanvasModuleDefinition {
  const labelStyle = options.labelStyle ?? defaultCanvasTextStyles().amount;
  const now = options.now ?? (() => Date.now());

  let ready = false;
  let cardEl: HTMLElement;
  let labelEl: HTMLElement;
  let latestPlay: OverlaySoundboardPlay | null = null;
  let lastPlayedId: string | null = null;
  let captionUntilMs = 0;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;
  let currentAudio: { play: () => Promise<void> | void; pause: () => void } | undefined;

  function ensureElements() {
    if (ready) return;
    const doc = options.container.ownerDocument;
    options.container.textContent = '';
    options.container.style.opacity = '0';

    cardEl = doc.createElement('div');
    cardEl.dataset.role = 'safe-soundboard-card';
    cardEl.style.display = 'flex';
    cardEl.style.transition = options.reducedMotion() ? 'none' : 'opacity 240ms ease, transform 240ms ease';
    cardEl.style.transform = 'translateY(-4px)';

    labelEl = doc.createElement('span');
    labelEl.dataset.role = 'safe-soundboard-label';
    labelEl.style.fontFamily = labelStyle.fontFamily;

    cardEl.appendChild(labelEl);
    options.container.appendChild(cardEl);
    ready = true;
  }

  function stopAudio() {
    currentAudio?.pause();
    currentAudio = undefined;
  }

  function playClip(play: OverlaySoundboardPlay) {
    stopAudio();
    if (!play.playbackUrl) return; // configured-but-unset CDN base -- see file header
    const audio = options.createAudio ? options.createAudio(play.playbackUrl) : new Audio(play.playbackUrl);
    currentAudio = audio;
    // Best-effort: autoplay refusal or a network failure must never throw
    // past this module's boundary. The caption already carries the visible
    // signal regardless of whether audio actually played.
    void Promise.resolve(audio.play()).catch(() => undefined);
  }

  async function refetch() {
    const token = ++fetchToken;
    const result = await options.fetchSnapshot().catch(() => null);
    if (token !== fetchToken) return;
    latestPlay = result && isOverlaySoundboardPlay(result) ? result : null;

    if (isNewPlay(latestPlay, lastPlayedId)) {
      lastPlayedId = latestPlay.playId;
      captionUntilMs = now() + CAPTION_VISIBLE_MS;
      playClip(latestPlay);
    }
  }

  return {
    key: 'safe_soundboard_alert',
    activate() {
      ensureElements();
      unsubscribeConnection = options.connection.subscribe(() => { void refetch(); });
    },
    deactivate() {
      unsubscribeConnection?.();
      unsubscribeConnection = undefined;
      fetchToken += 1;
      stopAudio();
      // `latestPlay` is a latest-supersedes snapshot, not a consumed queue.
      // Keep this page instance's de-duplication boundary across an OBS
      // hide/show: reactivation will re-read the same durable latest play, but
      // must not replay historical audio merely because rendering paused.
      captionUntilMs = 0;
    },
    // No `dirty` short-circuit, matching the giveaway/tournament card: the
    // caption's own visible window expires on the shared frame clock with
    // no new snapshot behind it, so render() must re-evaluate every frame.
    // Nothing is WRITTEN unless the rendered text/opacity actually changed.
    render() {
      ensureElements();
      const showing = latestPlay !== null && now() < captionUntilMs;

      if (!showing) {
        if (options.container.style.opacity !== '0') options.container.style.opacity = '0';
        if (cardEl.style.opacity !== '0') cardEl.style.opacity = '0';
        if (cardEl.style.transform !== 'translateY(-4px)') cardEl.style.transform = 'translateY(-4px)';
        if (labelEl.textContent !== '') labelEl.textContent = '';
        return;
      }

      const label = formatNowPlayingLabel(latestPlay as OverlaySoundboardPlay);
      if (labelEl.textContent !== label) labelEl.textContent = label;
      if (options.container.style.opacity !== '1') options.container.style.opacity = '1';
      if (cardEl.style.opacity !== '1') cardEl.style.opacity = '1';
      if (cardEl.style.transform !== 'translateY(0)') cardEl.style.transform = 'translateY(0)';
    },
  };
}
