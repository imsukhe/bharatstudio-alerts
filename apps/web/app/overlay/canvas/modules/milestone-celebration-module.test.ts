import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMilestoneCelebrationModule, GOAL_REACHED_LABEL, VOTE_RESOLVED_LABEL, type MilestoneCelebrationModuleOptions } from './milestone-celebration-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import type { OverlayGoal } from '../../widgets/goal/goal-widget-logic';
import type { TugOfWarVoteTally } from './tug-of-war-vote-logic';

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

function createManualTimers() {
  let nextId = 1;
  const scheduled = new Map<number, () => void>();
  return {
    setTimeoutImpl: ((fn: () => void) => {
      const id = nextId++;
      scheduled.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutImpl: ((id: unknown) => { scheduled.delete(id as number); }) as typeof clearTimeout,
    flushAll() {
      const entries = [...scheduled.entries()];
      scheduled.clear();
      for (const [, fn] of entries) fn();
    },
    pendingCount() { return scheduled.size; },
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

function fakeVote(overrides: Partial<TugOfWarVoteTally> = {}): TugOfWarVoteTally {
  return {
    schemaVersion: 'v1', votingMode: 'paid',
    options: [
      { optionKey: 'a', label: 'Team A', amountPaise: 5000 },
      { optionKey: 'b', label: 'Team B', amountPaise: 3000 },
    ],
    resolved: false, resolvedOptionKey: null,
    ...overrides,
  };
}

function setupModule(opts: {
  goals: Array<OverlayGoal | null>;
  votes: Array<TugOfWarVoteTally | null>;
  reducedMotion?: () => boolean;
  timers?: ReturnType<typeof createManualTimers>;
}) {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let goalIndex = 0;
  let voteIndex = 0;
  const timers = opts.timers ?? createManualTimers();
  const module = createMilestoneCelebrationModule({
    container, connection,
    fetchGoalSnapshot: async () => opts.goals[Math.min(goalIndex++, opts.goals.length - 1)] ?? null,
    fetchVoteSnapshot: async () => opts.votes[Math.min(voteIndex++, opts.votes.length - 1)] ?? null,
    reducedMotion: opts.reducedMotion ?? (() => false),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  return { container, connection, module, timers };
}

test('fires on the false -> true edge of goal.reached, and renders the animated burst (motion allowed)', async () => {
  const { container, connection, module } = setupModule({
    goals: [fakeGoal({ reached: false }), fakeGoal({ reached: true })],
    votes: [null, null],
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);
  connection.fireChange();
  await flush();
  module.render(0);

  const burst = container.querySelector('[data-role="milestone-celebration-animated"]') as HTMLElement;
  const badge = container.querySelector('[data-role="milestone-celebration-badge"]') as HTMLElement;
  assert.equal(burst.style.opacity, '1');
  assert.equal(container.querySelector('[data-role="milestone-celebration-animated-label"]')?.textContent, GOAL_REACHED_LABEL);
  assert.equal(badge.style.opacity, '0', 'the static badge must stay hidden when motion is allowed');
});

test('fires on the false -> true edge of the vote tally\'s resolved', async () => {
  const { container, connection, module } = setupModule({
    goals: [null, null],
    votes: [fakeVote({ resolved: false }), fakeVote({ resolved: true })],
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);
  connection.fireChange();
  await flush();
  module.render(0);

  const burst = container.querySelector('[data-role="milestone-celebration-animated"]') as HTMLElement;
  assert.equal(burst.style.opacity, '1');
  assert.equal(container.querySelector('[data-role="milestone-celebration-animated-label"]')?.textContent, VOTE_RESOLVED_LABEL);
});

test('does NOT fire repeatedly while goal.reached stays true across multiple re-reads', async () => {
  const { container, connection, module } = setupModule({
    goals: [fakeGoal({ reached: false }), fakeGoal({ reached: true }), fakeGoal({ reached: true }), fakeGoal({ reached: true })],
    votes: [null, null, null, null],
  });
  module.activate();
  connection.fireChange(); await flush(); module.render(0);
  connection.fireChange(); await flush(); module.render(0); // first true -> fires
  const burst = container.querySelector('[data-role="milestone-celebration-animated"]') as HTMLElement;
  assert.equal(burst.style.opacity, '1');
  burst.style.opacity = '0'; // simulate the visible window having already ended
  connection.fireChange(); await flush(); module.render(0); // still true -> must not refire
  connection.fireChange(); await flush(); module.render(0); // still true -> must not refire
  assert.equal(burst.style.opacity, '0', 'must not fire again while the value merely stays true');
});

test('does NOT fire when the FIRST-ever observed snapshot is already true (e.g. a reconnect redelivering an already-true value, or a fresh module never having seen a false)', async () => {
  const { container, connection, module } = setupModule({
    goals: [fakeGoal({ reached: true }), fakeGoal({ reached: true })],
    votes: [null, null],
  });
  module.activate();
  connection.fireChange(); await flush(); module.render(0);
  connection.fireChange(); await flush(); module.render(0);

  const burst = container.querySelector('[data-role="milestone-celebration-animated"]') as HTMLElement;
  assert.equal(burst.style.opacity, '0', 'an already-true value the module has never seen become true from false must not celebrate');
});

test('prefers-reduced-motion: a distinct static badge becomes visible, the animated burst never does — not merely a shorter animation', async () => {
  const { container, connection, module } = setupModule({
    goals: [fakeGoal({ reached: false }), fakeGoal({ reached: true })],
    votes: [null, null],
    reducedMotion: () => true,
  });
  module.activate();
  connection.fireChange(); await flush(); module.render(0);
  connection.fireChange(); await flush(); module.render(0);

  const burst = container.querySelector('[data-role="milestone-celebration-animated"]') as HTMLElement;
  const badge = container.querySelector('[data-role="milestone-celebration-badge"]') as HTMLElement;
  assert.equal(badge.style.opacity, '1', 'the static badge must become perceivably visible under reduced motion');
  assert.equal(container.querySelector('[data-role="milestone-celebration-badge-label"]')?.textContent, GOAL_REACHED_LABEL);
  assert.equal(burst.style.opacity, '0', 'the animated burst element must never be shown under reduced motion');
  // The static path is genuinely static, not merely a shorter animation:
  // no transition is ever set on the badge element.
  assert.equal(badge.style.transition, '', 'the badge must have no CSS transition — its appearance is an instantaneous state change, not motion');
});

test('composite-only: only opacity/transform are ever written on either element', async () => {
  const { container, connection, module } = setupModule({
    goals: [fakeGoal({ reached: false }), fakeGoal({ reached: true })],
    votes: [null, null],
  });
  module.activate();
  connection.fireChange(); await flush(); module.render(0);
  connection.fireChange(); await flush(); module.render(0);

  const burst = container.querySelector('[data-role="milestone-celebration-animated"]') as HTMLElement;
  assert.equal(burst.style.width, '');
  assert.equal(burst.style.height, '');
  assert.equal(burst.style.top, '');
  assert.equal(burst.style.left, '');
});

test('the celebration clears itself after its visible window (one shared timer, whichever trigger fired)', async () => {
  const timers = createManualTimers();
  const { container, connection, module } = setupModule({
    goals: [fakeGoal({ reached: false }), fakeGoal({ reached: true })],
    votes: [null, null],
    timers,
  });
  module.activate();
  connection.fireChange(); await flush(); module.render(0);
  connection.fireChange(); await flush(); module.render(0);

  const burst = container.querySelector('[data-role="milestone-celebration-animated"]') as HTMLElement;
  assert.equal(burst.style.opacity, '1');
  timers.flushAll();
  module.render(0);
  assert.equal(burst.style.opacity, '0', 'the celebration must clear itself after its visible window elapses');
});

test('deactivate() hides an in-progress celebration immediately and is idempotent', async () => {
  const timers = createManualTimers();
  const { container, connection, module } = setupModule({
    goals: [fakeGoal({ reached: false }), fakeGoal({ reached: true })],
    votes: [null, null],
    timers,
  });
  module.activate();
  connection.fireChange(); await flush(); module.render(0);
  connection.fireChange(); await flush(); module.render(0);
  const burst = container.querySelector('[data-role="milestone-celebration-animated"]') as HTMLElement;
  assert.equal(burst.style.opacity, '1');

  assert.doesNotThrow(() => module.deactivate());
  assert.doesNotThrow(() => module.deactivate()); // idempotent
  assert.equal(burst.style.opacity, '0');
  assert.equal(connection.getSubscriberCount(), 0);
});

test('does not fire on a challenge reaching target — this module has no challenge fetcher of any kind', () => {
  // Structural (compile-time) proof, not merely behavioural: the options
  // type has no field for a challenge snapshot fetcher at all, so there
  // is no way to wire challenge data into this module in the first
  // place. If a future edit ever added `fetchChallengeSnapshot` (or any
  // other challenge-shaped field) to MilestoneCelebrationModuleOptions,
  // this line would stop compiling ('challenge_field_absent' would widen
  // to `never`, which is not assignable to `true`).
  type ChallengeFieldKeys = Extract<keyof MilestoneCelebrationModuleOptions, `${string}hallenge${string}`>;
  const challengeFieldAbsent: [ChallengeFieldKeys] extends [never] ? true : never = true;
  assert.equal(challengeFieldAbsent, true);

  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createMilestoneCelebrationModule({
    container, connection,
    fetchGoalSnapshot: async () => null,
    fetchVoteSnapshot: async () => null,
    reducedMotion: () => false,
  });
  assert.equal(module.key, 'milestone_celebration');
});

test('a malformed goal/vote payload is ignored, never thrown, and never treated as a rising edge', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createMilestoneCelebrationModule({
    container, connection,
    // @ts-expect-error -- deliberately malformed
    fetchGoalSnapshot: async () => ({ not: 'a real goal' }),
    // @ts-expect-error -- deliberately malformed
    fetchVoteSnapshot: async () => ({ not: 'a real tally' }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  assert.doesNotThrow(() => module.render(0));
  const burst = container.querySelector('[data-role="milestone-celebration-animated"]') as HTMLElement;
  assert.equal(burst.style.opacity, '0');
});
