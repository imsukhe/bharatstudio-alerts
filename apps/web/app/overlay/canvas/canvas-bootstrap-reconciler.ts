/**
 * Bounded recovery for Canvas configuration that is deliberately outside a
 * rendered module: server-authoritative module entitlement and canvas layout.
 *
 * There is no polling timer here. The host asks for an initial reconciliation
 * and asks again only when its one shared overlay transport reports a successful
 * (re)connection. A reconnect burst while an HTTP read is pending becomes one
 * follow-up pair, never an unbounded set of overlapping reads.
 */
export interface CanvasBootstrapReconcilerOptions<Modules, Layout> {
  readModules(): Promise<Modules | undefined>;
  readLayout(): Promise<Layout | undefined>;
  applyModules(value: Modules): void;
  applyLayout(value: Layout): void;
}

export interface CanvasBootstrapReconciler {
  reconcile(): void;
  dispose(): void;
}

export function createCanvasBootstrapReconciler<Modules, Layout>(
  options: CanvasBootstrapReconcilerOptions<Modules, Layout>,
): CanvasBootstrapReconciler {
  let disposed = false;
  let inFlight = false;
  let followUpRequested = false;

  async function run(): Promise<void> {
    inFlight = true;
    try {
      // The Promise.resolve().then wrapper also turns an accidental synchronous
      // loader throw into a settled failure, so it cannot strand `inFlight` and
      // permanently suppress a later successful connection retry.
      const [modules, layout] = await Promise.allSettled([
        Promise.resolve().then(() => options.readModules()),
        Promise.resolve().then(() => options.readLayout()),
      ]);
      if (!disposed) {
        // Handle these independently: a transient layout failure must not
        // discard a valid entitlement answer, and vice versa. Undefined is the
        // host's explicit invalid/non-OK result and preserves last-known-good.
        try {
          if (modules.status === 'fulfilled' && modules.value !== undefined) options.applyModules(modules.value);
        } catch {
          // Application is best-effort too: one state setter/runtime failure
          // cannot prevent the other value or a later connection retry.
        }
        try {
          if (layout.status === 'fulfilled' && layout.value !== undefined) options.applyLayout(layout.value);
        } catch {
          // See the parallel modules application guard above.
        }
      }
    } finally {
      inFlight = false;
      if (!disposed && followUpRequested) {
        followUpRequested = false;
        void run();
      }
    }
  }

  return {
    reconcile() {
      if (disposed) return;
      if (inFlight) {
        followUpRequested = true;
        return;
      }
      void run();
    },
    dispose() {
      disposed = true;
      followUpRequested = false;
    },
  };
}
