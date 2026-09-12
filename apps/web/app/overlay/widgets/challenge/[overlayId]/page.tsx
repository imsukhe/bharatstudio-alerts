'use client';

/*
 * OBS browser-source widget for L17 paid challenges. Standalone route,
 * loaded directly by OBS as a browser source URL — never embedded inside
 * the main overlay page, never requires interaction, and degrades
 * gracefully to an empty (transparent) state with no data. Mirrors
 * ../../goal/[overlayId]/page.tsx exactly.
 *
 * AUTH: identical model to the goal widget and the main overlay
 * (apps/web/app/overlay/[overlayId]/page.tsx) — the overlay session's
 * bearer token travels only in the URL hash fragment (#token=...), which
 * the browser never sends to a server and which never appears in a
 * request path/query or in server logs, then goes as an Authorization
 * header to the API. No new auth path is invented: this reuses the same
 * overlay_sessions table and token-fingerprint scheme
 * apps/api/src/routes/overlay-lottie.ts established, via
 * apps/api/src/routes/challenges.ts's /v1/overlay-challenges/:overlayId
 * and packages/db/migrations/0109's list_overlay_challenge, which mirrors
 * list_overlay_goal exactly.
 *
 * HONEST FAILURE COPY: a failed or cancelled challenge renders
 * CHALLENGE_FAILURE_COPY on stream, in the same place a contributor would
 * be looking for the outcome — see challenge-widget-logic.ts's comment
 * for why the string lives there rather than being imported from the API
 * package (the widget only ever sees the JSON the API sends).
 *
 * This is a poll-based snapshot read, not a second SSE stream — the main
 * overlay's session/cursor/replay machinery (routes/overlay.ts) is left
 * completely untouched, matching this task's ownership boundary.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../../lib/api-origin';
import {
  CHALLENGE_FAILURE_COPY,
  formatRupees,
  isOverlayChallenge,
  isWidgetVisible,
  progressPercent,
  type OverlayChallenge,
} from '../challenge-widget-logic';

const POLL_MS = 5_000;

const STATE_LABELS: Record<OverlayChallenge['state'], string> = {
  draft: '',
  active: 'In progress',
  succeeded: 'Succeeded!',
  failed: 'Did not happen',
  cancelled: 'Cancelled',
};

export default function ChallengeWidgetPage() {
  const params = useParams<{ overlayId: string }>();
  const [challenge, setChallenge] = useState<OverlayChallenge | null>(null);
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
        const response = await fetch(`${apiOrigin}/v1/overlay-challenges/${encodeURIComponent(params.overlayId)}`, {
          headers: { authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (cancelled) return;
        if (!response.ok) {
          // A single failed poll never blanks a widget that already has
          // data — it just waits for the next tick. Only a truly
          // unrecoverable auth failure clears to the empty state.
          if (response.status === 401) { setUnavailable(true); setChallenge(null); }
          return;
        }
        const body = await response.json() as { challenge: unknown };
        if (cancelled) return;
        setUnavailable(false);
        setChallenge(isOverlayChallenge(body.challenge) ? body.challenge : null);
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

  const visible = !unavailable && challenge && isWidgetVisible(challenge);
  const resolved = visible && challenge && (challenge.state === 'failed' || challenge.state === 'cancelled');
  const succeeded = visible && challenge && challenge.state === 'succeeded';

  return (
    <div className="challenge-widget-root">
      <style>{`
        .challenge-widget-root { background: transparent; padding: 12px; font-family: system-ui, sans-serif; }
        .challenge-widget-card { max-width: 440px; padding: 14px 18px; border-radius: 12px; background: rgba(15, 15, 20, 0.72); color: #fff; }
        .challenge-widget-title { font-size: 16px; font-weight: 700; margin: 0 0 4px; }
        .challenge-widget-state { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; margin: 0 0 6px; }
        .challenge-widget-track { height: 14px; border-radius: 999px; background: rgba(255,255,255,0.18); overflow: hidden; }
        .challenge-widget-fill { height: 100%; background: linear-gradient(90deg, #7c5cff, #ff5ca8); transition: width 400ms ease; }
        .challenge-widget-fill.succeeded { background: linear-gradient(90deg, #22c55e, #16a34a); }
        .challenge-widget-fill.resolved { background: rgba(255,255,255,0.35); }
        .challenge-widget-amounts { margin: 6px 0 0; font-size: 13px; opacity: 0.9; }
        .challenge-widget-copy { margin: 8px 0 0; font-size: 11px; line-height: 1.4; opacity: 0.85; }
      `}</style>
      {visible && challenge && (
        <div className="challenge-widget-card" role="status" aria-live="polite">
          <p className="challenge-widget-title">{challenge.title}</p>
          <p className="challenge-widget-state">{STATE_LABELS[challenge.state]}</p>
          <div className="challenge-widget-track">
            <div
              className={succeeded ? 'challenge-widget-fill succeeded' : resolved ? 'challenge-widget-fill resolved' : 'challenge-widget-fill'}
              style={{ width: `${progressPercent(challenge)}%` }}
            />
          </div>
          <p className="challenge-widget-amounts">{formatRupees(challenge.progressPaise)} / {formatRupees(challenge.targetAmountPaise)}</p>
          {resolved && <p className="challenge-widget-copy">{CHALLENGE_FAILURE_COPY}</p>}
        </div>
      )}
      {/* No challenge, a draft challenge, or the session is unavailable:
          render nothing visible — a transparent OBS browser source with
          no content, never an error banner or a broken layout on stream. */}
    </div>
  );
}
