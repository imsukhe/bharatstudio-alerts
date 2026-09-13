'use client';

/*
 * OBS browser-source widget for L16 hype mode. Same shape as the goal and
 * vote widgets: bearer token in the URL hash fragment, never throws — a
 * hidden card is the only "no active hype mode" state. Reuses the same
 * overlay_sessions auth as every other widget in this migration.
 *
 * TRANSPORT: see ../../shared/overlay-transport.ts — a persistent
 * connection to the existing overlay SSE stream (routes/overlay.ts,
 * unmodified) replaces the old `setInterval` poll of this same snapshot
 * endpoint; a slower fallback poll of that endpoint keeps this widget
 * working if the stream is ever unavailable.
 */
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../../../lib/api-origin';
import { formatRupees, hypeMeterPercent, isOverlayHypeMode, type OverlayHypeMode } from '../../hype-widget-logic';
import { useOverlayTransport, type SnapshotOutcome } from '../../../shared/overlay-transport';

const POLL_MS = 3_000;

async function fetchHypeSnapshot(apiOrigin: string, token: string, overlayId: string, definitionId: string): Promise<SnapshotOutcome<OverlayHypeMode>> {
  try {
    const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/hype/${encodeURIComponent(definitionId)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!response.ok) return response.status === 401 ? { status: 'unauthorized' } : { status: 'error' };
    const body = await response.json() as { hype: unknown };
    return { status: 'ok', value: isOverlayHypeMode(body.hype) ? body.hype : null };
  } catch {
    return { status: 'error' };
  }
}

export default function HypeWidgetPage() {
  const params = useParams<{ overlayId: string; definitionId: string }>();
  const { value: state, unavailable } = useOverlayTransport<OverlayHypeMode>({
    overlayId: params.overlayId,
    fetchSnapshot: (apiOrigin, token, overlayId) => fetchHypeSnapshot(apiOrigin, token, overlayId, params.definitionId),
    getApiOrigin,
    fallbackPollMs: POLL_MS,
  });

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
