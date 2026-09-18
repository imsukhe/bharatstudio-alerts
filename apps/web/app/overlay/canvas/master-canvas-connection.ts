'use client';

/*
 * PRF-02 / §19.5: "One SSE connection... modules as pure render functions
 * driven by a single state store." This file is the ONE connection.
 *
 * Every existing overlay widget page (apps/web/app/overlay/widgets/*)
 * opens its OWN persistent connection to the same
 * `/v1/overlays/:overlayId/events` stream via useOverlayTransport
 * (../widgets/shared/overlay-transport.ts) — that file's own header
 * comment says so: "one long-lived connection per widget instance". N
 * widgets on one Master Canvas therefore meant N connections. This class
 * is the fix: exactly one canvas mounts exactly one MasterCanvasConnection,
 * and every module subscribes to IT rather than opening its own stream.
 * Adding a module calls `subscribe()`/`subscribeToEvents()`, never
 * `start()` — zero new connections (PRF-02.1), now covering all five
 * built modules including Support Theater (PRF-02 slice 3), not only the
 * four snapshot-reading ones.
 *
 * PRF-02 SLICE 3 CORRECTION, 2026-09-16 — read this before changing
 * subscribeToEvents/acknowledge. The first cut of slice 3 gave Support
 * Theater its OWN overlay session and its own separate SSE+acknowledgement
 * transport, on the theory that acknowledgement is session-bound
 * (migration 0022's `ack_overlay_cursor`) and any two consumers sharing a
 * session race to acknowledge the same delivery. That theory was right in
 * general but wrongly applied here: it is a race between the STANDALONE
 * page and this Canvas, not between modules inside ONE Canvas. Inside one
 * Canvas there is exactly one acknowledging consumer — Support Theater —
 * so there is no session-sharing race to defend against by giving it a
 * second session, and doing so cost the thing this whole runtime exists
 * for: one connection, adding a module adds zero connections. Corrected,
 * per the coordinator's own instruction (not this implementer's judgement
 * — see `reviews/2026-09-16-prf-02-slice-3-implementation.md`'s
 * "Correction" section for the full account): Support Theater now
 * acknowledges through THIS connection, using the Canvas's own single
 * overlay session — the same session/token the other four modules already
 * share. The Canvas's session is still distinct from the standalone
 * page's own session (they are separate browser sources with separate
 * session tokens by construction — that is the real boundary the race
 * lives at), so the risk the original design was reacting to is still
 * avoided, just not by adding a second session to the Canvas itself.
 *
 * PHILOSOPHY, extended but not abandoned: for the four snapshot modules
 * this remains "never a source of state, only a 'something may have
 * changed, go re-read' signal" — `subscribe()` is unchanged, costs a
 * listener callback and nothing else, and a module that never calls
 * `subscribeToEvents` never pays for event-payload parsing (see
 * `streamOnce`: the JSON.parse of a data frame's body only runs when at
 * least one event-payload subscriber exists). Support Theater is
 * different in kind — its delivery is once-only and durable, not a
 * disposable snapshot — so `subscribeToEvents()` additionally hands it
 * the actual parsed event payload once per delivery, and `acknowledge()`
 * lets it durably consume that delivery through this same connection's
 * own session/token, never a second one.
 *
 * REPLAY CORRECTNESS WITH A SHARED CURSOR (the part that needed real
 * care, not just plumbing): `get_overlay_events` (migrations 0022/0127,
 * both unchanged) returns deliveries with `status in ('ready','displayed')`
 * — an item stays replay-eligible until ACKNOWLEDGED, regardless of
 * whether some consumer has merely SEEN it on the wire. The four snapshot
 * modules never call `acknowledge()`, so for them "last cursor seen on
 * the wire" (`rawCursor`, tracked from every event's `id:` line) is a
 * perfectly fine `last-event-id` to send on reconnect — they do not care
 * if a reconnect re-sends something they already saw, because they only
 * ever treat any event as "something changed, re-fetch your own
 * snapshot." Support Theater cannot tolerate the opposite failure mode:
 * if reconnect ever sent a cursor AHEAD of what Support Theater has
 * actually acknowledged, an unacknowledged, still-undisplayed delivery
 * could be silently skipped by the server's own `created_at >` filter —
 * a paid alert that never appears again. So once ANY event-payload
 * subscriber exists, reconnect uses `ackCursor` (advanced ONLY by a
 * successful `acknowledge()` call) instead of `rawCursor` — see
 * `streamOnce`'s `resumeCursor` selection below. This is the exact same
 * "acknowledgedCursor, not last-seen" rule the original standalone page
 * (`../[overlayId]/page.tsx`) already enforced for itself; this
 * connection now enforces it centrally for whichever module needs it.
 *
 * FORCED RESYNC ON A LATE EVENT-SUBSCRIBER (the other part that needed
 * care): if the stream is ALREADY running because snapshot modules
 * started it first, and Support Theater's `subscribeToEvents()` joins
 * afterward, simply attaching a listener to the ALREADY-OPEN stream would
 * only hand it FUTURE frames — any delivery that arrived and is still
 * unacknowledged before it joined would never reach it, because the
 * connection does not replay history to a late subscriber, only the wire
 * going forward. So `subscribeToEvents()` detects exactly this transition
 * (stream running, no event-payload subscriber existed yet) and forces
 * one deliberate, immediate reconnect (`forceReconnect`, bypassing the
 * normal backoff) so the fresh connect's `last-event-id` (the current
 * `ackCursor`) triggers a correct replay of everything not yet
 * acknowledged. In THIS codebase's actual host page
 * (`canvas/[overlayId]/page.tsx`), Support Theater is registered AND
 * entitled first, specifically so this path is never exercised during
 * ordinary startup or an ordinary hide/show cycle (all modules there
 * always reconcile in an order where the event-payload subscriber attaches
 * before any snapshot subscriber can start the stream without it) — see
 * that file's own header. It exists as the correctness backstop for
 * whenever that ordering assumption stops holding (e.g. a future
 * independent per-module entitlement refresh), not as a path this
 * codebase's tests need to avoid triggering by accident.
 *
 * BOUNDED DATA (§12.7, PRF-02.10): this class holds no history beyond
 * the current SSE line-buffer tail (bounded by one in-flight frame's
 * size) and two short cursor strings. It never accumulates a queue of
 * past events, and it hands each parsed event payload to a subscriber
 * exactly once, synchronously, without retaining it afterward.
 *
 * LIFECYCLE HYGIENE: the underlying stream is opened only while at least
 * one subscriber (of either kind) exists, and closed the instant the last
 * one unsubscribes (e.g. every module deactivated because the OBS source
 * went hidden — see master-canvas-runtime.ts's visibility handling). A
 * fresh subscribe reopens it. This is PRF-05 ("idle modules cost nothing")
 * carried all the way down to the network, not just to rendering.
 */

