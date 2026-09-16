import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChallengeBoardModule } from './challenge-board-module';
import { CHALLENGE_FAILURE_COPY, type OverlayChallenge } from '../../widgets/challenge/challenge-widget-logic';
import type { MasterCanvasConnection } from '../master-canvas-connection';

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

function fakeChallenge(overrides: Partial<OverlayChallenge> = {}): OverlayChallenge {
  return {
    schemaVersion: 'v1', challengeId: '00000000-0000-4000-8000-000000000041', title: '100 pushups if we hit ₹5,000',
    kind: 'stake', targetAmountPaise: 500000, state: 'active', progressPaise: 125000, targetReached: false,
    ...overrides,
  };
}

test('current-only: title, state and progress render from the single fetched snapshot — no next/completed field exists anywhere in this module', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createChallengeBoardModule({
    container, connection,
    fetchSnapshot: async () => fakeChallenge({ title: 'Shave head at ₹10,000', progressPaise: 250000, targetAmountPaise: 1000000 }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.querySelector('[data-role="challenge-board-title"]')?.textContent, 'Shave head at ₹10,000');
  assert.equal(container.querySelector('[data-role="challenge-board-state"]')?.textContent, 'In progress');
  const amounts = container.querySelector('[data-role="challenge-board-amounts"]')?.textContent ?? '';
  assert.ok(amounts.includes('₹2,500'));
  assert.ok(amounts.includes('₹10,000'));
  assert.equal(container.style.opacity, '1');
});

test('progress is expressed as a transform (scaleX), never as width — corrects the standalone widget\'s own width-transition pattern (PRF-03)', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createChallengeBoardModule({
    container, connection,
    fetchSnapshot: async () => fakeChallenge({ progressPaise: 250000, targetAmountPaise: 500000 }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const fill = container.querySelector('[data-role="challenge-board-fill"]') as HTMLElement;
  assert.equal(fill.style.transform, 'scaleX(0.5)');
  assert.equal(fill.style.width, '', 'must never set width to express progress');
});

test('a draft challenge renders nothing visible, matching the standalone widget\'s own isWidgetVisible rule', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createChallengeBoardModule({
    container, connection, fetchSnapshot: async () => fakeChallenge({ state: 'draft' }), reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
});

test('no challenge configured renders nothing visible', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createChallengeBoardModule({ container, connection, fetchSnapshot: async () => null, reducedMotion: () => false });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
});

test('a succeeded challenge shows a plain state label and NO refund-adjacent language anywhere', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createChallengeBoardModule({
    container, connection, fetchSnapshot: async () => fakeChallenge({ state: 'succeeded', progressPaise: 500000 }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.querySelector('[data-role="challenge-board-state"]')?.textContent, 'Succeeded!');
  const copyEl = container.querySelector('[data-role="challenge-board-failure-copy"]') as HTMLElement;
  assert.equal(copyEl.style.opacity, '0');
  assert.equal(copyEl.textContent, '');
  const fullText = container.textContent ?? '';
  assert.ok(!/refund|reversal|escrow|funds held/i.test(fullText), `succeeded challenge output must never mention refund/reversal/escrow/funds-held: "${fullText}"`);
});

for (const state of ['failed', 'cancelled'] as const) {
  test(`a ${state} challenge shows CHALLENGE_FAILURE_COPY verbatim, and it is the ONLY refund-adjacent text present (§15.4.2)`, async () => {
    const container = document.createElement('div');
    const connection = fakeConnection();
    const module = createChallengeBoardModule({
      container, connection, fetchSnapshot: async () => fakeChallenge({ state, progressPaise: 200000 }),
      reducedMotion: () => false,
    });
    module.activate();
    connection.fireChange();
    await flush();
    module.render(0);

    const copyEl = container.querySelector('[data-role="challenge-board-failure-copy"]') as HTMLElement;
    assert.equal(copyEl.textContent, CHALLENGE_FAILURE_COPY);
    assert.equal(copyEl.style.opacity, '1');

    // The copy itself is the ONLY place refund-adjacent words appear —
    // strip it out and assert nothing else in the rendered card mentions
    // refund/reversal/escrow/funds-held (e.g. no "Refunded" state label,
    // no punitive framing added anywhere else).
    const fullText = container.textContent ?? '';
    const withoutCopy = fullText.replace(CHALLENGE_FAILURE_COPY, '');
    assert.ok(!/refund|reversal|escrow|funds held/i.test(withoutCopy), `only the sanctioned copy may mention refund/reversal/escrow/funds-held; found elsewhere in: "${withoutCopy}"`);
  });
}

test('the protected copy cannot be overridden — no option field exists for it, and an unrelated/extra option can never substitute for it', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createChallengeBoardModule({
    container, connection, fetchSnapshot: async () => fakeChallenge({ state: 'failed' }),
    reducedMotion: () => false,
    // Deliberately pass an option this module's type does not define, to
    // prove at the call site (not only by the type signature) that no
    // hidden override path exists — the module simply never reads it.
    // @ts-expect-error -- proving no such option is ever consulted
    failureCopyOverride: 'You will get your money back, guaranteed.',
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.render(0);

  const copyEl = container.querySelector('[data-role="challenge-board-failure-copy"]') as HTMLElement;
  assert.equal(copyEl.textContent, CHALLENGE_FAILURE_COPY, 'the rendered copy must be exactly the protected sentence, never an override');
});

test('deactivate unsubscribes and discards a late in-flight fetch', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let resolveSlowFetch: ((value: OverlayChallenge | null) => void) | undefined;
  const module = createChallengeBoardModule({
    container, connection,
    fetchSnapshot: () => new Promise((resolve) => { resolveSlowFetch = resolve; }),
    reducedMotion: () => false,
  });
  module.activate();
  connection.fireChange();
  await flush();
  module.deactivate();
  assert.equal(connection.getSubscriberCount(), 0);
  resolveSlowFetch?.(fakeChallenge());
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0', 'a late fetch after deactivation must never populate the board');
});

test('prefers-reduced-motion disables the fill transition', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createChallengeBoardModule({ container, connection, fetchSnapshot: async () => null, reducedMotion: () => true });
  module.activate();
  const fill = container.querySelector('[data-role="challenge-board-fill"]') as HTMLElement;
  assert.equal(fill.style.transition, 'none');
});
