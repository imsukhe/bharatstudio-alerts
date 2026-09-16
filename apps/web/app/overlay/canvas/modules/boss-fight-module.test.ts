import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBossFightModule } from './boss-fight-module';
import { progressPercent } from '../../widgets/goal/goal-widget-logic';
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
    schemaVersion: 'v1', goalId: '00000000-0000-4000-8000-000000000091', title: 'Boss: The Deadline',
    targetAmountPaise: 100000, window: 'open', progressPaise: 25000, reached: false, ...overrides,
  };
}

test('this task\'s §1(c): boss health is 1 - the SAME shared progressPercent(goal), never a second progress computation', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const goal = fakeGoal({ progressPaise: 25000, targetAmountPaise: 100000 });
  const module = createBossFightModule({
    container, connection, fetchSnapshot: async () => goal, reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const health = container.querySelector('[data-role="boss-fight-health"]') as HTMLElement;
  const expectedRemaining = 1 - progressPercent(goal) / 100; // the exact function goal-ladder-module.ts also calls
  assert.equal(health.style.transform, `scaleX(${expectedRemaining})`);
  assert.equal(expectedRemaining, 0.75);
});

test('progress is expressed as a transform (scaleX), never as width or height', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createBossFightModule({
    container, connection, fetchSnapshot: async () => fakeGoal({ progressPaise: 50000, targetAmountPaise: 100000 }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const health = container.querySelector('[data-role="boss-fight-health"]') as HTMLElement;
  assert.equal(health.style.width, '');
  assert.equal(health.style.height, '');
  const track = container.querySelector('[data-role="boss-fight-track"]') as HTMLElement;
  assert.ok(track.style.height.length > 0, 'the track\'s own static height, set once, is not an animation');
});

test('title and amounts render from the fetched goal snapshot', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createBossFightModule({
    container, connection,
    fetchSnapshot: async () => fakeGoal({ title: 'Boss: Server Costs', progressPaise: 250000, targetAmountPaise: 1000000, reached: false }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.querySelector('[data-role="boss-fight-title"]')?.textContent, 'Boss: Server Costs');
  const amounts = container.querySelector('[data-role="boss-fight-amounts"]')?.textContent ?? '';
  assert.ok(amounts.includes('₹2,500'));
  assert.ok(amounts.includes('₹10,000'));
});

test('a reached goal shows "Boss defeated" and zero remaining health', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createBossFightModule({
    container, connection,
    fetchSnapshot: async () => fakeGoal({ progressPaise: 100000, targetAmountPaise: 100000, reached: true }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const health = container.querySelector('[data-role="boss-fight-health"]') as HTMLElement;
  assert.equal(health.style.transform, 'scaleX(0)');
  assert.ok(container.querySelector('[data-role="boss-fight-amounts"]')?.textContent?.includes('Boss defeated'));
});

test('no goal configured yet renders nothing visible', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createBossFightModule({ container, connection, fetchSnapshot: async () => null, reducedMotion: () => false });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
});

test('a malformed goal payload degrades to "no boss", never thrown', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createBossFightModule({
    container, connection,
    // @ts-expect-error -- deliberately malformed to prove the module's own isOverlayGoal guard protects rendering
    fetchSnapshot: async () => ({ not: 'a real goal' }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  assert.doesNotThrow(() => module.render(0));
  assert.equal(container.style.opacity, '0');
});

test('prefers-reduced-motion disables the health transition', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createBossFightModule({ container, connection, fetchSnapshot: async () => null, reducedMotion: () => true });
  module.activate();
  const health = container.querySelector('[data-role="boss-fight-health"]') as HTMLElement;
  assert.equal(health.style.transition, 'none');
});

test('deactivate unsubscribes and discards a late in-flight fetch, and is idempotent', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let resolveSlowFetch: ((value: OverlayGoal | null) => void) | undefined;
  const module = createBossFightModule({
    container, connection,
    fetchSnapshot: () => new Promise((resolve) => { resolveSlowFetch = resolve; }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.deactivate();
  module.deactivate(); // idempotent
  assert.equal(connection.getSubscriberCount(), 0);
  resolveSlowFetch?.(fakeGoal());
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0', 'a late fetch after deactivation must never populate the boss bar');
});
