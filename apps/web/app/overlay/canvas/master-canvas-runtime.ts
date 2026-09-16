'use client';

/*
 * PRF-02: the Master Canvas runtime. §19.5: "One `requestAnimationFrame`
 * scheduler, modules as pure render functions driven by a single state
 * store." This file owns that one scheduler, the module registry, the
 * per-module error boundary (PRF-14), and idle/entitlement-driven
 * activation (PRF-05). It does NOT own the connection
 * (master-canvas-connection.ts) or any module's own rendering
 * (modules/*.ts) — a module registers itself here and is driven by this
 * loop, nothing more.
 *
 * VISIBILITY, NOT rAF CADENCE, IS THE IDLE SIGNAL — and this is load-
 * bearing, not a style choice. MDN: "requestAnimationFrame() calls are
 * paused in most browsers when running in background tabs or hidden
 * iframes." Chrome's own developer blog is more specific: "Chrome does
 * not call requestAnimationFrame() when a page is in the background" at
 * all (developer.chrome.com/blog/background_tabs, accessed 2026-09-16).
 * An OBS Browser Source that is not on the current program scene is
 * exactly this case — a hidden/occluded page — and it is the ordinary,
 * common condition on a real multi-scene stream, not an edge case. If
 * this runtime tried to detect "we should go idle" by checking
 * document.hidden INSIDE the rAF callback, that check would itself stop
 * running the moment it needed to fire — the frame loop that is supposed
 * to notice "we're hidden now, tear down" is the exact thing the
 * hidden state pauses. So idle detection here is event-driven
 * (`visibilitychange`) and fully independent of whether the frame loop is
 * currently ticking: going hidden immediately deactivates every module
 * (and, via each module's own deactivate(), releases the shared
 * connection's subscription — see master-canvas-connection.ts) and stops
 * the frame loop outright, without waiting for a frame that may never
 * come.
 *
 * ERROR BOUNDARY (PRF-02.3/.4, PRF-14): render() and activate() calls are
 * wrapped in try/catch. A module that throws twice in a session is marked
 * `down` and is never called again — no third attempt, no silent
 * indefinite retry — while every other module keeps rendering on the same
 * loop.
 *
 * NO THIRD PARTY (§9.1.1, PRF-13, PRF-02.11): a CanvasModuleDefinition is
 * a plain object of function references this file calls directly — there
 * is no field anywhere in its shape for a URL, HTML string, or script to
 * load. A module cannot smuggle an iframe/script/external stylesheet in
 * through this registry even if it wanted to; the type itself has no slot
 * for one.
 */

export type CanvasModuleStatus = 'inactive' | 'active' | 'down';

export interface CanvasModuleDefinition {
  key: string;
  /**
   * Called once when the module becomes active (entitled AND the page is
   * visible). Should establish whatever subscription the module needs
   * (typically: `connection.subscribe(...)` from
   * master-canvas-connection.ts) and do any one-time DOM setup (e.g. the
   * ticker's fixed recycled row pool). Must not schedule its own
   * frame/timer loop — PRF-02.2.
   */
  activate(): void;
  /**
   * Called when the module stops being active for any reason: the page
   * went hidden, the module lost its entitlement/cap slot, or it failed
   * twice. Must release every subscription activate() created and must be
   * safe to call more than once (idempotent) — the runtime may call it
   * defensively.
   */
  deactivate(): void;
  /**
   * The pure render step, called by the single shared scheduler once per
   * frame while this module is active. Must touch only `transform`/
   * `opacity` (PRF-03) and must not read layout after a write in the same
   * pass. Cheap to call every frame even when nothing changed — modules
   * are expected to no-op quickly when their own data hasn't changed
   * since the last frame (a "dirty" flag set by their own async fetch
   * callback, not by this loop).
   */
  render(timestampMs: number): void;
}

