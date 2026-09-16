'use client';

/*
 * PRF-02: the Master Canvas host page — the new OBS browser-source URL
 * (`/overlay/canvas/{overlayId}#token=...`) a creator points OBS at
 * instead of the individual widget sources. Slice 1 mounted two modules
 * (Supporter Ticker, Community Goal Ladder); slice 2 adds two more
 * (Tug-of-War Vote, Boss Fight); slice 3 adds Support Theater — all FIVE
 * on the SAME ONE shared connection and ONE shared scheduler — see
 * master-canvas-connection.ts and master-canvas-runtime.ts for where
 * those properties actually live, and master-canvas-integration.test.ts
 * for the five-modules-still-one-connection/one-loop proof. This file
 * only wires DOM containers and
 * REST snapshot endpoints to them: the two slice-1 endpoints
 * (`/v1/overlay-widgets/:overlayId/supporter-ticker`,
 * `/v1/overlay-goals/:overlayId` — untouched), one new endpoint
 * (`/v1/overlay-widgets/:overlayId/tug-of-war-vote`), and Boss Fight
 * reusing the SAME goal endpoint/fetch function the goal ladder uses —
 * no second progress computation (this task's §1(c)).
 *
 * ENTITLEMENT (§30.3, this task's §3): which of the two built modules is
 * actually active for this overlay is read once from the new
 * `/v1/overlay-widgets/:overlayId/master-canvas/modules` endpoint. A
 * module the server does not return is never activated — the runtime
 * never subscribes it to the connection, never fetches its snapshot,
 * never renders it (PRF-02.10). The server, not this page, owns the cap.
 *
 * KILL SWITCH: this page is additive. Every existing standalone widget
 * route (apps/web/app/overlay/widgets/*) is untouched and fully
 * functional — a creator who wants out of the Canvas removes this source
 * from OBS and re-adds the individual widget sources, no data migration
 * needed (see active/tasks/PRF-02.md).
 *
 * WATERMARK (§30.6, out of scope for this task, but left possible per
 * this task's explicit instruction not to make it impossible): the
 * protected top layer belongs OUTSIDE the module registry entirely, as a
 * sibling element rendered after (so visually on top of) the module
 * containers below, with its own fixed z-index and no dependency on any
 * module's error-boundary state — it is not added here because §30.6 is
 * out of scope, but nothing in this page's structure blocks adding it.
 *
 * PRF-02 SLICE 3 — SUPPORT THEATER SHARES THIS CANVAS'S ONE SESSION,
 * CORRECTED 2026-09-16: an earlier version of this slice gave Support
 * Theater a SECOND, dedicated overlay session (`stOverlayId`/`stToken`
 * hash params) on the theory that acknowledgement being session-bound
 * (migration 0022's `ack_overlay_cursor`) meant any shared session would
 * race. That was a literal reading of an instruction whose actual intent
 * was narrower — see `reviews/2026-09-16-prf-02-slice-3-implementation.md`'s
 * "Correction" section for the full account, attributed there to the
 * coordinator, not this implementer's own revision. Inside ONE Canvas
 * there is exactly one acknowledging consumer (Support Theater); the
 * other four modules are stateless snapshot readers that never call
 * `/cursor`, so there is no session-sharing race *inside* a Canvas to
 * defend against. The real race the original scope review found is
 * between this Canvas and the SEPARATE standalone page
 * (`../../[overlayId]/page.tsx`) — which already has its own, different
 * session, because it is a different browser source with its own session
 * token by construction. So Support Theater now registers with the SAME
 * `overlayId`/`token`/`connection` every other module here uses — see
 * `master-canvas-connection.ts`'s own header for how that shared
 * connection was extended (an event-payload subscription and an
 * `acknowledge()` method alongside its existing signal-only design) to
 * make this safe without a second session. `BUILT_MODULE_KEYS` lists
 * `support_theater` FIRST, and it is registered/entitled first below, so
 * its event-payload subscription always attaches before any snapshot
 * module can start the shared stream without one — see the connection
 * file's own header for why that ordering matters for a correct replay
 * cursor and for keeping this the ordinary case, not the forced-resync
 * backstop case.
 *
 * A SAME-SESSION MISMATCH WITH THE STANDALONE PAGE IS NOT DETECTED HERE,
 * AND THAT IS STATED RATHER THAN LEFT IMPLICIT: this page's own
 * JavaScript has no way to observe what session a *different* OBS browser
 * source (the standalone page, in its own separate process) happens to be
 * configured with. Building a server-side signal for that would be an
 * L3 API/data change, outside this task's authority — recorded as a
 * referred item rather than guessed at with a client-side heuristic that
 * cannot actually see the other consumer.
 */

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../lib/api-origin';
import { createMasterCanvasConnection } from '../master-canvas-connection';
import { createDocumentVisibilitySource, createMasterCanvasRuntime } from '../master-canvas-runtime';
import { createSupporterTickerModule, type SupporterTickerEntry } from '../modules/supporter-ticker-module';
import { createGoalLadderModule } from '../modules/goal-ladder-module';
import { createTugOfWarVoteModule } from '../modules/tug-of-war-vote-module';
import { createBossFightModule } from '../modules/boss-fight-module';
import { createSupportTheaterModule } from '../modules/support-theater-module';
import { isTugOfWarVoteTally, type TugOfWarVoteTally } from '../modules/tug-of-war-vote-logic';
import { isSupporterTicker } from '../../widgets/l16-widget-data';
import { isOverlayGoal, type OverlayGoal } from '../../widgets/goal/goal-widget-logic';

