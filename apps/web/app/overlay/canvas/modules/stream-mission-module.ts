/*
 * Stream Mission Card module (§6 #9), PRF-02 slice 5 — the eighth built
 * canvas module, and the first since slice 1 whose data path had to be
 * built (migration 0135; the slice 5 scope review classified #9
 * NEEDS-SCHEMA because nothing named "mission" existed anywhere in the
 * schema or API).
 *
 * SESSION-BOUNDED, NOT CLOCK-BOUNDED — the owner's decision
 * (FULL-PRODUCT-DEFINITION.md §6, module table row 9, 2026-09-16), and the
 * single most important property of this file. §6's catalogue line says
 * "Creator-defined objective and timer"; the owner's decision on that same
 * row supersedes the word "timer". So:
 *
 *   - There is NO duration, countdown, deadline, expiry or end time
 *     anywhere in this module. `StreamMissionModuleOptions` has no field
 *     for one and `StreamMission` has no field for one — proven at COMPILE
 *     time by stream-mission-module.test.ts, not merely by inspection.
 *   - What the card shows is an ELAPSED reading, derived live on the
 *     shared frame loop from the server-sent `startedAt`. It counts UP. It
 *     never reaches an end and nothing expires on it.
 *   - The card's visibility is decided solely by whether the server still
 *     returns a mission. When the creator ends it (or the overlay session
 *     ends), the next re-read returns null and the card hides — no timer
 *     fires, because there is no timer.
 *
 * ONE SHARED CONNECTION, ONE SHARED LOOP (PRF-02.1, PRF-02.2). This module
 * receives the Canvas's existing `MasterCanvasConnection` and nothing else
 * network-shaped: its options carry no overlayId, no token and no
 * apiOrigin, so it structurally cannot open a second overlay session or a
 * second transport. It is a plain `connection.subscribe()` snapshot
 * consumer and never touches `subscribeToEvents()`/`acknowledge()` — that
 * path stays Support Theater's alone (slice 3's Correction).
 *
 * NO THIRD PARTY (§9.1.1, PRF-13). Every import below is first-party. No
 * URL, no script element, no iframe, no external stylesheet, no CDN.
 *
 * COMPOSITE-ONLY (PRF-03). `render()` writes only `opacity` and
 * `transform`. The entrance is a `transform: translateY()`; under
 * `prefers-reduced-motion` its transition is `none` — but the objective
 * and the elapsed reading still render and still update, because they are
 * information, not motion (slice 4's ruling: a reduced-motion alternative
 * must be perceivable, not merely shortened).
 *
 * FONTS ARE DATA (§15.4.3 precondition, owner ruling carried from slice
 * 1). Every family comes from `defaultCanvasTextStyles()`; none is
 * hard-coded here. The objective is free creator-authored text that will
 * routinely be Indic script in this market, so the standing precondition —
 * Indic fallback required before this module becomes creator-configurable
 * — applies to it too, and this slice does not close it.
 */

import type { CanvasModuleDefinition } from '../master-canvas-runtime';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import { defaultCanvasTextStyles, type CanvasTextStyle } from '../text-rendering';

/** The overlay projection, exactly as `/v1/overlay-widgets/:overlayId/
 *  stream-mission` returns it and as `app_private.list_overlay_stream_
 *  mission` (migration 0135) projects it: three fields. No identity, and
 *  deliberately no end-shaped field. */
export interface StreamMission {
  schemaVersion: 'v1';
  missionId: string;
  objective: string;
  /** ISO-8601. The only temporal field that exists. The reading derived
   *  from it counts UP and never toward anything. */
  startedAt: string;
}

/** The label above the objective. A fixed first-party string — there is no
 *  creator-configurable copy in this slice (§15.4.3 controls are out of
 *  scope for every PRF-02 slice so far). */
export const STREAM_MISSION_KICKER = 'Stream mission';

export function isStreamMission(value: unknown): value is StreamMission {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StreamMission>;
  return candidate.schemaVersion === 'v1'
    && typeof candidate.missionId === 'string' && candidate.missionId.length > 0
    && typeof candidate.objective === 'string'
    && candidate.objective.length >= 1 && candidate.objective.length <= 120
    && typeof candidate.startedAt === 'string'
    && Number.isFinite(Date.parse(candidate.startedAt));
}

/**
 * Whole seconds elapsed since `startedAt`, floored at zero. Pure, so the
 * "counts up, never down" property is testable without a DOM. A clock skew
 * that puts `startedAt` in the future reads as 0 rather than as a negative
 * number — the card shows a mission that has just begun, never a countdown.
 */
export function elapsedSeconds(startedAtIso: string, nowMs: number): number {
  const startedMs = Date.parse(startedAtIso);
  if (!Number.isFinite(startedMs)) return 0;
  return Math.max(0, Math.floor((nowMs - startedMs) / 1000));
}

/** `1:04` / `12:03:07`. Hours only appear once there are hours — this is a
 *  reading of how long the mission has been running, not a clock face. */
