'use client';

/*
 * PRF-02: the Master Canvas host page — the new OBS browser-source URL
 * (`/overlay/canvas/{overlayId}#token=...`) a creator points OBS at
 * instead of the individual widget sources. This slice mounts exactly
 * two modules (Supporter Ticker, Community Goal Ladder) on ONE shared
 * connection and ONE shared scheduler — see master-canvas-connection.ts
 * and master-canvas-runtime.ts for where those properties actually live.
 * This file only wires DOM containers and the two existing REST snapshot
 * endpoints (`/v1/overlay-widgets/:overlayId/supporter-ticker`,
 * `/v1/overlay-goals/:overlayId` — both untouched by this task) to them.
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
 */

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getApiOrigin } from '../../../lib/api-origin';
import { createMasterCanvasConnection } from '../master-canvas-connection';
import { createDocumentVisibilitySource, createMasterCanvasRuntime } from '../master-canvas-runtime';
import { createSupporterTickerModule, type SupporterTickerEntry } from '../modules/supporter-ticker-module';
import { createGoalLadderModule } from '../modules/goal-ladder-module';
import { isSupporterTicker } from '../../widgets/l16-widget-data';
import { isOverlayGoal, type OverlayGoal } from '../../widgets/goal/goal-widget-logic';

const BUILT_MODULE_KEYS = ['supporter_ticker', 'community_goal_ladder'] as const;

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
        .master-canvas-note { position: absolute; top: 0; right: 0; padding: 8px 12px; background: rgba(120,20,20,.7); color: #fff; font-size: 12px; }
      `}</style>
      <div ref={goalContainerRef} className="master-canvas-module master-canvas-goal" />
      <div ref={tickerContainerRef} className="master-canvas-module master-canvas-ticker" aria-live="polite" />
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
