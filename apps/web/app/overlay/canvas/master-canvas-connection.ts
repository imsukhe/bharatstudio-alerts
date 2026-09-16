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
 * Adding a module calls `subscribe()`, never `start()` — zero new
 * connections (PRF-02.1).
 *
 * PHILOSOPHY, unchanged from overlay-transport.ts: the stream is never a
 * source of state, only a "something may have changed, go re-read" signal.
 * A module's own REST snapshot read (the same endpoints
 * useOverlayTransport-based widgets already call —
 * /v1/overlay-widgets/:overlayId/supporter-ticker,
 * /v1/overlay-goals/:overlayId) remains the only source of a displayed
 * value. This class only tells a module WHEN to re-read: on every
 * subscribe (so a freshly-activated module gets its first read), on every
 * stream (re)connect (closes the "replay resent nothing" gap the same way
 * overlay-transport.ts's own comment explains), and on every event frame
 * (debounced).
 *
 * BOUNDED DATA (§12.7, PRF-02.10): this class holds no history. It keeps
 * only the current SSE line-buffer tail (bounded by one in-flight frame's
 * size, exactly like overlay-transport.ts) and the current replay cursor
 * string. It never accumulates a queue of past events — a frame's content
 * is never inspected beyond whether it carries a `data:` line and an
 * `id:` cursor; the payload itself is discarded immediately.
 *
 * LIFECYCLE HYGIENE: the underlying stream is opened only while at least
 * one module is subscribed, and closed the instant the last one
 * unsubscribes (e.g. every module deactivated because the OBS source went
 * hidden — see master-canvas-runtime.ts's visibility handling). A fresh
 * subscribe reopens it. This is PRF-05 ("idle modules cost nothing")
 * carried all the way down to the network, not just to rendering.
 */

export type MasterCanvasConnectionListener = () => void;

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
   * subscribe and closes on the last unsubscribe.
   */
  subscribe(listener: MasterCanvasConnectionListener): () => void;
  /** Number of times the underlying events fetch has actually been
   * initiated — the PRF-02.1 test hook. This must stay 1 no matter how
   * many modules subscribe, as long as the stream itself never drops. */
  getOpenAttemptCount(): number;
  /** Current subscriber count — 0 means the stream is fully torn down. */
  getSubscriberCount(): number;
}

const REFETCH_DEBOUNCE_MS = 200;
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 4_000;

export function createMasterCanvasConnection(config: MasterCanvasConnectionConfig): MasterCanvasConnection {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const setTimeoutImpl = config.setTimeoutImpl ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutImpl = config.clearTimeoutImpl ?? globalThis.clearTimeout.bind(globalThis);

  const listeners = new Set<MasterCanvasConnectionListener>();
  let openAttemptCount = 0;
  let running = false; // true from the moment start() decides to run through to full teardown
  let cancelled = false; // set on stop(); makes the in-flight stream loop exit at its next check
  let cursor: string | undefined;
  let debounceTimer: ReturnType<typeof setTimeoutImpl> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeoutImpl> | undefined;
  let streamAbort: AbortController | undefined;

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
    const response = await fetchImpl(`${config.apiOrigin}/v1/overlays/${encodeURIComponent(config.overlayId)}/events`, {
      headers: { authorization: `Bearer ${config.token}`, ...(cursor ? { 'last-event-id': cursor } : {}) },
      cache: 'no-store',
      signal: abort.signal,
    });
    if (!response.ok || !response.body) throw new Error('master_canvas_stream_unavailable');
    // Snapshot-on-connect part 2 (see file header): a (re)connect always
    // triggers one immediate re-read for every subscribed module.
    notifyAll();
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
          let sawData = false;
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('id:')) cursor = line.slice(3).trim();
            if (line.startsWith('data:')) sawData = true;
          }
          if (sawData) scheduleNotify();
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async function run(): Promise<void> {
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
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
      await new Promise<void>((resolve) => {
        reconnectTimer = setTimeoutImpl(() => { reconnectTimer = undefined; resolve(); }, reconnectDelay);
      });
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }
  }

  function start() {
    if (running) return; // idempotent — a second subscribe() must add zero connections
    running = true;
    cancelled = false;
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
    cursor = undefined; // a fresh connection later starts replay from the server's own bounded window, not a stale cursor from a torn-down session
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      // Snapshot-on-connect part 1: a freshly-subscribed module gets an
      // immediate re-read signal even before any (re)connect happens.
      scheduleNotify();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getOpenAttemptCount() { return openAttemptCount; },
    getSubscriberCount() { return listeners.size; },
  };
}
