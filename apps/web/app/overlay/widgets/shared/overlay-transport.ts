'use client';

/*
 * Shared transport for every overlay widget (goal, leaderboard, challenge,
 * vote, hype, recent-tips, top-supporters, supporter-ticker,
 * mega-tip-banner). Replaces each widget's own 5s/15s `setInterval` poll
 * with the SAME persistent event stream the main overlay already uses
 * (apps/api/src/routes/overlay.ts's `/v1/overlays/:overlayId/events`,
 * apps/web/app/overlay/[overlayId]/page.tsx) — one long-lived connection
 * per widget instance instead of a new HTTP request every few seconds.
 *
 * AUTH: unchanged. The overlay session bearer token (URL hash fragment,
 * never a query param — see goal/[overlayId]/page.tsx's file comment) is
 * the same token every widget already sends to its own snapshot endpoint
 * (fingerprinted against `overlay_sessions` — see
 * apps/api/src/db/goal-overlay-store.ts's file comment). It authenticates
 * the shared events stream too: both live behind the identical
 * overlay_sessions/token_fingerprint check, so no second auth model is
 * introduced and none is weakened.
 *
 * SNAPSHOT ON CONNECT (the crux): SSE replay only resends events recorded
 * after a `Last-Event-Id` cursor. A widget that trusted replay alone could
 * reconnect after a gap — or connect for the very first time, with no
 * cursor at all — and correctly receive zero events, which is
 * indistinguishable from "value is actually zero". That would show a
 * goal/hype/vote bar silently reset on a connection hiccup, which is
 * explicitly worse than a delay.
 *
 * So this hook never treats the SSE stream as a source of state. It is
 * only ever a low-latency "something may have changed, go re-read" signal.
 * The widget's own existing REST snapshot endpoint (e.g.
 * /v1/overlay-goals/:overlayId, untouched by this change) remains the only
 * source of displayed values, and it is read:
 *   1. immediately on mount, before the stream has even connected;
 *   2. immediately whenever the stream (re)connects, including the very
 *      first connection and every reconnect after a drop — this is what
 *      closes the "replay resent nothing" gap: a reconnect always forces
 *      one full snapshot read, never relies on the resent events alone;
 *   3. whenever any event frame arrives on the stream (debounced a few
 *      hundred ms so a burst of alerts collapses into one re-read).
 * A dropped connection therefore never blanks a widget — it keeps
 * rendering the last snapshot it read, exactly like the old poll did,
 * while the stream reconnects underneath it.
 *
 * FALLBACK: while the stream is not connected (has not connected yet, or
 * just dropped), a slower interval keeps calling the same snapshot read
 * directly, so the widget still updates — just at fallback cadence —
 * even if SSE never becomes available at all (proxy strips it, browser
 * lacks streaming fetch, etc). The fallback stops the instant the stream
 * connects and resumes the instant it drops.
 *
 * DEGRADATION: every failure mode (missing token, unresolved API origin,
 * network error, malformed frame, 401) is caught locally and turns into
 * "keep last good render" or "clear to empty", never a thrown error — see
 * each call site below.
 */
import { useEffect, useRef, useState } from 'react';

export type SnapshotOutcome<T> =
  | { status: 'ok'; value: T | null }
  | { status: 'unauthorized' }
  | { status: 'error' };

export interface OverlayTransportConfig<T> {
  /** Route param; undefined while Next.js hasn't resolved params yet. */
  overlayId: string | undefined;
  /** The widget's existing snapshot reader (its current REST endpoint). Never needs to be stable — the hook always calls the latest one. */
  fetchSnapshot: (apiOrigin: string, token: string, overlayId: string) => Promise<SnapshotOutcome<T>>;
  /** The widget's existing `getApiOrigin` import. */
  getApiOrigin: () => string;
  /** Cadence for the disconnected-stream fallback poll; typically the widget's old POLL_MS. */
  fallbackPollMs: number;
}

export interface OverlayTransportState<T> {
  value: T | null;
  unavailable: boolean;
}

const REFETCH_DEBOUNCE_MS = 200;
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 4_000;

