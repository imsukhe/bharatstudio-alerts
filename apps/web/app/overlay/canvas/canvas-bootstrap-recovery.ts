import type { CanvasBootstrapReconciler } from './canvas-bootstrap-reconciler';

export interface CanvasBootstrapConnection {
  subscribeToConnection(listener: () => void): () => void;
}

export interface CanvasBootstrapVisibilitySource {
  isHidden(): boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Binds bootstrap reconciliation to the existing transport's successful
 * connection lifecycle while respecting browser-source visibility. Hidden OBS
 * sources retain no configuration-only SSE subscription and create no retry
 * work; becoming visible starts one shared subscription and one immediate read.
 */
export function createCanvasBootstrapRecovery(options: {
  connection: CanvasBootstrapConnection;
  reconciler: CanvasBootstrapReconciler;
  visibilitySource: CanvasBootstrapVisibilitySource;
}): { start(): void; dispose(): void } {
  let started = false;
  let disposed = false;
  let unsubscribeConnection: (() => void) | undefined;

  function startVisibleRecovery() {
    if (disposed || options.visibilitySource.isHidden() || unsubscribeConnection) return;
    unsubscribeConnection = options.connection.subscribeToConnection(() => options.reconciler.reconcile());
    options.reconciler.reconcile();
  }

  function stopVisibleRecovery() {
    unsubscribeConnection?.();
    unsubscribeConnection = undefined;
  }

  function onVisibilityChange() {
    if (options.visibilitySource.isHidden()) stopVisibleRecovery();
    else startVisibleRecovery();
  }

  return {
    start() {
      if (started || disposed) return;
      started = true;
      options.visibilitySource.addEventListener('visibilitychange', onVisibilityChange);
      startVisibleRecovery();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (started) options.visibilitySource.removeEventListener('visibilitychange', onVisibilityChange);
      stopVisibleRecovery();
      options.reconciler.dispose();
    },
  };
}
