'use client';

/*
 * OBS browser-source widget for the L16 leaderboard. Same auth/poll shape
 * as every other widget in this migration. Channel-scoped purely by the
 * overlay session (see list_overlay_leaderboard, 0105) — there is no
 * channel id anywhere in this page's own code, so it cannot be pointed at
 * another creator's board even by a modified URL. Renders rank + tier
 * only; the OverlayLeaderboardRow type has no amount field to render.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../../lib/api-origin';
import { isOverlayLeaderboard, type OverlayLeaderboard } from '../leaderboard-widget-logic';

const POLL_MS = 15_000;

export default function LeaderboardWidgetPage() {
  const params = useParams<{ overlayId: string }>();
  const [board, setBoard] = useState<OverlayLeaderboard | null>(null);
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
    if (!params.overlayId || !token) {
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
        const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(params.overlayId)}/leaderboard?window=weekly`, {
          headers: { authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (cancelled) return;
        if (!response.ok) {
          if (response.status === 401) { setUnavailable(true); setBoard(null); }
          return;
        }
        const body = await response.json() as { leaderboard: unknown };
        if (cancelled) return;
        setUnavailable(false);
        setBoard(isOverlayLeaderboard(body.leaderboard) ? body.leaderboard : null);
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
  }, [params.overlayId]);

  return (
    <div className="leaderboard-widget-root">
      <style>{`
        .leaderboard-widget-root { background: transparent; padding: 12px; font-family: system-ui, sans-serif; }
        .leaderboard-widget-card { max-width: 320px; padding: 14px 18px; border-radius: 12px; background: rgba(15, 15, 20, 0.72); color: #fff; }
        .leaderboard-widget-row { display: flex; justify-content: space-between; padding: 4px 0; }
      `}</style>
      {!unavailable && board && board.rows.length > 0 && (
        <div className="leaderboard-widget-card" role="status" aria-live="polite">
          {board.rows.slice(0, 10).map((row) => (
            <div key={row.viewerRef} className="leaderboard-widget-row">
              <span>#{row.rank}</span>
              <span>{row.tierLabel}</span>
            </div>
          ))}
        </div>
      )}
      {/* No rows, or the session is unavailable: render nothing visible. */}
    </div>
  );
}