export function useOverlayTransport<T>(config: OverlayTransportConfig<T>): OverlayTransportState<T> {
  const { overlayId, fallbackPollMs } = config;
  const [value, setValue] = useState<T | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  // Refs, not deps: a widget may pass a fresh `fetchSnapshot`/`getApiOrigin`
  // closure on every render (e.g. one capturing a route's definitionId).
  // The connection lifecycle below must not restart just because a render
  // happened — only when the overlay session itself changes. Every call
  // site reads `.current` at call time, so it always uses the latest
  // closure regardless.
  const fetchSnapshotRef = useRef(config.fetchSnapshot);
  fetchSnapshotRef.current = config.fetchSnapshot;
  const getApiOriginRef = useRef(config.getApiOrigin);
  getApiOriginRef.current = config.getApiOrigin;

  useEffect(() => {
    document.documentElement.classList.add('browser-overlay-document');
    document.body.classList.add('browser-overlay-document');
    const removeDocumentClasses = () => {
      document.documentElement.classList.remove('browser-overlay-document');
      document.body.classList.remove('browser-overlay-document');
    };

    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (!overlayId || !token) {
      setUnavailable(true);
      return removeDocumentClasses;
    }

    let apiOrigin: string;
    try {
      apiOrigin = getApiOriginRef.current();
    } catch {
      setUnavailable(true);
      return removeDocumentClasses;
    }

    let cancelled = false;
    let fallbackTimer: number | undefined;
    let debounceTimer: number | undefined;
    let streamAbort: AbortController | undefined;
    let cursor: string | undefined;

    const applySnapshot = async () => {
      try {
        const outcome = await fetchSnapshotRef.current(apiOrigin, token, overlayId);
        if (cancelled) return;
        if (outcome.status === 'unauthorized') {
          setUnavailable(true);
          setValue(null);
          return;
        }
        if (outcome.status === 'error') return; // keep last known good render, try again later
        setUnavailable(false);
        setValue(outcome.value);
      } catch {
        // fetchSnapshot is expected to catch its own errors; this is
        // belt-and-braces so a defect there degrades like a network
        // failure would, never as a thrown error into a live stream.
      }
    };

    const scheduleSnapshot = () => {
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = undefined;
        void applySnapshot();
      }, REFETCH_DEBOUNCE_MS);
    };

    const startFallbackPolling = () => {
      if (fallbackTimer !== undefined) return;
      fallbackTimer = window.setInterval(() => void applySnapshot(), fallbackPollMs);
    };
    const stopFallbackPolling = () => {
      if (fallbackTimer === undefined) return;
      window.clearInterval(fallbackTimer);
      fallbackTimer = undefined;
    };

    // Snapshot on connect, part 1: read current state immediately, before
    // the stream has even had a chance to open.
    void applySnapshot();
    // And until the stream connects, keep the widget alive via the
    // fallback cadence — covers "SSE never connects at all" too.
    startFallbackPolling();

    const streamOnce = async (): Promise<void> => {
      const abort = new AbortController();
      streamAbort = abort;
      const response = await fetch(`${apiOrigin}/v1/overlays/${encodeURIComponent(overlayId)}/events`, {
        headers: { authorization: `Bearer ${token}`, ...(cursor ? { 'last-event-id': cursor } : {}) },
        cache: 'no-store',
        signal: abort.signal,
      });
      if (!response.ok || !response.body) throw new Error('overlay_stream_unavailable');
      // Snapshot on connect, part 2: a (re)connect always forces one full
      // re-read. This is what keeps a reconnect from ever showing only
      // "events since cursor" as if that were the whole state — the
      // reconnect itself is a signal, independent of whatever replay sends.
      stopFallbackPolling();
      void applySnapshot();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
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
            // Comment/keep-alive lines (": replay-start", ": replay-complete",
            // ": replay-unavailable") carry no `data:` line and never
            // trigger a refetch. A frame that does carry one — whatever its
            // eventType, and even if its payload were malformed — is only
            // ever used as a signal here; the follow-up REST read is what
            // actually validates and supplies the rendered value, so a
            // garbled SSE frame can never itself corrupt widget state.
            if (sawData) scheduleSnapshot();
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    };

    const run = async () => {
      let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      while (!cancelled) {
        try {
          await streamOnce();
          reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        } catch {
          // Falls through to the fallback poll + backoff below — a broken
          // or unavailable stream never surfaces as a thrown error.
        }
        if (cancelled) break;
        startFallbackPolling();
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, reconnectDelay);
        });
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    };
    void run();

    return () => {
      cancelled = true;
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      stopFallbackPolling();
      streamAbort?.abort();
      removeDocumentClasses();
    };
  }, [overlayId, fallbackPollMs]);

  return { value, unavailable };
}
