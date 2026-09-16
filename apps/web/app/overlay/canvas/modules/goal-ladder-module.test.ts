import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoalLadderModule } from './goal-ladder-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import type { OverlayGoal } from '../../widgets/goal/goal-widget-logic';

function fakeConnection(): MasterCanvasConnection & { fireChange(): void } {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
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

function fakeGoal(overrides: Partial<OverlayGoal> = {}): OverlayGoal {
  return {
    schemaVersion: 'v1', goalId: '00000000-0000-4000-8000-000000000091', title: 'New PC fund',
    targetAmountPaise: 100000, window: 'open', progressPaise: 25000, reached: false, ...overrides,
  };
}

test('progress is expressed as a transform (scaleX), never as width — the exact PRF-03 correction against the existing standalone widget', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createGoalLadderModule({
    container, connection, fetchSnapshot: async () => fakeGoal({ progressPaise: 25000, targetAmountPaise: 100000 }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const fill = container.querySelector('[data-role="goal-ladder-fill"]') as HTMLElement;
  assert.equal(fill.style.transform, 'scaleX(0.25)');
  assert.equal(fill.style.width, '', 'must never set width to express progress');
  assert.equal(fill.style.height, '');
  const track = container.querySelector('[data-role="goal-ladder-track"]') as HTMLElement;
  // The track's own height is a STATIC size set once at creation, not an
  // animated one — PRF-03 forbids animating a layout property, not
  // declaring a fixed one.
  assert.ok(track.style.height.length > 0);
});

test('title and formatted amounts render from the fetched snapshot', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createGoalLadderModule({
    container, connection,
    fetchSnapshot: async () => fakeGoal({ title: 'Diwali stream fund', progressPaise: 250000, targetAmountPaise: 1000000, reached: false }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.querySelector('[data-role="goal-ladder-title"]')?.textContent, 'Diwali stream fund');
  const amounts = container.querySelector('[data-role="goal-ladder-amounts"]')?.textContent ?? '';
  assert.ok(amounts.includes('₹2,500'));
  assert.ok(amounts.includes('₹10,000'));
  assert.equal(container.style.opacity, '1');
});

test('no goal configured yet renders nothing visible, not a broken/zero-progress bar', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createGoalLadderModule({ container, connection, fetchSnapshot: async () => null, reducedMotion: () => false });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
});

test('a malformed goal payload (fails isOverlayGoal) degrades to "no goal", never thrown or rendered as-is', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createGoalLadderModule({
    container, connection,
    // @ts-expect-error -- deliberately malformed to prove the module's own isOverlayGoal guard, not the fetcher's type, is what protects rendering
    fetchSnapshot: async () => ({ not: 'a real goal' }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  assert.doesNotThrow(() => module.render(0));
  assert.equal(container.style.opacity, '0');
});

test('prefers-reduced-motion disables the fill transition', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createGoalLadderModule({ container, connection, fetchSnapshot: async () => null, reducedMotion: () => true });
  module.activate();
  const fill = container.querySelector('[data-role="goal-ladder-fill"]') as HTMLElement;
  assert.equal(fill.style.transition, 'none');
});

test('deactivate unsubscribes and discards a late in-flight fetch', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let resolveSlowFetch: ((value: OverlayGoal | null) => void) | undefined;
  const module = createGoalLadderModule({
    container, connection,
    fetchSnapshot: () => new Promise((resolve) => { resolveSlowFetch = resolve; }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.deactivate();
  assert.equal(connection.getSubscriberCount(), 0);
  resolveSlowFetch?.(fakeGoal());
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0', 'a late fetch after deactivation must never populate the goal bar');
});