// support_theater is listed FIRST deliberately — see this file's header,
// "BUILT_MODULE_KEYS lists support_theater FIRST" — so its event-payload
// subscription to the shared connection always attaches before any
// snapshot module can start the stream without one.
const BUILT_MODULE_KEYS = ['support_theater', 'supporter_ticker', 'community_goal_ladder', 'tug_of_war_vote', 'boss_fight'] as const;

function reducedMotionPreferred(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export default function MasterCanvasPage() {
  const params = useParams<{ overlayId: string }>();
  const tickerContainerRef = useRef<HTMLDivElement>(null);
  const goalContainerRef = useRef<HTMLDivElement>(null);
  const voteContainerRef = useRef<HTMLDivElement>(null);
  const bossFightContainerRef = useRef<HTMLDivElement>(null);
  const supportTheaterContainerRef = useRef<HTMLDivElement>(null);
  const [downModules, setDownModules] = useState<string[]>([]);

  useEffect(() => {
    document.documentElement.classList.add('browser-overlay-document');
    document.body.classList.add('browser-overlay-document');
    const removeDocumentClasses = () => {
      document.documentElement.classList.remove('browser-overlay-document');
      document.body.classList.remove('browser-overlay-document');
    };

    const overlayId = params.overlayId;
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (!overlayId || !token) return removeDocumentClasses;

    let apiOrigin: string;
    try {
      apiOrigin = getApiOrigin();
    } catch {
      return removeDocumentClasses;
    }

    let cancelled = false;
    const connection = createMasterCanvasConnection({ overlayId, token, apiOrigin });
    const runtime = createMasterCanvasRuntime({
      visibilitySource: createDocumentVisibilitySource(document),
      onModuleDown: (moduleKey) => {
        if (cancelled) return;
        setDownModules((previous) => (previous.includes(moduleKey) ? previous : [...previous, moduleKey]));
      },
    });

    async function fetchTickerSnapshot(): Promise<SupporterTickerEntry[] | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/supporter-ticker`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { entries?: unknown };
      return isSupporterTicker(body.entries) ? body.entries : null;
    }

    async function fetchGoalSnapshot(): Promise<OverlayGoal | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-goals/${encodeURIComponent(overlayId)}`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { goal?: unknown };
      return isOverlayGoal(body.goal) ? body.goal : null;
    }

    // Boss Fight (§6 #4) is explicitly "a visual skin over an ordinary
    // support goal — not a new mechanic" (this task's §1(c)): it reads
    // the SAME /v1/overlay-goals endpoint and the SAME OverlayGoal shape
    // as the Community Goal Ladder above — fetchGoalSnapshot is reused
    // verbatim, not duplicated, so there is structurally only one
    // progress computation in this file too.

    async function fetchTugOfWarVoteSnapshot(): Promise<TugOfWarVoteTally | null> {
      const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/tug-of-war-vote`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      if (!response.ok) return null;
      const body = await response.json() as { tally?: unknown };
      return isTugOfWarVoteTally(body.tally) ? body.tally : null;
    }

    // Support Theater registers FIRST — see this file's header — using the
    // SAME shared `connection`/`overlayId`/`token` as every other module,
    // never a second session.
    if (supportTheaterContainerRef.current) {
      runtime.registerModule(createSupportTheaterModule({
        container: supportTheaterContainerRef.current,
        connection,
        overlayId,
        token,
        apiOrigin,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (tickerContainerRef.current) {
      runtime.registerModule(createSupporterTickerModule({
        container: tickerContainerRef.current,
        connection,
        fetchSnapshot: fetchTickerSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (goalContainerRef.current) {
      runtime.registerModule(createGoalLadderModule({
        container: goalContainerRef.current,
        connection,
        fetchSnapshot: fetchGoalSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (voteContainerRef.current) {
      runtime.registerModule(createTugOfWarVoteModule({
        container: voteContainerRef.current,
        connection,
        fetchSnapshot: fetchTugOfWarVoteSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    if (bossFightContainerRef.current) {
      runtime.registerModule(createBossFightModule({
        container: bossFightContainerRef.current,
        connection,
        fetchSnapshot: fetchGoalSnapshot,
        reducedMotion: reducedMotionPreferred,
      }));
    }
    (async () => {
      try {
        const response = await fetch(`${apiOrigin}/v1/overlay-widgets/${encodeURIComponent(overlayId)}/master-canvas/modules`, {
          headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
        });
        if (!response.ok || cancelled) return;
        const body = await response.json() as { moduleKeys?: unknown };
        const active = new Set(Array.isArray(body.moduleKeys) ? body.moduleKeys : []);
        for (const key of BUILT_MODULE_KEYS) runtime.setModuleEntitled(key, active.has(key));
      } catch {
        // Entitlement read failed — both built modules stay un-entitled
        // (the runtime's own default), never activated. Never guess a
        // module is active when the server hasn't confirmed it.
      }
    })();

    runtime.start();

    return () => {
      cancelled = true;
      runtime.stop();
      removeDocumentClasses();
    };
  }, [params.overlayId]);

  return (
    <div className="master-canvas-root">
      <style>{`
        .master-canvas-root { position: relative; width: 100%; height: 100%; background: transparent; font-family: system-ui, sans-serif; }
        .master-canvas-module { padding: 12px; }
        .master-canvas-ticker { position: absolute; bottom: 0; left: 0; right: 0; display: flex; gap: 16px; background: rgba(12,17,29,.86); color: #fff; }
        .master-canvas-goal { position: absolute; top: 0; left: 0; max-width: 420px; color: #fff; }
        .master-canvas-goal [data-role="goal-ladder-title"] { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
        .master-canvas-goal [data-role="goal-ladder-track"] { border-radius: 999px; background: rgba(255,255,255,.18); }
        .master-canvas-goal [data-role="goal-ladder-fill"] { background: linear-gradient(90deg, #7c5cff, #ff5ca8); }
        .master-canvas-goal [data-role="goal-ladder-amounts"] { margin-top: 6px; font-size: 13px; opacity: .9; }
        .master-canvas-vote { position: absolute; top: 0; right: 0; max-width: 420px; color: #fff; text-align: right; }
        .master-canvas-vote [data-role="tug-of-war-track"] { border-radius: 999px; background: rgba(255,255,255,.18); margin: 6px 0; }
        .master-canvas-vote [data-role="tug-of-war-left-fill"] { background: linear-gradient(90deg, #ff5c5c, #ff9c5c); }
        .master-canvas-vote [data-role="tug-of-war-right-fill"] { background: linear-gradient(270deg, #5c8cff, #5cd6ff); }
        .master-canvas-vote [data-role="tug-of-war-left-label"],
        .master-canvas-vote [data-role="tug-of-war-right-label"] { font-size: 13px; font-weight: 600; }
        .master-canvas-vote [data-role="tug-of-war-status"] { margin-top: 4px; font-size: 12px; opacity: .9; }
        .master-canvas-boss { position: absolute; top: 120px; left: 0; max-width: 420px; color: #fff; }
        .master-canvas-boss [data-role="boss-fight-title"] { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
        .master-canvas-boss [data-role="boss-fight-track"] { border-radius: 999px; background: rgba(255,255,255,.18); }
        .master-canvas-boss [data-role="boss-fight-health"] { background: linear-gradient(90deg, #ff5c5c, #ffb85c); }
        .master-canvas-boss [data-role="boss-fight-amounts"] { margin-top: 6px; font-size: 13px; opacity: .9; }
        .master-canvas-note { position: absolute; top: 0; right: 0; padding: 8px 12px; background: rgba(120,20,20,.7); color: #fff; font-size: 12px; }
        .master-canvas-theater { position: absolute; bottom: 90px; left: 0; right: 0; display: flex; flex-direction: column; align-items: center; color: #fff; text-align: center; }
        .master-canvas-theater [data-role="support-theater-current"] { display: flex; flex-direction: column; align-items: center; gap: 4px; }
        .master-canvas-theater [data-role="support-theater-kicker"] { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .8; }
        .master-canvas-theater [data-role="support-theater-name"] { font-size: 20px; font-weight: 700; }
        .master-canvas-theater [data-role="support-theater-message"] { font-size: 14px; opacity: .92; max-width: 480px; }
        .master-canvas-theater [data-role="support-theater-aggregate-line"] { font-size: 13px; opacity: .92; margin: 0; }
        .master-canvas-theater [data-role="support-theater-next"] { margin-top: 8px; font-size: 12px; opacity: .75; }
      `}</style>
      <div ref={goalContainerRef} className="master-canvas-module master-canvas-goal" />
      <div ref={bossFightContainerRef} className="master-canvas-module master-canvas-boss" />
      <div ref={voteContainerRef} className="master-canvas-module master-canvas-vote" aria-live="polite" />
      <div ref={tickerContainerRef} className="master-canvas-module master-canvas-ticker" aria-live="polite" />
      <div ref={supportTheaterContainerRef} className="master-canvas-module master-canvas-theater" aria-live="polite" />
      {downModules.length > 0 && (
        <div className="master-canvas-note" role="status">
          {downModules.map((key) => (
            <p key={key} style={{ margin: 0 }}>{key.replace(/_/g, ' ')} is temporarily unavailable.</p>
          ))}
        </div>
      )}
    </div>
  );
}
