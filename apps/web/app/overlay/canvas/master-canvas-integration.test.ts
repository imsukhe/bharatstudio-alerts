import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMasterCanvasConnection } from './master-canvas-connection';
import { createMasterCanvasRuntime } from './master-canvas-runtime';
import { createSupporterTickerModule, DEFAULT_TICKER_ROW_POOL_SIZE } from './modules/supporter-ticker-module';
import { createGoalLadderModule } from './modules/goal-ladder-module';

/*
 * End-to-end wiring test: the real connection, the real runtime, and both
 * real module renderers together — not each piece in isolation. This is
 * the closest this test suite gets to "a canvas holding both modules"
 * (PRF-02.1) and to PRF-02.10 (a module the server has not marked active
 * costs nothing: no subscription, no fetch, ever).
 */

function createManualFrameScheduler() {
  let nextHandle = 1;
  const pending = new Map<number, (t: number) => void>();
  return {
    requestFrame: (cb: (t: number) => void) => { const h = nextHandle++; pending.set(h, cb); return h; },
    cancelFrame: (h: number) => { pending.delete(h); },
    tick(t = 0) { const cbs = [...pending.values()]; pending.clear(); for (const cb of cbs) cb(t); },
  };
}

function neverEndingStreamFetch(onCall: () => void) {
  return (async () => {
    onCall();
    return { ok: true, body: { getReader: () => ({ read: () => new Promise<{ done: boolean }>(() => {}), cancel: async () => {} }) } } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

test('a canvas with both built modules entitled opens exactly one connection', async () => {
  let fetchCalls = 0;
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => { fetchCalls += 1; }),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const tickerContainer = document.createElement('div');
  const goalContainer = document.createElement('div');
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => [], reducedMotion: () => false,
  }));
  runtime.registerModule(createGoalLadderModule({
    container: goalContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));

  runtime.start();
  runtime.setModuleEntitled('supporter_ticker', true);
  runtime.setModuleEntitled('community_goal_ladder', true);
  await flush();

  assert.equal(fetchCalls, 1, 'two entitled modules must still open exactly one transport connection');
  assert.equal(connection.getSubscriberCount(), 2);
  assert.equal(tickerContainer.children.length, DEFAULT_TICKER_ROW_POOL_SIZE, 'the ticker still mounted its recycled row pool');
});

test('PRF-02.10/this task\'s §3: a module the server never marks active is never subscribed, never fetched, never rendered', async () => {
  let fetchCalls = 0;
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => { fetchCalls += 1; }),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const tickerContainer = document.createElement('div');
  const goalContainer = document.createElement('div');
  let tickerSnapshotCalls = 0;
  let goalSnapshotCalls = 0;
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => { tickerSnapshotCalls += 1; return []; }, reducedMotion: () => false,
  }));
  runtime.registerModule(createGoalLadderModule({
    container: goalContainer, connection, fetchSnapshot: async () => { goalSnapshotCalls += 1; return null; }, reducedMotion: () => false,
  }));

  runtime.start();
  // Only the ticker is entitled (e.g. Free tier's 2-module cap already
  // spent, or the module simply disabled) — the goal ladder is NEVER
  // marked entitled.
  runtime.setModuleEntitled('supporter_ticker', true);
  await flush();

  assert.equal(fetchCalls, 1, 'the shared connection still opens exactly once, for the one entitled module');
  assert.equal(connection.getSubscriberCount(), 1, 'the un-entitled module never subscribes to the shared connection');
  assert.ok(tickerSnapshotCalls > 0, 'the entitled module does its normal work');
  assert.equal(goalSnapshotCalls, 0, 'an un-entitled module never fetches its own snapshot — it costs nothing');
  assert.equal(goalContainer.children.length, 0, 'an un-entitled module never even builds its DOM');
  assert.equal(runtime.getModuleStatus('community_goal_ladder'), 'inactive');
});

test('going hidden tears down every module\'s connection subscription, not just its rendering', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  let hidden = false;
  const listeners = new Set<() => void>();
  const visibilitySource = {
    isHidden: () => hidden,
    addEventListener: (_t: string, l: () => void) => { listeners.add(l); },
    removeEventListener: (_t: string, l: () => void) => { listeners.delete(l); },
  };
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame, visibilitySource });

  const tickerContainer = document.createElement('div');
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => [], reducedMotion: () => false,
  }));
  runtime.start();
  runtime.setModuleEntitled('supporter_ticker', true);
  await flush();
  assert.equal(connection.getSubscriberCount(), 1);

  hidden = true;
  for (const l of listeners) l();
  assert.equal(connection.getSubscriberCount(), 0, 'a hidden OBS scene must release the shared connection subscription entirely, not merely stop rendering');
});