export type MasterCanvasConnectionListener = () => void;
/** Called only after the existing shared SSE transport has established a
 * connection. Unlike `subscribe()`, this is not a per-event snapshot signal. */
export type MasterCanvasConnectionLifecycleListener = () => void;
export type MasterCanvasConnectionEvent = { type: 'connected' } | { type: 'data'; payload: unknown };
export type MasterCanvasConnectionEventListener = (event: MasterCanvasConnectionEvent) => void;
export type MasterCanvasAcknowledgeResult = { ok: boolean; status?: number };

export interface MasterCanvasConnectionConfig {
  overlayId: string;
  token: string;
  apiOrigin: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable timers, for deterministic tests. Defaults to globalThis. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export interface MasterCanvasConnection {
  /**
   * Registers a listener called whenever the shared connection thinks a
   * module should re-read its own snapshot (on subscribe, on every
   * (re)connect, and on every event frame, debounced). Returns an
   * unsubscribe function. The underlying stream opens on the first
   * subscriber (of either kind) and closes on the last.
   */
  subscribe(listener: MasterCanvasConnectionListener): () => void;
  /**
   * Registers a listener that additionally receives each event's parsed
   * payload exactly once, plus a `{type:'connected'}` marker on every
   * (re)connect — for the one kind of module whose delivery is once-only
   * rather than a disposable snapshot (Support Theater). See this file's
   * header for the reconnect-cursor and forced-resync guarantees this
   * requires. Only subscribe here if your module genuinely needs the
   * payload; every other module should keep using `subscribe()`.
   */
  subscribeToEvents(listener: MasterCanvasConnectionEventListener): () => void;
  /**
   * Sends the acknowledgement POST (`/v1/overlays/:overlayId/cursor`,
   * migration 0022's `ack_overlay_cursor`, unchanged) using THIS
   * connection's own overlayId/token — never a second session — and, on
   * success, advances the connection's ack-aware reconnect cursor so a
   * future reconnect can never skip this or an earlier delivery. Performs
   * exactly one attempt; retry policy belongs to the caller (Support
   * Theater's own module owns that, gated by its own invalidation token,
   * since only it knows when a retry is still worth attempting).
   */
  acknowledge(cursor: string, eventId: string): Promise<MasterCanvasAcknowledgeResult>;
  /** Number of times the underlying events fetch has actually been
   * initiated — the PRF-02.1 test hook. This must stay 1 no matter how
   * many modules subscribe (of either kind), as long as the stream itself
   * never drops and no event-payload subscriber joins after the stream
   * was already running without one (see file header). */
  getOpenAttemptCount(): number;
  /** Current total subscriber count across regular snapshot, Canvas bootstrap
   * lifecycle, and event-payload subscriptions — 0 means the stream is fully
   * torn down. The type omits the bootstrap hook so ordinary modules cannot
   * acquire it even though this diagnostic total includes it. */
  getSubscriberCount(): number;
}

/**
 * Canvas-page-only recovery hook. It intentionally is not part of the module
 * connection contract: ordinary modules get only snapshot/event delivery and
 * cannot accidentally keep a transport alive for bootstrap work.
 */
export interface MasterCanvasBootstrapConnection {
  /** Subscribe to successful (re)connection only. Shares the existing SSE
   * transport and does not opt into event-payload parsing. */
  subscribeToConnection(listener: MasterCanvasConnectionLifecycleListener): () => void;
}

const REFETCH_DEBOUNCE_MS = 200;
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 4_000;

export function createMasterCanvasConnection(config: MasterCanvasConnectionConfig): MasterCanvasConnection & MasterCanvasBootstrapConnection {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const setTimeoutImpl = config.setTimeoutImpl ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutImpl = config.clearTimeoutImpl ?? globalThis.clearTimeout.bind(globalThis);

  const listeners = new Set<MasterCanvasConnectionListener>();
  const connectionListeners = new Set<MasterCanvasConnectionLifecycleListener>();
  const eventListeners = new Set<MasterCanvasConnectionEventListener>();
  let openAttemptCount = 0;
  let running = false; // true from the moment start() decides to run through to full teardown
  let cancelled = false; // set on stop(); makes the in-flight stream loop exit at its next check
  let rawCursor: string | undefined; // last cursor SEEN on the wire — fine for snapshot-only reconnect
  let ackCursor: string | undefined; // last cursor ACKNOWLEDGED via acknowledge() — required once any event-payload subscriber exists; see file header
  let debounceTimer: ReturnType<typeof setTimeoutImpl> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeoutImpl> | undefined;
  let streamAbort: AbortController | undefined;
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let forceImmediateReconnect = false;

  function notifyAll() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A listener (a module's re-read trigger) must never be able to
        // break the shared connection for every other module — the
        // runtime's own per-module error boundary is the real handler for
        // a module misbehaving; this is belt-and-braces.
      }
    }
  }

  function notifyEvent(event: MasterCanvasConnectionEvent) {
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch {
        // Same belt-and-braces rule as notifyAll() above.
      }
    }
  }

  function notifyConnected() {
    for (const listener of connectionListeners) {
      try {
        listener();
      } catch {
        // Configuration recovery is optional best-effort work. A bad listener
        // must not compromise the shared transport or any live alert module.
      }
    }
  }

  function scheduleNotify() {
    if (debounceTimer !== undefined) clearTimeoutImpl(debounceTimer);
    debounceTimer = setTimeoutImpl(() => {
      debounceTimer = undefined;
      notifyAll();
    }, REFETCH_DEBOUNCE_MS);
  }

  async function streamOnce(): Promise<void> {
    const abort = new AbortController();
    streamAbort = abort;
    openAttemptCount += 1;
    // See file header, "REPLAY CORRECTNESS WITH A SHARED CURSOR": once any
    // event-payload subscriber exists, reconnect must resume from the
    // ack-aware cursor, never the merely-seen one, or an unacknowledged
    // delivery could be silently skipped.
    const resumeCursor = eventListeners.size > 0 ? ackCursor : rawCursor;
    const response = await fetchImpl(`${config.apiOrigin}/v1/overlays/${encodeURIComponent(config.overlayId)}/events`, {
      headers: { authorization: `Bearer ${config.token}`, ...(resumeCursor ? { 'last-event-id': resumeCursor } : {}) },
      cache: 'no-store',
      signal: abort.signal,
    });
    if (!response.ok || !response.body) throw new Error('master_canvas_stream_unavailable');
    // Snapshot-on-connect part 2 (see file header): a (re)connect always
    // triggers one immediate re-read for every subscribed module, and an
    // explicit "connected" marker for every event-payload subscriber so
    // it can resume its own pump/state-machine the way it used to on its
    // own dedicated stream's connect.
    notifyAll();
    notifyConnected();
    notifyEvent({ type: 'connected' });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; // bounded to one in-flight frame's tail — never a history
    try {
      while (!cancelled) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const dataLines: string[] = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('id:')) rawCursor = line.slice(3).trim();
            if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          if (dataLines.length === 0) continue;
          scheduleNotify();
          // Payload parsing only happens when someone actually wants the
          // payload — see file header, "do not make every module pay for
          // payload delivery it does not want."
          if (eventListeners.size > 0) {
            try {
              notifyEvent({ type: 'data', payload: JSON.parse(dataLines.join('\n')) });
            } catch {
              // A malformed frame is dropped here, exactly as the
              // consuming module's own parseOverlayItem-style guard would
              // have dropped it anyway — never thrown past this point.
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async function run(): Promise<void> {
    while (!cancelled) {
      try {
        await streamOnce();
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      } catch {
        // A broken/unavailable stream never surfaces as a thrown error —
        // modules keep their last-known-good snapshot (their own concern,
        // not this connection's) while this loop retries with backoff.
      }
      if (cancelled) break;
      const delay = forceImmediateReconnect ? 0 : reconnectDelay;
      forceImmediateReconnect = false;
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          reconnectTimer = setTimeoutImpl(() => { reconnectTimer = undefined; resolve(); }, delay);
        });
      }
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }
  }

  function start() {
    if (running) return; // idempotent — a second/later subscriber must add zero connections
    running = true;
    cancelled = false;
    reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    void run();
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelled = true;
    if (debounceTimer !== undefined) { clearTimeoutImpl(debounceTimer); debounceTimer = undefined; }
    if (reconnectTimer !== undefined) { clearTimeoutImpl(reconnectTimer); reconnectTimer = undefined; }
    streamAbort?.abort();
    streamAbort = undefined;
    // A fresh connection later starts replay from the server's own bounded
    // window, not a stale cursor from a torn-down session.
    rawCursor = undefined;
    ackCursor = undefined;
  }

  // See file header, "FORCED RESYNC ON A LATE EVENT-SUBSCRIBER". Bypasses
  // the normal backoff entirely — this is a deliberate, immediate resync,
  // not a failure recovery.
  function forceReconnect() {
    if (!running) return;
    forceImmediateReconnect = true;
    reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    streamAbort?.abort();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      start(); // idempotent
      // Snapshot-on-connect part 1: a freshly-subscribed module gets an
      // immediate re-read signal even before any (re)connect happens.
      scheduleNotify();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && connectionListeners.size === 0 && eventListeners.size === 0) stop();
      };
    },
    subscribeToConnection(listener) {
      connectionListeners.add(listener);
      start(); // shares the existing transport; no event payload subscription
      return () => {
        connectionListeners.delete(listener);
        if (listeners.size === 0 && connectionListeners.size === 0 && eventListeners.size === 0) stop();
      };
    },
    subscribeToEvents(listener) {
      const wasRunningWithoutEventListener = running && eventListeners.size === 0;
      eventListeners.add(listener);
      start(); // idempotent — starts fresh only if nothing was running yet
      if (wasRunningWithoutEventListener) forceReconnect();
      return () => {
        eventListeners.delete(listener);
        if (listeners.size === 0 && connectionListeners.size === 0 && eventListeners.size === 0) stop();
      };
    },
    async acknowledge(cursor, eventId) {
      try {
        const response = await fetchImpl(`${config.apiOrigin}/v1/overlays/${encodeURIComponent(config.overlayId)}/cursor`, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ cursor, eventId }),
          keepalive: true,
        });
        if (response.ok) ackCursor = cursor;
        return { ok: response.ok, status: response.status };
      } catch {
        return { ok: false };
      }
    },
    getOpenAttemptCount() { return openAttemptCount; },
    getSubscriberCount() { return listeners.size + connectionListeners.size + eventListeners.size; },
  };
}
