'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
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
  ttsPlaybackPlan,
  truncateMessage,
  type OverlayConfig,
  type OverlayItem,
} from '../overlay-policy';
import { playAudioWithTimeout } from '../tts-runtime';
import { getApiOrigin } from '../../lib/api-origin';

function textValue(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function amountValue(item: OverlayItem): string {
  const amount = amountPaise(item);
  return amount > 0 ? `₹${(amount / 100).toLocaleString('en-IN')}` : '';
}

function styleFor(item: OverlayItem, config: OverlayConfig): string {
  return bracketFor(item, config).displayStyle;
}

function playChime(): void {
  const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;
  const context = new AudioContextCtor();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(660, context.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(880, context.currentTime + 0.12);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.24);
  oscillator.addEventListener('ended', () => { void context.close(); }, { once: true });
}

function safeAudioUrl(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/v1/overlay-audio/')) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export default function BrowserOverlayPage() {
  const params = useParams<{ overlayId: string }>();
  const [currentGroup, setCurrentGroup] = useState<OverlayItem[]>([]);
  const [connected, setConnected] = useState(false);
  const queue = useRef<OverlayItem[]>([]);
  const active = useRef(false);
  const pending = useRef(new Set<string>());
  const arrivalSequence = useRef(0);

  useEffect(() => {
    document.documentElement.classList.add('browser-overlay-document');
    document.body.classList.add('browser-overlay-document');
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (!params.overlayId || !token) {
      return () => {
        document.documentElement.classList.remove('browser-overlay-document');
        document.body.classList.remove('browser-overlay-document');
      };
    }

    let cancelled = false;
    let apiOrigin: string;
    try {
      apiOrigin = getApiOrigin();
    } catch {
      setConnected(false);
      return () => {
        document.documentElement.classList.remove('browser-overlay-document');
        document.body.classList.remove('browser-overlay-document');
      };
    }
    let reconnectDelay = 250;
    let acknowledgedCursor = '';
    let activeStreamAbort: AbortController | undefined;
    let displayTimer: number | undefined;

    const acknowledge = async (item: OverlayItem): Promise<boolean> => {
      let retryDelay = 500;
      while (!cancelled) {
        try {
          const response = await fetch(`${apiOrigin}/v1/overlays/${encodeURIComponent(params.overlayId)}/cursor`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ cursor: item.cursor, eventId: item.eventId }),
            keepalive: true,
          });
          if (response.ok) {
            acknowledgedCursor = item.cursor;
            return true;
          }
          if (response.status === 400 || response.status === 401) return false;
        } catch {
          // A display acknowledgement is retryable. The item remains durable
          // and visible until the server confirms it.
        }
        await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 5_000);
      }
      return false;
    };

    const finishDisplay = async (group: OverlayItem[]) => {
      // A priority group is rendered by priority, but acknowledgement remains
      // in delivery arrival order so Last-Event-ID never skips an earlier row.
      const acknowledgementOrder = [...group].sort((a, b) => (a.arrivalOrder ?? 0) - (b.arrivalOrder ?? 0));
      for (const [index, item] of acknowledgementOrder.entries()) {
        const acknowledged = await acknowledge(item);
        if (!acknowledged || cancelled) {
          if (cancelled) return;

          // The selected group was removed from the in-memory queue before it
          // was displayed. Requeue the unacknowledged suffix and reconnect so
          // the server can replay from the last cursor it accepted. Keeping
          // these cursors pending prevents the reconnecting stream from adding
          // a second copy; pump() resumes them after the new stream connects.
          queue.current = requeueUnacknowledged(acknowledgementOrder, index, queue.current);
          setCurrentGroup([]);
          active.current = false;
          activeStreamAbort?.abort();
          return;
        }
        pending.current.delete(item.cursor);
      }
      if (cancelled) return;
      setCurrentGroup([]);
      active.current = false;
      pump();
    };

    const pump = () => {
      if (active.current || queue.current.length === 0) return;
      const first = queue.current[0]!;
      const config = configForItem(first);
      const selected = selectPresentationGroup(queue.current, config);
      queue.current = selected.rest;
      active.current = true;
      setCurrentGroup(selected.group);
      displayTimer = window.setTimeout(() => {
        displayTimer = undefined;
        void finishDisplay(selected.group);
      }, displayDurationMs(selected.group, config));
    };

    const receive = (data: string, connectionSeen: Set<string>) => {
      try {
        const item = parseOverlayItem(JSON.parse(data));
        if (!item || item.eventType === 'resync.required') return;
        if (connectionSeen.has(item.cursor) || pending.current.has(item.cursor)) return;
        connectionSeen.add(item.cursor);
        pending.current.add(item.cursor);
        item.arrivalOrder = arrivalSequence.current++;
        queue.current.push(item);
        pump();
      } catch {
        // Malformed presentation data is ignored; the durable delivery is
        // replayed after reconnect because it was never acknowledged.
      }
    };

    const streamOnce = async () => {
      const streamAbort = new AbortController();
      activeStreamAbort = streamAbort;
      try {
        const response = await fetch(`${apiOrigin}/v1/overlays/${encodeURIComponent(params.overlayId)}/events`, {
          headers: {
            authorization: `Bearer ${token}`,
            ...(acknowledgedCursor ? { 'last-event-id': acknowledgedCursor } : {}),
          },
          cache: 'no-store',
          signal: streamAbort.signal,
        });
        if (!response.ok || !response.body) throw new Error('overlay_stream_unavailable');
        setConnected(true);
        reconnectDelay = 250;
        // A failed acknowledgement may have requeued an item while the prior
        // stream was still open. Resume it only after the replacement stream
        // is connected, using the last acknowledged cursor as the boundary.
        pump();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const connectionSeen = new Set<string>();
        let buffer = '';
        while (!cancelled) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
            if (data) receive(data, connectionSeen);
          }
        }
        await reader.cancel();
      } finally {
        if (activeStreamAbort === streamAbort) activeStreamAbort = undefined;
      }
    };

    const run = async () => {
      while (!cancelled) {
        try {
          await streamOnce();
        } catch {
          if (cancelled) break;
        }
        setConnected(false);
        await new Promise((resolve) => window.setTimeout(resolve, reconnectDelay));
        reconnectDelay = Math.min(reconnectDelay * 2, 4_000);
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (displayTimer !== undefined) {
        window.clearTimeout(displayTimer);
        displayTimer = undefined;
      }
      activeStreamAbort?.abort();
      document.documentElement.classList.remove('browser-overlay-document');
      document.body.classList.remove('browser-overlay-document');
    };
  }, [params.overlayId]);

  const first = currentGroup[0];
  const config = useMemo(() => first ? configForItem(first) : normalizeOverlayConfig(undefined), [first]);
  const mode = config.queue.mode;
  const style = first ? styleFor(first, config) : config.defaultStyle;
  const overlayStyle = { '--overlay-offset-x': `${config.display.offsetX}px`, '--overlay-offset-y': `${config.display.offsetY}px`, '--overlay-scale': String(config.display.scale), '--overlay-width': `${config.display.widthPercent}%` } as React.CSSProperties;

  useEffect(() => {
    if (!first || currentGroup.length === 0) return;
    const plan = ttsPlaybackPlan(first, config);
    if (plan.mode === 'silent') return;
    let audio: HTMLAudioElement | undefined;
    let objectUrl: string | undefined;
    let cancelled = false;
    const play = async () => {
      const url = plan.mode === 'audio' && plan.audioUrl ? safeAudioUrl(plan.audioUrl) : undefined;
      if (url) {
        try {
          // Audio playback cannot attach Authorization headers through the
          // HTMLAudioElement constructor. Fetch the scoped artifact with the
          // overlay bearer token, then play a short-lived blob URL instead.
          const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
          if (!token) throw new Error('overlay token missing');
          const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
          if (!response.ok) throw new Error('overlay audio unavailable');
          objectUrl = URL.createObjectURL(await response.blob());
          audio = new Audio(objectUrl);
          if (await playAudioWithTimeout(audio)) return;
        } catch {
          // Provider/audio playback failures fall through to the non-blocking chime.
        }
      }
      if (!cancelled) playChime();
    };
    void play();
    return () => {
      cancelled = true;
      audio?.pause();
      audio = undefined;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
    };
  }, [currentGroup, first, config]);

  return (
    <main className={`browser-overlay anchor-${config.display.anchor}`} data-reduced-motion={config.reducedMotion ? 'true' : 'false'} style={overlayStyle} aria-live="polite">
      <div className={`browser-overlay-status ${connected ? 'is-connected' : ''}`} role="status" aria-live="polite" aria-label={connected ? 'Overlay connected' : 'Overlay reconnecting'} />
      {currentGroup.length > 0 && (
        <div className={`browser-alert-group mode-${mode}`} data-style={style}>
          {mode === 'aggregated' && currentGroup.length > 1 ? (
            <article className="browser-alert browser-alert-aggregate" data-style={style}>
              <div className="browser-alert-kicker">BharatStudio · supporters</div>
              <strong>{aggregateLabel(currentGroup)}</strong>
              {currentGroup.map((item) => <p key={item.cursor}>{textValue(item.payload, 'displayName') || 'Someone'}{amountValue(item) ? ` · ${amountValue(item)}` : ''}{textValue(item.payload, 'message') ? ` — ${truncateMessage(item.payload.message, bracketFor(item, config).charLimit)}` : ''}</p>)}
            </article>
          ) : currentGroup.map((item) => {
            const itemStyle = styleFor(item, config);
            const limit = bracketFor(item, config).charLimit;
            const name = textValue(item.payload, 'displayName') || 'Someone';
            const message = truncateMessage(item.payload.message, limit);
            return (
              <article className="browser-alert" data-style={itemStyle} key={item.cursor}>
                <div className="browser-alert-kicker">BharatStudio</div>
                <strong>{name}{amountValue(item) ? ` · ${amountValue(item)}` : ''}</strong>
                {message && <p>{message}</p>}
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