export function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export interface StreamMissionModuleOptions {
  container: HTMLElement;
  /** The Canvas's ONE shared connection. Never an overlayId/token/apiOrigin
   *  — this module cannot open a session of its own. */
  connection: MasterCanvasConnection;
  fetchSnapshot: () => Promise<StreamMission | null>;
  reducedMotion: () => boolean;
  /** Injectable clock, so the elapsed reading is testable without waiting.
   *  Defaults to `Date.now`. */
  now?: () => number;
  kickerStyle?: CanvasTextStyle;
  objectiveStyle?: CanvasTextStyle;
  elapsedStyle?: CanvasTextStyle;
}

export function createStreamMissionModule(options: StreamMissionModuleOptions): CanvasModuleDefinition {
  const kickerStyle = options.kickerStyle ?? defaultCanvasTextStyles().label;
  const objectiveStyle = options.objectiveStyle ?? defaultCanvasTextStyles().title;
  const elapsedStyle = options.elapsedStyle ?? defaultCanvasTextStyles().amount;
  const now = options.now ?? (() => Date.now());

  let ready = false;
  let cardEl: HTMLElement;
  let kickerEl: HTMLElement;
  let objectiveEl: HTMLElement;
  let elapsedEl: HTMLElement;
  let latestMission: StreamMission | null = null;
  let dirty = false;
  let renderedSeconds = -1;
  let unsubscribeConnection: (() => void) | undefined;
  let fetchToken = 0;

  function ensureElements() {
    if (ready) return;
    const doc = options.container.ownerDocument;
    options.container.textContent = '';
    // Nothing is shown until the first real snapshot lands — a mission is
    // never invented and never guessed at.
    options.container.style.opacity = '0';

    cardEl = doc.createElement('div');
    cardEl.dataset.role = 'stream-mission-card';
    cardEl.style.transformOrigin = 'left center';
    cardEl.style.transform = 'translateY(8px)';
    // Composite-only, and reduced motion removes the motion without
    // removing the information below it.
    cardEl.style.transition = options.reducedMotion() ? 'none' : 'transform 260ms ease, opacity 260ms ease';

    kickerEl = doc.createElement('div');
    kickerEl.dataset.role = 'stream-mission-kicker';
    kickerEl.style.fontFamily = kickerStyle.fontFamily;
    kickerEl.textContent = STREAM_MISSION_KICKER;

    objectiveEl = doc.createElement('div');
    objectiveEl.dataset.role = 'stream-mission-objective';
    objectiveEl.style.fontFamily = objectiveStyle.fontFamily;

    elapsedEl = doc.createElement('div');
    elapsedEl.dataset.role = 'stream-mission-elapsed';
    elapsedEl.style.fontFamily = elapsedStyle.fontFamily;

    cardEl.append(kickerEl, objectiveEl, elapsedEl);
    options.container.appendChild(cardEl);
    ready = true;
  }

  async function refetch() {
    const token = ++fetchToken;
    const result = await options.fetchSnapshot().catch(() => null);
    if (token !== fetchToken) return; // superseded — discard, never render as current
    // A malformed payload is ignored, never thrown and never rendered: the
    // last known-good mission keeps showing until a valid one replaces it.
    if (result === null) {
      latestMission = null;
      dirty = true;
      return;
    }
    if (!isStreamMission(result)) return;
    latestMission = result;
    dirty = true;
  }

  return {
    key: 'stream_mission_card',
    activate() {
      ensureElements();
      unsubscribeConnection = options.connection.subscribe(() => { void refetch(); });
    },
    deactivate() {
      unsubscribeConnection?.();
      unsubscribeConnection = undefined;
      fetchToken += 1;
      dirty = false;
    },
    render() {
      ensureElements();
      const mission = latestMission;

      if (!mission) {
        if (!dirty) return;
        dirty = false;
        renderedSeconds = -1;
        if (options.container.style.opacity !== '0') options.container.style.opacity = '0';
        if (cardEl.style.transform !== 'translateY(8px)') cardEl.style.transform = 'translateY(8px)';
        return;
      }

      // The elapsed reading is derived every frame but WRITTEN only when
      // the whole-second value actually changes — the "cheap to call every
      // frame, no-op quickly when nothing changed" contract
      // CanvasModuleDefinition.render already states.
      const seconds = elapsedSeconds(mission.startedAt, now());
      if (!dirty && seconds === renderedSeconds) return;
      dirty = false;
      renderedSeconds = seconds;

      if (options.container.style.opacity !== '1') options.container.style.opacity = '1';
      if (cardEl.style.transform !== 'translateY(0px)') cardEl.style.transform = 'translateY(0px)';
      if (objectiveEl.textContent !== mission.objective) objectiveEl.textContent = mission.objective;

      const elapsedText = formatElapsed(seconds);
      if (elapsedEl.textContent !== elapsedText) elapsedEl.textContent = elapsedText;
    },
  };
}