export interface VisibilitySource {
  isHidden(): boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** Wraps the real DOM Page Visibility API. Only constructed in the browser. */
export function createDocumentVisibilitySource(doc: Document): VisibilitySource {
  return {
    isHidden: () => doc.hidden,
    addEventListener: (type, listener) => doc.addEventListener(type, listener),
    removeEventListener: (type, listener) => doc.removeEventListener(type, listener),
  };
}

export interface MasterCanvasRuntimeConfig {
  requestFrame?: (callback: (timestampMs: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  visibilitySource?: VisibilitySource;
  /** PRF-14: "a module that fails twice stays down." Stated by name in
   * the authority, not a value this runtime is free to invent. */
  maxFailuresBeforeDown?: number;
  /** Called whenever a module transitions to 'down', so the host page can
   * render the creator-visible note PRF-14 requires. */
  onModuleDown?: (moduleKey: string) => void;
}

interface ModuleEntry {
  definition: CanvasModuleDefinition;
  entitled: boolean; // server said this module is active for this overlay
  activated: boolean; // activate() has run and deactivate() has not (yet) undone it
  failureCount: number;
  status: CanvasModuleStatus;
}

export interface MasterCanvasRuntime {
  registerModule(definition: CanvasModuleDefinition): void;
  /** Entitlement-driven: call once per module with the server's active/
   * inactive answer (from GET .../master-canvas/modules). A module that
   * is never marked entitled is never activated and never costs anything
   * — PRF-02.10, this task's §3. */
  setModuleEntitled(moduleKey: string, entitled: boolean): void;
  getModuleStatus(moduleKey: string): CanvasModuleStatus;
  /** Starts the visibility listener. The frame loop itself only runs
   * while at least one module is active — see file header. */
  start(): void;
  stop(): void;
}

const DEFAULT_MAX_FAILURES = 2; // PRF-14's own stated number, not invented

export function createMasterCanvasRuntime(config: MasterCanvasRuntimeConfig = {}): MasterCanvasRuntime {
  const requestFrame = config.requestFrame ?? ((cb) => globalThis.requestAnimationFrame((t) => cb(t)));
  const cancelFrame = config.cancelFrame ?? ((handle) => globalThis.cancelAnimationFrame(handle));
  const maxFailures = config.maxFailuresBeforeDown ?? DEFAULT_MAX_FAILURES;

  const modules = new Map<string, ModuleEntry>();
  let frameHandle: number | undefined;
  let started = false;
  let pageHidden = false;

  function activeModules(): ModuleEntry[] {
    return [...modules.values()].filter((entry) => entry.status === 'active');
  }

  function tick(timestampMs: number) {
    frameHandle = undefined;
    for (const entry of activeModules()) {
      try {
        entry.definition.render(timestampMs);
      } catch {
        markFailure(entry);
      }
    }
    if (!pageHidden && activeModules().length > 0) {
      frameHandle = requestFrame(tick);
    }
  }

  function ensureLoopRunning() {
    if (frameHandle !== undefined) return; // one rAF chain, regardless of module count — PRF-02.2
    if (pageHidden) return;
    if (activeModules().length === 0) return;
    frameHandle = requestFrame(tick);
  }

  function markFailure(entry: ModuleEntry) {
    entry.failureCount += 1;
    if (entry.failureCount >= maxFailures) {
      deactivateEntry(entry, 'down');
      config.onModuleDown?.(entry.definition.key);
    }
    // Under maxFailures: the module simply skipped this frame/activation.
    // Every OTHER module's render this same tick already ran (the try/
    // catch is per-module, inside the loop) — one module failing never
    // blanks the canvas (PRF-02.3).
  }

  function activateEntry(entry: ModuleEntry) {
    if (entry.activated || entry.status === 'down') return;
    try {
      entry.definition.activate();
      entry.activated = true;
      entry.status = 'active';
      ensureLoopRunning();
    } catch {
      markFailure(entry);
    }
  }

  function deactivateEntry(entry: ModuleEntry, nextStatus: CanvasModuleStatus) {
    if (entry.activated) {
      try {
        entry.definition.deactivate();
      } catch {
        // Teardown must never throw past this point — a module that fails
        // to clean up must not prevent every other module (or the loop
        // itself) from continuing.
      }
    }
    entry.activated = false;
    entry.status = nextStatus;
  }

  function reconcile(entry: ModuleEntry) {
    const shouldBeActive = entry.entitled && !pageHidden && entry.status !== 'down';
    if (shouldBeActive) activateEntry(entry);
    else if (entry.status === 'active') deactivateEntry(entry, 'inactive');
  }

  function onVisibilityChange(source: VisibilitySource) {
    return () => {
      pageHidden = source.isHidden();
      if (pageHidden) {
        // Event-driven, not rAF-cadence-driven — see file header. Every
        // active module is torn down right now, synchronously with the
        // visibility event, and the frame loop is cancelled outright so
        // it is never left "waiting for a frame that may never come."
        for (const entry of modules.values()) {
          if (entry.status === 'active') deactivateEntry(entry, 'inactive');
        }
        if (frameHandle !== undefined) {
          cancelFrame(frameHandle);
          frameHandle = undefined;
        }
      } else {
        for (const entry of modules.values()) reconcile(entry);
      }
    };
  }

  let visibilityListener: (() => void) | undefined;
  let visibilitySource: VisibilitySource | undefined;

  return {
    registerModule(definition) {
      modules.set(definition.key, {
        definition, entitled: false, activated: false, failureCount: 0, status: 'inactive',
      });
    },
    setModuleEntitled(moduleKey, entitled) {
      const entry = modules.get(moduleKey);
      if (!entry) return;
      entry.entitled = entitled;
      reconcile(entry);
    },
    getModuleStatus(moduleKey) {
      return modules.get(moduleKey)?.status ?? 'inactive';
    },
    start() {
      if (started) return;
      started = true;
      const source = config.visibilitySource;
      if (source) {
        visibilitySource = source;
        pageHidden = source.isHidden();
        visibilityListener = onVisibilityChange(source);
        source.addEventListener('visibilitychange', visibilityListener);
      }
      for (const entry of modules.values()) reconcile(entry);
    },
    stop() {
      if (!started) return;
      started = false;
      if (visibilitySource && visibilityListener) {
        visibilitySource.removeEventListener('visibilitychange', visibilityListener);
      }
      visibilityListener = undefined;
      visibilitySource = undefined;
      for (const entry of modules.values()) {
        if (entry.status === 'active') deactivateEntry(entry, 'inactive');
      }
      if (frameHandle !== undefined) {
        cancelFrame(frameHandle);
        frameHandle = undefined;
      }
    },
  };
}
