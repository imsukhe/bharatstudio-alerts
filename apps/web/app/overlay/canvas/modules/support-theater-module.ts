/*
 * PRF-02 slice 3 — Support Theater (§6 #1): "Current verified alert, queue
 * state, moderator decision." This is the port of the 418-line imperative
 * standalone page (../../[overlayId]/page.tsx) onto the Master Canvas
 * runtime's activate()/deactivate()/render() shape.
 * `reviews/2026-09-16-prf-02-slice-3-implementation.md` carries the full
 * design reasoning this header only summarises.
 *
 * CORRECTION, 2026-09-16 — this module originally opened its OWN,
 * separate overlay session and its own dedicated SSE+acknowledgement
 * transport, distinct from the Canvas's shared `MasterCanvasConnection`.
 * That was built to a literal reading of an instruction whose intent was
 * narrower than its wording — the coordinator's own correction, recorded
 * in full in the review record's "Correction" section, not this
 * implementer's judgement call to revisit. Inside ONE Canvas there is
 * exactly one acknowledging consumer (this module); the other four are
 * stateless snapshot readers that never call `/cursor`, so there was no
 * acknowledgement race *inside* the Canvas to defend against — the real
 * race the original scope review found is between this Canvas and the
 * SEPARATE standalone page (`../../[overlayId]/page.tsx`), which already
 * has its own, different session by construction (a different browser
 * source, a different session token). Giving Support Theater a second
 * session bought nothing against a risk that did not exist at that
 * boundary, and cost the property PRF-02 exists for: one connection,
 * adding a module adds zero connections. Corrected: this module now
 * acknowledges through the Canvas's OWN single `MasterCanvasConnection`,
 * using the same overlayId/token the other four modules already share.
 * See `master-canvas-connection.ts`'s own header for how that connection
 * was extended to make this safe — an event-payload subscription
 * (`subscribeToEvents`) alongside the existing signal-only one, an
 * ack-aware reconnect cursor so a shared reconnect can never skip an
 * unacknowledged delivery, and a forced immediate resync if this module's
 * event subscription ever attaches after the stream is already running
 * without one.
 *
 * ONE INVALIDATION TOKEN (this task's own binding instruction, unchanged
 * by the correction above): every piece of async/timer-driven state this
 * module owns — the acknowledgement retry loop, the display timer, the
 * Lottie-asset fetch, and the TTS/chime audio fetch — is gated by the SAME
 * `generation` counter, incremented exactly once per deactivate() call.
 * Every await point that can outlive a deactivate() re-checks
 * `generation === myGeneration` before it is allowed to mutate any shared
 * state or touch the DOM. Three independent `cancelled` flags (as the
 * standalone page effectively had, split across its stream effect, its
 * Lottie effect and its audio effect) is exactly the shape the task's own
 * review flagged as "how one of them gets missed" — this module has one.
 *
 * THE STALE-active.current DEFECT, MADE IMPOSSIBLE BY CONSTRUCTION: the
 * standalone page's `active = useRef(false)` "one group in flight" gate is
 * created once for the component's lifetime and is NEVER reset — fine
 * there, because a React component that unmounts is gone for good. This
 * module's activate() can be called again on the SAME returned object
 * (the runtime's own reconcile() re-activates a module whenever it
 * regains entitlement or the page becomes visible again — see
 * master-canvas-runtime.ts). If the pump-in-flight gate were only ever
 * reset by deactivate(), a bug there (or an interleaving this file's
 * author didn't foresee) could leave it stuck `true` forever. Instead,
 * activate() ITSELF unconditionally resets every piece of pump state
 * (`resetForActivation()`, below) before doing anything else — so even a
 * hypothetically-broken deactivate() cannot leave a stale gate behind for
 * the next activation. This is the property PRF-02-slice-3's own test
 * suite (support-theater-module.test.ts, "deactivate() mid-acknowledgement
 * ... then re-activate ... the pump runs") exists to prove directly,
 * rather than merely asserting it never regresses by luck. This property
 * was unaffected by the transport correction above — it lives entirely in
 * this module's own state machine, not in how events arrive.
 *
 * BOUNDED DOM / §12.7 "current and next alert state": this module renders
 * exactly the CURRENT displayed group (bounded by the SAME aggregation
 * cap overlay-policy.ts already enforces) and exactly ONE next-up entry —
 * never a queue depth, never a second item deeper in the queue. An
 * aggregate card's per-supporter lines are drawn from a small FIXED,
 * recycled pool (DEFAULT_THEATER_AGGREGATE_POOL_SIZE), the same bounded-
 * DOM correction PRF-02.5 already applied to the ticker — the standalone
 * page maps every aggregated item into a freshly appended <p> with no
 * pool at all; this module does not repeat that.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection, MasterCanvasConnectionEvent } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';
import { playChime, safeAudioUrl } from '../alert-audio';
import { playAudioWithTimeout } from '../../tts-runtime';
import { browserTtsFallback, cancelBrowserTts, shouldShowWatermark, speakWithBrowserTts } from '../../[overlayId]/tts-fallback';
import {
  aggregateLabel,
  amountPaise,
  bracketFor,
  configForItem,
  displayDurationMs,
  normalizeOverlayConfig,
  parseOverlayItem,
  requeueUnacknowledged,
  selectPresentationGroup,
  truncateMessage,
  ttsPlaybackPlan,
  type OverlayConfig,
  type OverlayItem,
} from '../../overlay-policy';

export const DEFAULT_THEATER_AGGREGATE_POOL_SIZE = 8;
// Bounded to a single next-up entry — §12.7's Overlay row authorises
// "current and next alert state" in those words; nothing deeper.
const NEXT_UP_MESSAGE_LIMIT = 60;

export interface SupportTheaterModuleOptions {
  container: HTMLElement;
  /** The Canvas's ONE shared connection — the same instance the other
   * four modules subscribe to. This module uses `subscribeToEvents` and
   * `acknowledge`, never a second connection. See file header. */
  connection: MasterCanvasConnection;
  /** The Canvas's own overlayId/token — the SAME session the shared
   * `connection` above already uses. Still needed here directly only for
   * the Lottie-asset and audio-artifact REST fetches, which are separate
   * endpoints from `/events`/`/cursor` and are not (yet) routed through
   * the shared connection. */
  overlayId: string;
  token: string;
  apiOrigin: string;
  reducedMotion: () => boolean;
  /** Injectable for tests; defaults to globalThis.fetch. Used only for
   * the Lottie-asset and audio-artifact fetches — see above. */
  fetchImpl?: typeof fetch;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  /** Injectable for tests; defaults to `new Audio(url)`. */
  createAudio?: (objectUrl: string) => { play: () => Promise<void> | void; pause: () => void };
  /** Injectable for tests; defaults to loading the real lottie-web package
   * against the module's own scoped overlay-lottie endpoint. */
  loadLottie?: (container: HTMLElement, url: string, token: string) => Promise<{ destroy(): void } | undefined>;
  nameStyle?: CanvasTextStyle;
  amountStyle?: CanvasTextStyle;
  messageStyle?: CanvasTextStyle;
  labelStyle?: CanvasTextStyle;
}

