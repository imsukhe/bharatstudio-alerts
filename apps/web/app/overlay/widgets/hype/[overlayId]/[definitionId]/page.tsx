'use client';

/*
 * OBS browser-source widget for L16 hype mode. Same shape as the goal and
 * vote widgets: bearer token in the URL hash fragment, poll-based (not a
 * second SSE stream), never throws — a hidden card is the only "no active
 * hype mode" state. Reuses the same overlay_sessions auth as every other
 * widget in this migration.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../../../lib/api-origin';
import { formatRupees, hypeMeterPercent, isOverlayHypeMode, type OverlayHypeMode } from '../../hype-widget-logic';

const POLL_MS = 3_000;

export default function HypeWidgetPage() {
  const params = useParams<{ overlayId: string; definitionId: string }>();
  const [state, setState] = useState<OverlayHypeMode | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const pollTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.documentElement.classList.add('browser-overlay-document');
    document.body.classList.add('browser-overlay-document');
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    const cleanup = () => {
      document.documentElement.classList.remove('browser-overlay-document');
      document.body.classList.remove('browser-overlay-document');
    };
    if (!params.overlayId || !params.definitionId || !token) {
      setUnavailable(true);
      return cleanup;
    }

    let cancelled = false;
    let apiOrigin: string;
    try {
      apiOrigin = getApiOrigin();
    } catch {
      setUnavailable(true);
      return cleanup;
    }

    const poll = async () => {
      try {
        const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(params.overlayId)}/hype/${encodeURIComponent(params.definitionId)}`, {
          headers: { authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (cancelled) return;
        if (!response.ok) {
          if (response.status === 401) { setUnavailable(true); setState(null); }
          return;
        }
        const body = await response.json() as { hype: unknown };
        if (cancelled) return;
        setUnavailable(false);
        setState(isOverlayHypeMode(body.hype) ? body.hype : null);
      } catch {
        // Network hiccup — keep the last known good render, try again next tick.
      }
    };

    void poll();
    pollTimer.current = window.setInterval(() => void poll(), POLL_MS);

    return () => {
      cancelled = true;
      if (pollTimer.current) window.clearInterval(pollTimer.current);
      cleanup();
    };
  }, [params.overlayId, params.definitionId]);

  return (
    <div className="hype-widget-root">
      <style>{`
        .hype-widget-root { background: transparent; padding: 12px; font-family: system-ui, sans-serif; }
        .hype-widget-card { max-width: 420px; padding: 14px 18px; border-radius: 12px; background: rgba(15, 15, 20, 0.72); color: #fff; }
        .hype-widget-track { height: 18px; border-radius: 999px; background: rgba(255,255,255,0.18); overflow: hidden; }
        .hype-widget-fill { height: 100%; background: linear-gradient(90deg, #f97316, #ef4444); transition: width 400ms ease; }
        .hype-widget-fill.reached { background: linear-gradient(90deg, #facc15, #f97316); }
      `}</style>
      {!unavailable && state && !state.ended && (
        <div className="hype-widget-card" role="status" aria-live="polite">
          <p>Hype meter{state.reached ? ' — MAXED OUT!' : ''}</p>
          <div className="hype-widget-track">
            <div className={state.reached ? 'hype-widget-fill reached' : 'hype-widget-fill'} style={{ width: `${hypeMeterPercent(state)}%` }} />
          </div>
          <p>{formatRupees(state.meterPaise)} / {formatRupees(state.thresholdPaise)}</p>
        </div>
      )}
      {/* No activation, an ended one, or an unavailable session all render
          nothing visible — a transparent OBS browser source, never an
          error banner on stream. */}
    </div>
  );
}
