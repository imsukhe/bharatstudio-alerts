'use client';

/*
 * OBS browser-source widget for the L16 leaderboard. Same auth shape as
 * every other widget in this migration. Channel-scoped purely by the
 * overlay session (see list_overlay_leaderboard, 0105) — there is no
 * channel id anywhere in this page's own code, so it cannot be pointed at
 * another creator's board even by a modified URL. Renders rank + tier
 * only; the OverlayLeaderboardRow type has no amount field to render.
 *
 * TRANSPORT: see ../shared/overlay-transport.ts — a persistent connection
 * to the existing overlay SSE stream (apps/api/src/routes/overlay.ts,
 * unmodified) replaces the old `setInterval` poll of this same snapshot
 * endpoint; a slower fallback poll of that endpoint keeps this widget
 * working if the stream is ever unavailable.
 */
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../../lib/api-origin';
import { isOverlayLeaderboard, type OverlayLeaderboard } from '../leaderboard-widget-logic';
import { useOverlayTransport, type SnapshotOutcome } from '../../shared/overlay-transport';

const POLL_MS = 15_000;

async function fetchLeaderboardSnapshot(apiOrigin: string, token: string, overlayId: string): Promise<SnapshotOutcome<OverlayLeaderboard>> {
  try {
    const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/leaderboard?window=weekly`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!response.ok) return response.status === 401 ? { status: 'unauthorized' } : { status: 'error' };
    const body = await response.json() as { leaderboard: unknown };
    return { status: 'ok', value: isOverlayLeaderboard(body.leaderboard) ? body.leaderboard : null };
  } catch {
    return { status: 'error' };
  }
}

export default function LeaderboardWidgetPage() {
  const params = useParams<{ overlayId: string }>();
  const { value: board, unavailable } = useOverlayTransport<OverlayLeaderboard>({
    overlayId: params.overlayId,
    fetchSnapshot: fetchLeaderboardSnapshot,
    getApiOrigin,
    fallbackPollMs: POLL_MS,
  });

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
