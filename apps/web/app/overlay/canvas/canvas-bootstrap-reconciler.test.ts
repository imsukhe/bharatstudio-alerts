import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasBootstrapReconciler } from './canvas-bootstrap-reconciler';

async function flush(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('a failed bootstrap read preserves its side while applying the other side, then a later lifecycle reconciliation recovers it', async () => {
  let moduleReads = 0;
  let layoutReads = 0;
  const appliedModules: string[][] = [];
  const appliedLayouts: string[] = [];
  const reconciler = createCanvasBootstrapReconciler({
    async readModules() {
      moduleReads += 1;
      if (moduleReads === 1) throw new Error('transient modules read failure');
      return ['safe_soundboard'];
    },
    async readLayout() {
      layoutReads += 1;
      return layoutReads === 1 ? 'vertical' : 'horizontal';
    },
    applyModules: (value) => appliedModules.push(value),
    applyLayout: (value) => appliedLayouts.push(value),
  });

  reconciler.reconcile();
  await flush();
  assert.equal(moduleReads, 1);
  assert.deepEqual(appliedModules, [], 'failed entitlement read must never guess-enable a module');
  assert.deepEqual(appliedLayouts, ['vertical'], 'an independent valid layout answer still applies');

  reconciler.reconcile(); // a later successful connection on the existing transport
  await flush();
  assert.equal(moduleReads, 2);
  assert.deepEqual(appliedModules, [['safe_soundboard']]);
  assert.deepEqual(appliedLayouts, ['vertical', 'horizontal']);
});

test('many lifecycle signals during one unresolved read coalesce to one follow-up pair', async () => {
  const firstModules = deferred<string[]>();
  const firstLayout = deferred<string>();
  const secondModules = deferred<string[]>();
  const secondLayout = deferred<string>();
  let moduleReads = 0;
  let layoutReads = 0;
  const applied: string[] = [];
  const reconciler = createCanvasBootstrapReconciler({
    readModules: async () => {
      moduleReads += 1;
      return moduleReads === 1 ? firstModules.promise : secondModules.promise;
    },
    readLayout: async () => {
      layoutReads += 1;
      return layoutReads === 1 ? firstLayout.promise : secondLayout.promise;
    },
    applyModules: (value) => applied.push(`modules:${value.join(',')}`),
    applyLayout: (value) => applied.push(`layout:${value}`),
  });

  reconciler.reconcile();
  reconciler.reconcile();
  reconciler.reconcile();
  await flush(1); // loaders are deliberately invoked through a safe microtask wrapper
  assert.equal(moduleReads, 1);
  assert.equal(layoutReads, 1);

  firstModules.resolve(['goal_ladder']);
  firstLayout.resolve('horizontal');
  await flush();
  assert.equal(moduleReads, 2, 'all concurrent requests become one subsequent modules read');
  assert.equal(layoutReads, 2, 'all concurrent requests become one subsequent layout read');

  secondModules.resolve(['safe_soundboard']);
  secondLayout.resolve('vertical');
  await flush();
  assert.equal(moduleReads, 2);
  assert.equal(layoutReads, 2);
  assert.deepEqual(applied, [
    'modules:goal_ladder', 'layout:horizontal',
    'modules:safe_soundboard', 'layout:vertical',
  ]);
});

test('dispose prevents delayed values and queued lifecycle retries from mutating a torn-down Canvas', async () => {
  const modules = deferred<string[]>();
  const layout = deferred<string>();
  const applied: string[] = [];
  const reconciler = createCanvasBootstrapReconciler({
    readModules: async () => modules.promise,
    readLayout: async () => layout.promise,
    applyModules: () => applied.push('modules'),
    applyLayout: () => applied.push('layout'),
  });

  reconciler.reconcile();
  reconciler.reconcile(); // queues one follow-up before teardown
  reconciler.dispose();
  modules.resolve(['goal_ladder']);
  layout.resolve('vertical');
  await flush();
  reconciler.reconcile();
  await flush();
  assert.deepEqual(applied, []);
});

test('a synchronous loader or apply failure never strands recovery or suppresses the independent side', async () => {
  let moduleReads = 0;
  let layoutReads = 0;
  const applied: string[] = [];
  const reconciler = createCanvasBootstrapReconciler({
    readModules: () => {
      moduleReads += 1;
      if (moduleReads === 1) throw new Error('synchronous loader defect');
      return Promise.resolve(['goal_ladder']);
    },
    readLayout: () => {
      layoutReads += 1;
      return Promise.resolve('vertical');
    },
    applyModules: (value) => {
      if (value[0] === 'goal_ladder') throw new Error('isolated apply defect');
    },
    applyLayout: (value) => applied.push(value),
  });

  reconciler.reconcile();
  await flush();
  assert.deepEqual(applied, ['vertical'], 'layout still applies when modules loader fails synchronously');
  reconciler.reconcile();
  await flush();
  assert.equal(moduleReads, 2, 'later connection retry remains available after sync/apply failure');
  assert.equal(layoutReads, 2);
  assert.deepEqual(applied, ['vertical', 'vertical']);
});
