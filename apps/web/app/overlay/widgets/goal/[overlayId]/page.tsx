'use client';

/*
 * OBS browser-source widget for L16 support goals. Standalone route,
 * loaded directly by OBS as a browser source URL — never embedded inside
 * the main overlay page, never requires interaction, and degrades
 * gracefully to an empty (transparent) state with no goal data.
 *
 * AUTH: identical model to the main overlay
 * (apps/web/app/overlay/[overlayId]/page.tsx) and to the existing Lottie
 * overlay asset fetch inside it — the overlay session's bearer token
 * travels only in the URL hash fragment (#token=...), which the browser
 * never sends to a server and which never appears in a request path/query
 * or in server logs, then goes as an Authorization header to the API. No
 * new auth path is invented: this reuses the same overlay_sessions table
 * and token-fingerprint scheme apps/api/src/routes/overlay-lottie.ts
 * already established for widget-style overlay reads (see
 * apps/api/src/routes/goals.ts's /v1/overlay-goals/:overlayId and
 * packages/db/migrations/0102's list_overlay_goal, which mirrors
 * list_overlay_lottie_assets exactly).
 *
 * This is a poll-based snapshot read, not a second SSE stream — the main
 * overlay's session/cursor/replay machinery (routes/overlay.ts) is left
 * completely untouched, matching the ownership boundary for this task.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../../lib/api-origin';
import { formatRupees, isOverlayGoal, progressPercent, type OverlayGoal } from '../goal-widget-logic';

const POLL_MS = 5_000;

export default function GoalWidgetPage() {
  const params = useParams<{ overlayId: string }>();
  const [goal, setGoal] = useState<OverlayGoal | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const pollTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.documentElement.classList.add('browser-overlay-document');
    document.body.classList.add('browser-overlay-document');
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (!params.overlayId || !token) {
      setUnavailable(true);
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
      setUnavailable(true);
      return () => {
        document.documentElement.classList.remove('browser-overlay-document');
        document.body.classList.remove('browser-overlay-document');
      };
    }

    const poll = async () => {
      try {
        const response = await fetch(`${apiOrigin}/v1/overlay-goals/${encodeURIComponent(params.overlayId)}`, {
          headers: { authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (cancelled) return;
        if (!response.ok) {
          // A single failed poll never blanks a widget that already has
          // data — it just waits for the next tick. Only a truly
          // unrecoverable auth failure clears to the empty state.
          if (response.status === 401) { setUnavailable(true); setGoal(null); }
          return;
        }
        const body = await response.json() as { goal: unknown };
        if (cancelled) return;
        setUnavailable(false);
        setGoal(isOverlayGoal(body.goal) ? body.goal : null);
      } catch {
        // Network hiccup — keep the last known good render, try again next tick.
      }
    };

    void poll();
    pollTimer.current = window.setInterval(() => void poll(), POLL_MS);

    return () => {
      cancelled = true;
      if (pollTimer.current) window.clearInterval(pollTimer.current);
      document.documentElement.classList.remove('browser-overlay-document');
      document.body.classList.remove('browser-overlay-document');
    };
  }, [params.overlayId]);

  return (
    <div className="goal-widget-root">
      <style>{`
        .goal-widget-root { background: transparent; padding: 12px; font-family: system-ui, sans-serif; }
        .goal-widget-card { max-width: 420px; padding: 14px 18px; border-radius: 12px; background: rgba(15, 15, 20, 0.72); color: #fff; }
        .goal-widget-title { font-size: 16px; font-weight: 700; margin: 0 0 6px; }
        .goal-widget-track { height: 14px; border-radius: 999px; background: rgba(255,255,255,0.18); overflow: hidden; }
        .goal-widget-fill { height: 100%; background: linear-gradient(90deg, #7c5cff, #ff5ca8); transition: width 400ms ease; }
        .goal-widget-fill.reached { background: linear-gradient(90deg, #22c55e, #16a34a); }
        .goal-widget-amounts { margin: 6px 0 0; font-size: 13px; opacity: 0.9; }
      `}</style>
      {!unavailable && goal && (
        <div className="goal-widget-card" role="status" aria-live="polite">
          <p className="goal-widget-title">{goal.title}</p>
          <div className="goal-widget-track">
            <div
              className={goal.reached ? 'goal-widget-fill reached' : 'goal-widget-fill'}
              style={{ width: `${progressPercent(goal)}%` }}
            />
          </div>
          <p className="goal-widget-amounts">{formatRupees(goal.progressPaise)} / {formatRupees(goal.targetAmountPaise)}{goal.reached ? ' — Goal reached!' : ''}</p>
        </div>
      )}
      {/* No goal, or the session is unavailable: render nothing visible — a
          transparent OBS browser source with no content, never an error
          banner or a broken layout on stream. */}
    </div>
  );
}
