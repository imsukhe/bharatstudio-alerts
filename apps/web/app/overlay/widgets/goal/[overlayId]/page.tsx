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
 * TRANSPORT: this snapshot read is now driven by the shared
 * `useOverlayTransport` hook (../shared/overlay-transport.ts), which
 * connects the SAME SSE stream the main overlay uses
 * (apps/api/src/routes/overlay.ts, unmodified) instead of a bare
 * `setInterval` poll. This endpoint's own request/response shape is
 * untouched — see that file's header comment for the snapshot-on-connect
 * and fallback-poll design.
 */
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../../lib/api-origin';
import { formatRupees, isOverlayGoal, progressPercent, type OverlayGoal } from '../goal-widget-logic';
import { useOverlayTransport, type SnapshotOutcome } from '../../shared/overlay-transport';

const POLL_MS = 5_000;

async function fetchGoalSnapshot(apiOrigin: string, token: string, overlayId: string): Promise<SnapshotOutcome<OverlayGoal>> {
  try {
    const response = await fetch(`${apiOrigin}/v1/overlay-goals/${encodeURIComponent(overlayId)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!response.ok) return response.status === 401 ? { status: 'unauthorized' } : { status: 'error' };
    const body = await response.json() as { goal: unknown };
    return { status: 'ok', value: isOverlayGoal(body.goal) ? body.goal : null };
  } catch {
    // Network hiccup — keep the last known good render, try again later.
    return { status: 'error' };
  }
}

export default function GoalWidgetPage() {
  const params = useParams<{ overlayId: string }>();
  const { value: goal, unavailable } = useOverlayTransport<OverlayGoal>({
    overlayId: params.overlayId,
    fetchSnapshot: fetchGoalSnapshot,
    getApiOrigin,
    fallbackPollMs: POLL_MS,
  });

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
