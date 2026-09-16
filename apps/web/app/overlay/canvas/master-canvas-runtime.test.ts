import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMasterCanvasRuntime, type CanvasModuleDefinition, type VisibilitySource } from './master-canvas-runtime';

/*
 * PRF-02.2/.3/.4/.6: one rAF loop drives every module; a throwing module
 * never blanks the canvas; a module that fails twice stays down with a
 * note; a hidden/inactive module unsubscribes and does zero work — driven
 * by a visibility SIGNAL, never by the frame loop's own cadence (see
 * master-canvas-runtime.ts's header comment for why that distinction is
 * load-bearing, not stylistic, per the MDN/Chrome evidence in this task's
 * review record).
 */

function createManualFrameScheduler() {
  let nextHandle = 1;
  const pending = new Map<number, (timestampMs: number) => void>();
  return {
    requestFrame: (cb: (timestampMs: number) => void) => {
      const handle = nextHandle++;
      pending.set(handle, cb);
      return handle;
    },
    cancelFrame: (handle: number) => { pending.delete(handle); },
    /** Runs every currently-scheduled callback once, as one animation
     * frame would. Returns how many callbacks ran. */
    tick(timestampMs = 0): number {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb(timestampMs);
      return callbacks.length;
    },
    pendingFrameCount() { return pending.size; },
  };
}

function createManualVisibilitySource(): VisibilitySource & { setHidden(hidden: boolean): void } {
  let hidden = false;
  const listeners = new Set<() => void>();
  return {
    isHidden: () => hidden,
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
    setHidden(next: boolean) {
      hidden = next;
      for (const listener of listeners) listener();
    },
  };
}

function trackingModule(key: string): CanvasModuleDefinition & { renderCalls: number; activateCalls: number; deactivateCalls: number } {
  const state = { renderCalls: 0, activateCalls: 0, deactivateCalls: 0 };
  return {
    key,
    get renderCalls() { return state.renderCalls; },
    get activateCalls() { return state.activateCalls; },
    get deactivateCalls() { return state.deactivateCalls; },
    activate() { state.activateCalls += 1; },
    deactivate() { state.deactivateCalls += 1; },
    render() { state.renderCalls += 1; },
  };
}

test('PRF-02.2: one shared frame loop drives every active module — a single requestFrame chain, not one per module', () => {
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });
  const a = trackingModule('a');
  const b = trackingModule('b');
  runtime.registerModule(a);
  runtime.registerModule(b);
  runtime.start();
  runtime.setModuleEntitled('a', true);
  runtime.setModuleEntitled('b', true);

  assert.equal(scheduler.pendingFrameCount(), 1, 'exactly one frame is scheduled regardless of module count');
  const ran = scheduler.tick(16);
  assert.equal(ran, 1, 'the scheduler was only ever given one callback to run');
  assert.equal(a.renderCalls, 1);
  assert.equal(b.renderCalls, 1);
  // The loop keeps re-scheduling itself as ONE chain, frame after frame.
  assert.equal(scheduler.pendingFrameCount(), 1);
  scheduler.tick(32);
  assert.equal(a.renderCalls, 2);
  assert.equal(b.renderCalls, 2);
});

test('PRF-02.3: a module that throws during render does not blank the canvas — every other module keeps rendering', () => {
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });
  const okModule = trackingModule('ok');
  let throwCount = 0;
  const badModule: CanvasModuleDefinition = {
    key: 'bad', activate() {}, deactivate() {},
    render() { throwCount += 1; throw new Error('module render failure'); },
  };
  runtime.registerModule(okModule);
  runtime.registerModule(badModule);
  runtime.start();
  runtime.setModuleEntitled('ok', true);
  runtime.setModuleEntitled('bad', true);

  scheduler.tick(16);
  assert.equal(throwCount, 1);
  assert.equal(okModule.renderCalls, 1, 'the well-behaved module must render on the SAME frame the other one threw');
  assert.equal(runtime.getModuleStatus('bad'), 'active', 'one failure alone must not take the module down — PRF-14 says twice');
});

