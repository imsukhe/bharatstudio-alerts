import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasBootstrapRecovery } from './canvas-bootstrap-recovery';

function createVisibility(initiallyHidden = false) {
  let hidden = initiallyHidden;
  const listeners = new Set<() => void>();
  return {
    source: {
      isHidden: () => hidden,
      addEventListener: (_type: 'visibilitychange', listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: 'visibilitychange', listener: () => void) => listeners.delete(listener),
    },
    setHidden(next: boolean) {
      hidden = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

test('bootstrap recovery uses one connection lifecycle subscription only while the Canvas is visible, and cleans up on disposal', () => {
  const listeners = new Set<() => void>();
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let reconcileCalls = 0;
  let disposeCalls = 0;
  const visibility = createVisibility(false);
  const recovery = createCanvasBootstrapRecovery({
    connection: {
      subscribeToConnection(listener) {
        subscribeCalls += 1;
        listeners.add(listener);
        return () => { unsubscribeCalls += 1; listeners.delete(listener); };
      },
    },
    reconciler: {
      reconcile: () => { reconcileCalls += 1; },
      dispose: () => { disposeCalls += 1; },
    },
    visibilitySource: visibility.source,
  });

  recovery.start();
  assert.equal(subscribeCalls, 1);
  assert.equal(reconcileCalls, 1, 'visible Canvas attempts bootstrap immediately');
  for (const listener of listeners) listener();
  assert.equal(reconcileCalls, 2, 'a successful existing-transport connection retries bootstrap');

  visibility.setHidden(true);
  assert.equal(unsubscribeCalls, 1, 'hidden Canvas retains no configuration-only transport subscription');
  visibility.setHidden(false);
  assert.equal(subscribeCalls, 2);
  assert.equal(reconcileCalls, 3, 'becoming visible performs one bounded new bootstrap attempt');

  recovery.dispose();
  assert.equal(unsubscribeCalls, 2);
  assert.equal(disposeCalls, 1);
  assert.equal(visibility.listenerCount(), 0);
  visibility.setHidden(false);
  assert.equal(subscribeCalls, 2, 'disposed Canvas cannot reopen a transport');
});
