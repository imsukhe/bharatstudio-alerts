'use client';

/*
 * OBS browser-source widget for L16 support votes. Standalone route, same
 * shape as ../../goal/[overlayId]/page.tsx: bearer token travels only in
 * the URL hash fragment (#token=...), poll-based (not a second SSE
 * stream), degrades to a transparent empty state on any failure — never
 * throws, never shows an error banner on stream. Reuses the same
 * overlay_sessions/token-fingerprint auth as the goal widget and every
 * other overlay read in packages/db/migrations/0105 — no new auth path.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../../../lib/api-origin';
import { isOverlayVoteTally, optionPercent, totalVotes, type OverlayVoteTally } from '../../vote-widget-logic';

const POLL_MS = 5_000;

export default function VoteWidgetPage() {
  const params = useParams<{ overlayId: string; definitionId: string }>();
  const [tally, setTally] = useState<OverlayVoteTally | null>(null);
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
        const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(params.overlayId)}/votes/${encodeURIComponent(params.definitionId)}`, {
          headers: { authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (cancelled) return;
        if (!response.ok) {
          if (response.status === 401) { setUnavailable(true); setTally(null); }
          return;
        }
        const body = await response.json() as { tally: unknown };
        if (cancelled) return;
        setUnavailable(false);
        setTally(isOverlayVoteTally(body.tally) ? body.tally : null);
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
    <div className="vote-widget-root">
      <style>{`
        .vote-widget-root { background: transparent; padding: 12px; font-family: system-ui, sans-serif; }
        .vote-widget-card { max-width: 420px; padding: 14px 18px; border-radius: 12px; background: rgba(15, 15, 20, 0.72); color: #fff; }
        .vote-widget-option { margin: 8px 0; }
        .vote-widget-track { height: 10px; border-radius: 999px; background: rgba(255,255,255,0.18); overflow: hidden; }
        .vote-widget-fill { height: 100%; background: linear-gradient(90deg, #7c5cff, #ff5ca8); transition: width 400ms ease; }
        .vote-widget-fill.winner { background: linear-gradient(90deg, #22c55e, #16a34a); }
      `}</style>
      {!unavailable && tally && tally.options.length > 0 && (
        <div className="vote-widget-card" role="status" aria-live="polite">
          {tally.options.map((option) => (
            <div key={option.optionKey} className="vote-widget-option">
              <p>{option.label} — {option.voteCount} vote{option.voteCount === 1 ? '' : 's'}</p>
              <div className="vote-widget-track">
                <div
                  className={tally.resolved && option.optionKey === tally.resolvedOptionKey ? 'vote-widget-fill winner' : 'vote-widget-fill'}
                  style={{ width: `${optionPercent(option, tally)}%` }}
                />
              </div>
            </div>
          ))}
          {tally.resolved && totalVotes(tally) > 0 && <p>Resolved{tally.resolvedOptionKey ? ` — ${tally.options.find((o) => o.optionKey === tally.resolvedOptionKey)?.label ?? ''}` : ''}</p>}
        </div>
      )}
      {/* No tally, or the session is unavailable: render nothing visible — a
          transparent OBS browser source with no content, never an error
          banner or a broken layout on stream. */}
    </div>
  );
}
