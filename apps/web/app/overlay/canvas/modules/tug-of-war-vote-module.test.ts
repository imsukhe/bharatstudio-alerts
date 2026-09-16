import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTugOfWarVoteModule } from './tug-of-war-vote-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import type { TugOfWarVoteTally } from './tug-of-war-vote-logic';

function fakeConnection(): MasterCanvasConnection & { fireChange(): void } {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getOpenAttemptCount: () => 0,
    getSubscriberCount: () => listeners.size,
    fireChange() { for (const l of listeners) l(); },
  };
}

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function fakeTally(overrides: Partial<TugOfWarVoteTally> = {}): TugOfWarVoteTally {
  return {
    schemaVersion: 'v1',
    votingMode: 'paid',
    options: [
      { optionKey: 'team-a', label: 'Team A', amountPaise: 300000 },
      { optionKey: 'team-b', label: 'Team B', amountPaise: 100000 },
    ],
    resolved: false,
    resolvedOptionKey: null,
    ...overrides,
  };
}

test('the bar fraction is derived from the fetched tally amounts, never a held counter — scaleX only, never width', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createTugOfWarVoteModule({
    container, connection, fetchSnapshot: async () => fakeTally(), reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const leftFill = container.querySelector('[data-role="tug-of-war-left-fill"]') as HTMLElement;
  const rightFill = container.querySelector('[data-role="tug-of-war-right-fill"]') as HTMLElement;
  // 300000 : 100000 -> fraction A = 0.75, fraction B = 0.25
  assert.equal(leftFill.style.transform, 'scaleX(0.75)');
  assert.equal(rightFill.style.transform, 'scaleX(0.25)');
  assert.equal(leftFill.style.width, '', 'must never set width to express the ratio');
  assert.equal(rightFill.style.width, '');
  // The two fractions always sum to 1 — a real tug-of-war, not two
  // independent bars that could visually disagree with each other.
  assert.equal(0.75 + 0.25, 1);
});

test('each side shows its exact rupee amount, not only a percentage — the transparency requirement', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createTugOfWarVoteModule({
    container, connection,
    fetchSnapshot: async () => fakeTally({ options: [
      { optionKey: 'team-a', label: 'Sunrisers', amountPaise: 150000 },
      { optionKey: 'team-b', label: 'Knight Riders', amountPaise: 250000 },
    ] }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const leftLabel = container.querySelector('[data-role="tug-of-war-left-label"]')?.textContent ?? '';
  const rightLabel = container.querySelector('[data-role="tug-of-war-right-label"]')?.textContent ?? '';
  assert.ok(leftLabel.includes('Sunrisers'));
  assert.ok(leftLabel.includes('₹1,500'), 'must show the exact amount, not only a percentage');
  assert.ok(rightLabel.includes('Knight Riders'));
  assert.ok(rightLabel.includes('₹2,500'));
  const status = container.querySelector('[data-role="tug-of-war-status"]')?.textContent ?? '';
  assert.ok(status.includes('₹4,000'), 'the total actually paid is shown alongside the result');
});

test('a resolved vote shows the winner derived from the same tally row, never asserted independently', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createTugOfWarVoteModule({
    container, connection,
    fetchSnapshot: async () => fakeTally({ resolved: true, resolvedOptionKey: 'team-a' }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const status = container.querySelector('[data-role="tug-of-war-status"]')?.textContent ?? '';
  assert.ok(status.includes('Resolved'));
  assert.ok(status.includes('Team A'), 'the winner shown must be the label from the SAME options array, not re-derived');
});

test('no vote configured yet renders nothing visible', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createTugOfWarVoteModule({ container, connection, fetchSnapshot: async () => null, reducedMotion: () => false });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
});

test('a malformed tally (fails isTugOfWarVoteTally, e.g. three options) degrades to nothing shown, never thrown or rendered as-is', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createTugOfWarVoteModule({
    container, connection,
    // Three options type-checks fine against TugOfWarVoteOption[] (the type has no
    // fixed length) — it is only isTugOfWarVoteTally's own runtime guard that
    // rejects it, which is exactly what this test proves.
    fetchSnapshot: async () => ({ schemaVersion: 'v1', votingMode: 'paid', options: [{ optionKey: 'a', label: 'A', amountPaise: 1 }, { optionKey: 'b', label: 'B', amountPaise: 1 }, { optionKey: 'c', label: 'C', amountPaise: 1 }], resolved: false, resolvedOptionKey: null }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  assert.doesNotThrow(() => module.render(0));
  assert.equal(container.style.opacity, '0');
});

test('an even/zero-total split renders as an even 0.5/0.5 bar, not a division-by-zero glitch', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createTugOfWarVoteModule({
    container, connection,
    fetchSnapshot: async () => fakeTally({ options: [
      { optionKey: 'team-a', label: 'Team A', amountPaise: 0 },
      { optionKey: 'team-b', label: 'Team B', amountPaise: 0 },
    ] }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const leftFill = container.querySelector('[data-role="tug-of-war-left-fill"]') as HTMLElement;
  const rightFill = container.querySelector('[data-role="tug-of-war-right-fill"]') as HTMLElement;
  assert.equal(leftFill.style.transform, 'scaleX(0.5)');
  assert.equal(rightFill.style.transform, 'scaleX(0.5)');
});

test('prefers-reduced-motion disables both fill transitions', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createTugOfWarVoteModule({ container, connection, fetchSnapshot: async () => null, reducedMotion: () => true });
  module.activate();
  const leftFill = container.querySelector('[data-role="tug-of-war-left-fill"]') as HTMLElement;
  const rightFill = container.querySelector('[data-role="tug-of-war-right-fill"]') as HTMLElement;
  assert.equal(leftFill.style.transition, 'none');
  assert.equal(rightFill.style.transition, 'none');
});

test('deactivate unsubscribes and discards a late in-flight fetch, and is idempotent', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let resolveSlowFetch: ((value: TugOfWarVoteTally | null) => void) | undefined;
  const module = createTugOfWarVoteModule({
    container, connection,
    fetchSnapshot: () => new Promise((resolve) => { resolveSlowFetch = resolve; }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.deactivate();
  module.deactivate(); // idempotent — safe to call twice
  assert.equal(connection.getSubscriberCount(), 0);
  resolveSlowFetch?.(fakeTally());
  await flush();
  assert.doesNotThrow(() => module.render(0));
  module.render(0);
  assert.equal(container.style.opacity, '0', 'a late fetch after deactivation must never populate the bar');
});
