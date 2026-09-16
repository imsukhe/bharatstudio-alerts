import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupporterTickerModule, DEFAULT_TICKER_ROW_POOL_SIZE, type SupporterTickerEntry } from './supporter-ticker-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';

/*
 * PRF-02.5/PRF-04: "A ticker recycles its rows; it does not append
 * forever. An 8-hour stream must end with the same node count it started
 * with." Driven with many more events than the row pool holds, not two —
 * per this task's explicit instruction.
 *
 * PRF-02.7/PRF-03: animation touches only opacity/transform, and
 * `prefers-reduced-motion` disables the CSS transition outright.
 */

function fakeConnection(): MasterCanvasConnection & { fireChange(): void } {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeToEvents: () => () => {},
    acknowledge: async () => ({ ok: false }),
    getOpenAttemptCount: () => 0,
    getSubscriberCount: () => listeners.size,
    fireChange() { for (const l of listeners) l(); },
  };
}

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

test('the ticker row pool is created once, at a fixed size, and never grows across many events (bounded DOM recycling)', async () => {
  const container = document.createElement('div');
  let callCount = 0;
  const entriesQueue: SupporterTickerEntry[][] = [];
  const connection = fakeConnection();
  const module = createSupporterTickerModule({
    container, connection,
    fetchSnapshot: async () => { callCount += 1; return entriesQueue[callCount - 1] ?? []; },
    reducedMotion: () => false,
  });

  module.activate();
  await flush();
  assert.equal(container.children.length, DEFAULT_TICKER_ROW_POOL_SIZE, 'the pool is created at activation');

  // Drive 80 distinct events through — far more than the pool holds, and
  // more than "two" per this task's explicit instruction.
  for (let batch = 0; batch < 80; batch += 1) {
    entriesQueue.push(Array.from({ length: 5 }, (_, i) => ({
      viewerRef: `viewer_${batch}_${i}`, tierLabel: 'gold', supportedAt: new Date().toISOString(),
    })));
    connection.fireChange();
    await flush();
    module.render(batch);
    assert.equal(container.children.length, DEFAULT_TICKER_ROW_POOL_SIZE, `node count must stay flat at batch ${batch}, not accumulate`);
  }

  // Baseline check, explicitly: the node count at the end equals the node
  // count at the start (activation), not merely "some constant".
  assert.equal(container.children.length, DEFAULT_TICKER_ROW_POOL_SIZE);
});

test('render() only writes to the DOM when data actually changed — a no-op frame does not touch style/text', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const entries: SupporterTickerEntry[] = [{ viewerRef: 'v1', tierLabel: 'gold', supportedAt: '2026-09-16T00:00:00.000Z' }];
  const module = createSupporterTickerModule({
    container, connection, fetchSnapshot: async () => entries, reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);
  const row = container.children[0] as HTMLElement;
  const textBefore = row.textContent;
  row.setAttribute('data-untouched-probe', '1');
  module.render(16); // nothing changed since the last render — should no-op
  assert.equal(row.textContent, textBefore);
  assert.equal(row.getAttribute('data-untouched-probe'), '1', 'a no-op frame must not re-touch the row at all');
});

test('animation touches only transform/opacity — never top/left/width/height (PRF-03)', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createSupporterTickerModule({
    container, connection,
    fetchSnapshot: async () => [{ viewerRef: 'v1', tierLabel: 'gold', supportedAt: '2026-09-16T00:00:00.000Z' }],
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);
  const row = container.children[0] as HTMLElement;
  assert.equal(row.style.opacity, '1');
  assert.ok(row.style.transform.length > 0, 'a transform is set (composite-only baseline)');
  for (const forbidden of ['width', 'height', 'top', 'left', 'right', 'bottom']) {
    assert.equal((row.style as unknown as Record<string, string>)[forbidden], '', `must never set the layout-triggering property "${forbidden}"`);
  }
});

test('prefers-reduced-motion disables the transition outright', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createSupporterTickerModule({
    container, connection, fetchSnapshot: async () => [], reducedMotion: () => true,
  });
  module.activate();
  const row = container.children[0] as HTMLElement;
  assert.equal(row.style.transition, 'none');
});

test('deactivate unsubscribes from the connection and discards any in-flight fetch — no stale value applies after teardown', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let resolveSlowFetch: ((value: SupporterTickerEntry[]) => void) | undefined;
  const module = createSupporterTickerModule({
    container, connection,
    fetchSnapshot: () => new Promise((resolve) => { resolveSlowFetch = resolve; }),
    reducedMotion: () => false,
  });
  module.activate();
  assert.equal(connection.getSubscriberCount(), 1);
  connection.fireChange();
  await flush();
  module.deactivate();
  assert.equal(connection.getSubscriberCount(), 0, 'deactivate must unsubscribe from the shared connection');

  // The slow fetch resolves AFTER teardown — its result must never be
  // applied (PRF-02.12: no module shows a stale/late value as current).
  resolveSlowFetch?.([{ viewerRef: 'late', tierLabel: 'gold', supportedAt: '2026-09-16T00:00:00.000Z' }]);
  await flush();
  module.render(0);
  const rowsWithText = [...container.children].filter((el) => (el as HTMLElement).textContent);
  assert.equal(rowsWithText.length, 0, 'a fetch that resolves after deactivation must never populate a row');
});