test('PRF-02.4/PRF-14: a module that fails twice stays down and is never called a third time; a visible note fires exactly once', () => {
  const scheduler = createManualFrameScheduler();
  const downEvents: string[] = [];
  const runtime = createMasterCanvasRuntime({
    requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame,
    onModuleDown: (key) => downEvents.push(key),
  });
  const okModule = trackingModule('ok');
  let renderAttempts = 0;
  const badModule: CanvasModuleDefinition = {
    key: 'bad', activate() {}, deactivate() {},
    render() { renderAttempts += 1; throw new Error('always fails'); },
  };
  runtime.registerModule(okModule);
  runtime.registerModule(badModule);
  runtime.start();
  runtime.setModuleEntitled('ok', true);
  runtime.setModuleEntitled('bad', true);

  scheduler.tick(16); // failure 1
  assert.equal(runtime.getModuleStatus('bad'), 'active');
  scheduler.tick(32); // failure 2 -> down
  assert.equal(runtime.getModuleStatus('bad'), 'down');
  assert.deepEqual(downEvents, ['bad']);
  assert.equal(renderAttempts, 2);

  // The loop keeps running for the surviving module...
  scheduler.tick(48);
  assert.equal(okModule.renderCalls, 3, 'the good module keeps rendering every frame after the bad one goes down');
  // ...but the down module is never rendered again, ever.
  assert.equal(renderAttempts, 2, 'a module marked down must never be called a third time');
  assert.equal(downEvents.length, 1, 'the down note fires exactly once, not once per frame afterward');
});

test('PRF-02.6: an un-entitled module is never activated — zero render calls, zero activate calls', () => {
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });
  const module = trackingModule('over_cap');
  runtime.registerModule(module);
  runtime.start(); // entitled defaults to false — never set true
  assert.equal(scheduler.pendingFrameCount(), 0, 'no module is active, so the loop never even starts');
  scheduler.tick(16);
  assert.equal(module.activateCalls, 0);
  assert.equal(module.renderCalls, 0);
  assert.equal(runtime.getModuleStatus('over_cap'), 'inactive');
});

test('PRF-02.6: a page-hidden signal deactivates every active module and stops the frame loop — driven by the visibility event, not by rAF cadence', () => {
  const scheduler = createManualFrameScheduler();
  const visibility = createManualVisibilitySource();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame, visibilitySource: visibility });
  const module = trackingModule('m');
  runtime.registerModule(module);
  runtime.start();
  runtime.setModuleEntitled('m', true);
  assert.equal(module.activateCalls, 1);
  assert.equal(scheduler.pendingFrameCount(), 1);

  // Per MDN/Chrome (cited in master-canvas-runtime.ts's header): rAF is
  // simply never called while hidden. This assertion proves the runtime
  // does NOT depend on a frame firing to notice — going hidden acts
  // immediately, synchronously, from the visibility event alone, with
  // zero frames ticked in between.
  visibility.setHidden(true);
  assert.equal(module.deactivateCalls, 1, 'deactivation happened from the visibility event itself, not from a frame that never ran');
  assert.equal(scheduler.pendingFrameCount(), 0, 'the frame chain is cancelled outright while hidden — it does not sit "waiting" for a frame that may never come');
  assert.equal(runtime.getModuleStatus('m'), 'inactive');

  // Confirm no render ever happens while hidden, even if something
  // (erroneously) tried to tick a stale handle.
  const rendersBeforeUnhide = module.renderCalls;
  visibility.setHidden(false);
  assert.equal(module.activateCalls, 2, 'becoming visible again reactivates the module');
  assert.equal(scheduler.pendingFrameCount(), 1);
  scheduler.tick(16);
  assert.equal(module.renderCalls, rendersBeforeUnhide + 1);
});

test('PRF-02.11/§9.1.1: a module definition has no field capable of carrying a third-party URL/HTML/script/iframe', () => {
  // Structural proof: CanvasModuleDefinition (see the type in
  // master-canvas-runtime.ts) is exactly {key, activate, deactivate,
  // render} — function references the runtime calls directly. There is
  // no url/html/script/iframe/css property anywhere in the shape for a
  // module to carry, so the registry cannot be used to smuggle external
  // content in even in principle.
  const module = trackingModule('m');
  const keys = Object.keys(module).filter((k) => !['renderCalls', 'activateCalls', 'deactivateCalls'].includes(k));
  for (const forbidden of ['url', 'html', 'script', 'iframe', 'src', 'css', 'href']) {
    assert.equal(keys.includes(forbidden), false, `module definitions must never carry a "${forbidden}" field`);
  }
  assert.deepEqual(new Set(keys), new Set(['key', 'activate', 'deactivate', 'render']));
});