function textValue(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function amountLabel(item: OverlayItem): string {
  const amount = amountPaise(item);
  return amount > 0 ? `₹${(amount / 100).toLocaleString('en-IN')}` : '';
}

async function defaultLoadLottie(container: HTMLElement, url: string, token: string, fetchImpl: typeof fetch): Promise<{ destroy(): void } | undefined> {
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!response.ok) return undefined;
  const animationData: unknown = await response.json();
  const lottie = (await import('lottie-web')).default;
  return lottie.loadAnimation({ container, renderer: 'svg', loop: false, autoplay: true, animationData });
}

export function createSupportTheaterModule(options: SupportTheaterModuleOptions): CanvasModuleDefinition {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const setTimeoutImpl = options.setTimeoutImpl ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutImpl = options.clearTimeoutImpl ?? globalThis.clearTimeout.bind(globalThis);
  const loadLottieImpl = options.loadLottie ?? ((container, url, token) => defaultLoadLottie(container, url, token, fetchImpl));
  const nameStyle = options.nameStyle ?? defaultCanvasTextStyles().name;
  const amountStyle = options.amountStyle ?? defaultCanvasTextStyles().amount;
  const messageStyle = options.messageStyle ?? defaultCanvasTextStyles().message;
  const labelStyle = options.labelStyle ?? defaultCanvasTextStyles().label;

  // ---- ONE invalidation token (see file header). Every field below it is
  // reset unconditionally at the TOP of activate(), never only relied on
  // to have been reset by a prior deactivate() — see file header, "THE
  // STALE-active.current DEFECT".
  let generation = 0;

  let ready = false; // DOM built (once; never rebuilt across re-activations)
  let rootEl: HTMLElement;
  let currentEl: HTMLElement;
  let lottieEl: HTMLElement;
  let kickerEl: HTMLElement;
  let nameEl: HTMLElement;
  let messageEl: HTMLElement;
  let aggregateLines: HTMLElement[] = [];
  let nextEl: HTMLElement;
  let nextEntryEl: HTMLElement;

  let queue: OverlayItem[] = [];
  let pumpActive = false; // the "one group in flight" gate — see file header
  let pendingCursors = new Set<string>();
  let arrivalSequence = 0;
  let currentGroup: OverlayItem[] = [];
  let currentConfig: OverlayConfig = normalizeOverlayConfig(undefined);
  let dirty = false;
  let displayTimerHandle: ReturnType<typeof setTimeoutImpl> | undefined;
  let lottieAssets = new Map<string, string>();
  let lottieInstance: { destroy(): void } | undefined;
  let currentAudioController: { pause: () => void } | undefined;
  let currentObjectUrl: string | undefined;
  let unsubscribeEvents: (() => void) | undefined;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeoutImpl(() => resolve(), ms); });
  }

  function stopAudio() {
    currentAudioController?.pause();
    currentAudioController = undefined;
    if (currentObjectUrl) {
      try { URL.revokeObjectURL(currentObjectUrl); } catch { /* best-effort cleanup */ }
    }
    currentObjectUrl = undefined;
    cancelBrowserTts();
  }

  function stopLottie() {
    lottieInstance?.destroy();
    lottieInstance = undefined;
    if (ready) lottieEl.textContent = '';
  }

  function ensureElements() {
    if (ready) return;
    const doc = options.container.ownerDocument;
    options.container.textContent = '';
    options.container.style.position = 'relative';

    rootEl = doc.createElement('div');
    rootEl.dataset.role = 'support-theater-root';

    currentEl = doc.createElement('div');
    currentEl.dataset.role = 'support-theater-current';
    currentEl.style.opacity = '0'; // nothing to show until the first real delivery lands
    // Composite-only (PRF-03): opacity is the only animated property here,
    // never width/height/top/left.
    currentEl.style.transition = options.reducedMotion() ? 'none' : 'opacity 200ms ease';

    lottieEl = doc.createElement('div');
    lottieEl.dataset.role = 'support-theater-lottie';
    lottieEl.setAttribute('aria-hidden', 'true');

    kickerEl = doc.createElement('div');
    kickerEl.dataset.role = 'support-theater-kicker';
    kickerEl.style.fontFamily = labelStyle.fontFamily;

    nameEl = doc.createElement('strong');
    nameEl.dataset.role = 'support-theater-name';
    nameEl.style.fontFamily = nameStyle.fontFamily;

    messageEl = doc.createElement('p');
    messageEl.dataset.role = 'support-theater-message';
    messageEl.style.fontFamily = messageStyle.fontFamily;

    aggregateLines = [];
    for (let i = 0; i < DEFAULT_THEATER_AGGREGATE_POOL_SIZE; i += 1) {
      const line = doc.createElement('p');
      line.dataset.role = 'support-theater-aggregate-line';
      line.style.fontFamily = messageStyle.fontFamily;
      line.style.opacity = '0';
      aggregateLines.push(line);
    }

    currentEl.append(lottieEl, kickerEl, nameEl, messageEl, ...aggregateLines);

    nextEl = doc.createElement('div');
    nextEl.dataset.role = 'support-theater-next';
    nextEl.style.opacity = '0';
    nextEl.style.transition = options.reducedMotion() ? 'none' : 'opacity 200ms ease';
    nextEl.style.fontFamily = labelStyle.fontFamily;

    const nextLabelEl = doc.createElement('span');
    nextLabelEl.dataset.role = 'support-theater-next-label';
    nextLabelEl.textContent = 'Next up';

    nextEntryEl = doc.createElement('span');
    nextEntryEl.dataset.role = 'support-theater-next-entry';
    nextEntryEl.style.fontFamily = amountStyle.fontFamily;

    nextEl.append(nextLabelEl, nextEntryEl);

    rootEl.append(currentEl, nextEl);
    options.container.appendChild(rootEl);
    ready = true;
  }

  // ---- Acknowledgement (migration 0022's ack_overlay_cursor, unchanged;
  // routed through the shared connection's own `acknowledge()`, which
  // performs one attempt using the Canvas's single session). This loop is
  // the retry policy — the connection deliberately does not own retries,
  // only the HTTP mechanics, since only this module knows when a retry is
  // still worth attempting. Gated by `generation` at every await — this
  // is one leg of the one invalidation token.
  async function acknowledge(item: OverlayItem, myGeneration: number): Promise<boolean> {
    let retryDelay = 500;
    while (generation === myGeneration) {
      try {
        const result = await options.connection.acknowledge(item.cursor, item.eventId);
        if (generation !== myGeneration) return false;
        if (result.ok) return true;
        if (result.status === 400 || result.status === 401) return false;
      } catch {
        // Retryable — the item remains durable and visible until the
        // server confirms it (same rule as the standalone page).
      }
      if (generation !== myGeneration) return false;
      await sleep(retryDelay);
      if (generation !== myGeneration) return false;
      retryDelay = Math.min(retryDelay * 2, 5_000);
    }
    return false;
  }

  function setCurrentGroup(group: OverlayItem[]) {
    currentGroup = group;
    currentConfig = group[0] ? configForItem(group[0]) : normalizeOverlayConfig(undefined);
    dirty = true;
  }

  async function finishDisplay(group: OverlayItem[], myGeneration: number) {
    const acknowledgementOrder = [...group].sort((a, b) => (a.arrivalOrder ?? 0) - (b.arrivalOrder ?? 0));
    for (const [index, item] of acknowledgementOrder.entries()) {
      const acknowledged = await acknowledge(item, myGeneration);
      if (generation !== myGeneration) return; // deactivated mid-acknowledgement — stop; nothing lost (see file header), nothing double-acked
      if (!acknowledged) {
        // Requeue the unacknowledged suffix and resume the pump directly
        // — no need to disturb the SHARED connection (unlike the
        // module's original dedicated-stream design, forcing a reconnect
        // here would now also interrupt the four other modules). The
        // item stays in `pendingCursors`, so it is neither lost nor
        // eligible to be double-added if the server ever replays it again.
        queue = requeueUnacknowledged(acknowledgementOrder, index, queue);
        setCurrentGroup([]);
        pumpActive = false;
        pump(myGeneration);
        return;
      }
      pendingCursors.delete(item.cursor);
    }
    if (generation !== myGeneration) return;
    setCurrentGroup([]);
    pumpActive = false;
    pump(myGeneration);
  }

  function pump(myGeneration: number) {
    if (generation !== myGeneration) return;
    if (pumpActive || queue.length === 0) return;
    const first = queue[0]!;
    const config = configForItem(first);
    const selected = selectPresentationGroup(queue, config);
    queue = selected.rest;
    pumpActive = true;
    setCurrentGroup(selected.group);
    void playForGroup(selected.group, config, myGeneration);
    void showLottieForGroup(selected.group, config, myGeneration);
    if (displayTimerHandle !== undefined) clearTimeoutImpl(displayTimerHandle);
    displayTimerHandle = setTimeoutImpl(() => {
      displayTimerHandle = undefined;
      void finishDisplay(selected.group, myGeneration);
    }, displayDurationMs(selected.group, config));
  }

  function receive(rawPayload: unknown, myGeneration: number) {
    try {
      const item = parseOverlayItem(rawPayload);
      if (!item || item.eventType === 'resync.required') return;
      if (pendingCursors.has(item.cursor)) return; // dedup across the module's own lifetime — see file header
      pendingCursors.add(item.cursor);
      item.arrivalOrder = arrivalSequence++;
      queue.push(item);
      dirty = true; // the queue changed even when the currently-displayed group did not — "next up" must still refresh
      pump(myGeneration);
    } catch {
      // Malformed presentation data is ignored; the durable delivery is
      // replayed after reconnect because it was never acknowledged.
    }
  }

  function onConnectionEvent(event: MasterCanvasConnectionEvent, myGeneration: number) {
    if (generation !== myGeneration) return;
    if (event.type === 'connected') {
      // A failed acknowledgement may have requeued an item, or the shared
      // connection itself may have reconnected for an unrelated reason —
      // either way, resume the pump now that the connection is confirmed
      // live. Cheap and idempotent (pump() no-ops if already active or
      // the queue is empty).
      pump(myGeneration);
      return;
    }
    receive(event.payload, myGeneration);
  }

  async function loadLottieAssets(myGeneration: number): Promise<void> {
    try {
      const response = await fetchImpl(`${options.apiOrigin}/v1/overlay-lottie/${encodeURIComponent(options.overlayId)}`, {
        headers: { authorization: `Bearer ${options.token}` }, cache: 'no-store',
      });
      if (generation !== myGeneration || !response.ok) return;
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !Array.isArray((body as { items?: unknown }).items)) return;
      const next = new Map<string, string>();
      for (const item of (body as { items: unknown[] }).items) {
        if (item && typeof item === 'object' && typeof (item as { displayStyle?: unknown }).displayStyle === 'string' && typeof (item as { artifactId?: unknown }).artifactId === 'string') {
          next.set((item as { displayStyle: string }).displayStyle, (item as { artifactId: string }).artifactId);
        }
      }
      if (generation === myGeneration) lottieAssets = next;
    } catch {
      // Best-effort — an overlay with no custom branding renders with the
      // existing text-only cards.
    }
  }

  async function showLottieForGroup(group: OverlayItem[], config: OverlayConfig, myGeneration: number): Promise<void> {
    stopLottie();
    if (config.reducedMotion || group.length === 0) return;
    const style = bracketFor(group[0]!, config).displayStyle;
    const artifactId = lottieAssets.get(style);
    if (!artifactId) return;
    const url = `${options.apiOrigin}/v1/overlay-lottie/${encodeURIComponent(options.overlayId)}/${encodeURIComponent(artifactId)}`;
    try {
      const instance = await loadLottieImpl(lottieEl, url, options.token);
      if (generation !== myGeneration || currentGroup !== group) {
        instance?.destroy();
        return;
      }
      lottieInstance = instance;
    } catch {
      // Best-effort enrichment only — the CSS-driven card is already shown.
    }
  }

  async function playForGroup(group: OverlayItem[], config: OverlayConfig, myGeneration: number): Promise<void> {
    stopAudio();
    if (group.length === 0) return;
    const plan = ttsPlaybackPlan(group[0]!, config);
    if (plan.mode === 'silent') return;
    const url = plan.mode === 'audio' && plan.audioUrl ? safeAudioUrl(plan.audioUrl, options.apiOrigin) : undefined;
    if (url) {
      try {
        const response = await fetchImpl(url, { headers: { authorization: `Bearer ${options.token}` }, cache: 'no-store' });
        if (generation !== myGeneration || currentGroup !== group) return;
        if (!response.ok) throw new Error('support_theater_audio_unavailable');
        const objectUrl = URL.createObjectURL(await response.blob());
        if (generation !== myGeneration || currentGroup !== group) { URL.revokeObjectURL(objectUrl); return; }
        const audio = options.createAudio ? options.createAudio(objectUrl) : new Audio(objectUrl);
        currentObjectUrl = objectUrl;
        currentAudioController = audio;
        if (await playAudioWithTimeout(audio)) return;
        if (generation !== myGeneration || currentGroup !== group) return;
      } catch {
        // Provider/audio playback failures fall through to the chime below.
      }
    }
    if (generation !== myGeneration || currentGroup !== group) return;
    const fallback = browserTtsFallback(group[0]!, config, Boolean(url));
    if (fallback.engage) {
      speakWithBrowserTts(fallback.text, fallback.locale);
      return;
    }
    playChime();
  }

  function resetForActivation() {
    // See file header, "THE STALE-active.current DEFECT". Every piece of
    // pump/session state is reset HERE, unconditionally, rather than only
    // trusted to have been reset by whatever deactivate() last did.
    generation += 1;
    queue = [];
    pumpActive = false;
    pendingCursors = new Set();
    arrivalSequence = 0;
    currentGroup = [];
    currentConfig = normalizeOverlayConfig(undefined);
    dirty = true; // force a render that clears any stale display from a prior activation
    if (displayTimerHandle !== undefined) { clearTimeoutImpl(displayTimerHandle); displayTimerHandle = undefined; }
    unsubscribeEvents?.();
    unsubscribeEvents = undefined;
    stopAudio();
    stopLottie();
  }

  function renderGroup() {
    ensureElements();
    const group = currentGroup;
    if (group.length === 0) {
      if (currentEl.style.opacity !== '0') currentEl.style.opacity = '0';
      for (const line of aggregateLines) { if (line.style.opacity !== '0') { line.style.opacity = '0'; line.textContent = ''; } }
      return;
    }
    if (currentEl.style.opacity !== '1') currentEl.style.opacity = '1';
    const first = group[0]!;
    const watermark = shouldShowWatermark(first);
    const kickerText = watermark ? 'BharatStudio' : '';
    if (kickerEl.textContent !== kickerText) kickerEl.textContent = kickerText;
    if (kickerEl.style.display !== (watermark ? '' : 'none')) kickerEl.style.display = watermark ? '' : 'none';

    if (currentConfig.queue.mode === 'aggregated' && group.length > 1) {
      const nameText = aggregateLabel(group);
      if (nameEl.textContent !== nameText) nameEl.textContent = nameText;
      if (messageEl.style.display !== 'none') messageEl.style.display = 'none';
      const shown = group.slice(0, DEFAULT_THEATER_AGGREGATE_POOL_SIZE);
      for (let i = 0; i < aggregateLines.length; i += 1) {
        const line = aggregateLines[i]!;
        const item = shown[i];
        if (item) {
          const limit = bracketFor(item, currentConfig).charLimit;
          const name = textValue(item.payload, 'displayName') || 'Someone';
          const amount = amountLabel(item);
          const message = truncateMessage(item.payload.message, limit);
          const text = `${name}${amount ? ` · ${amount}` : ''}${message ? ` — ${message}` : ''}`;
          if (line.textContent !== text) line.textContent = text;
          if (line.style.opacity !== '1') line.style.opacity = '1';
        } else if (line.style.opacity !== '0') {
          line.style.opacity = '0';
          line.textContent = '';
        }
      }
      const overflow = group.length - shown.length;
      if (overflow > 0) {
        const lastVisible = aggregateLines[aggregateLines.length - 1]!;
        lastVisible.textContent = `${lastVisible.textContent} · +${overflow} more`;
      }
    } else {
      for (const line of aggregateLines) { if (line.style.opacity !== '0') { line.style.opacity = '0'; line.textContent = ''; } }
      const limit = bracketFor(first, currentConfig).charLimit;
      const name = textValue(first.payload, 'displayName') || 'Someone';
      const amount = amountLabel(first);
      const nameText = `${name}${amount ? ` · ${amount}` : ''}`;
      if (nameEl.textContent !== nameText) nameEl.textContent = nameText;
      const message = truncateMessage(first.payload.message, limit);
      if (messageEl.style.display !== '') messageEl.style.display = '';
      if (messageEl.textContent !== message) messageEl.textContent = message;
    }
  }

  function renderNextUp() {
    const next = queue[0];
    if (!next) {
      if (nextEl.style.opacity !== '0') nextEl.style.opacity = '0';
      if (nextEntryEl.textContent !== '') nextEntryEl.textContent = '';
      return;
    }
    if (nextEl.style.opacity !== '1') nextEl.style.opacity = '1';
    const nextConfig = configForItem(next);
    const name = textValue(next.payload, 'displayName') || 'Someone';
    const amount = amountLabel(next);
    const message = truncateMessage(next.payload.message, Math.min(NEXT_UP_MESSAGE_LIMIT, bracketFor(next, nextConfig).charLimit));
    const text = `${name}${amount ? ` · ${amount}` : ''}${message ? ` — ${message}` : ''}`;
    if (nextEntryEl.textContent !== text) nextEntryEl.textContent = text;
  }

  return {
    key: 'support_theater',
    activate() {
      resetForActivation();
      ensureElements();
      const myGeneration = generation;
      unsubscribeEvents = options.connection.subscribeToEvents((event) => onConnectionEvent(event, myGeneration));
      void loadLottieAssets(myGeneration);
    },
    deactivate() {
      // Bumps generation — every in-flight fetch, the display timer, and
      // the acknowledgement retry loop all observe the new value at their
      // next check and stop touching shared state or the DOM. Idempotent:
      // calling this when already deactivated just bumps generation again
      // harmlessly (nothing is currently running under the old one).
      generation += 1;
      queue = [];
      pumpActive = false;
      pendingCursors = new Set();
      currentGroup = [];
      dirty = false;
      if (displayTimerHandle !== undefined) { clearTimeoutImpl(displayTimerHandle); displayTimerHandle = undefined; }
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
      stopAudio();
      stopLottie();
      if (ready) {
        currentEl.style.opacity = '0';
        nextEl.style.opacity = '0';
      }
    },
    render() {
      if (!dirty) return;
      dirty = false;
      renderGroup();
      renderNextUp();
    },
  };
}
