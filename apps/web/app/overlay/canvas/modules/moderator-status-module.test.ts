import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModeratorStatusModule, type ModeratorStatusModuleOptions } from './moderator-status-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import type { ModeratorStatus } from './moderator-status-logic';

/*
 * PRF-02 slice 5, §6 module #12 (Moderator Status Card) — HELD HALF
 * ONLY. The renderer's own cases. The zero case is the one that carries
 * a recorded product decision rather than a mechanical requirement; it
 * is asserted here in both directions (never shown at zero, and hidden
 * again when a non-zero count falls back to zero) so the decision cannot
 * quietly rot into "it happens to work".
 */

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

function mount(fetchSnapshot: () => Promise<ModeratorStatus | null>, reducedMotion = () => false) {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createModeratorStatusModule({ container, connection, fetchSnapshot, reducedMotion });
  module.activate();
  return { container, connection, module };
}

function labelText(container: HTMLElement): string {
  return (container.querySelector('[data-role="moderator-status-label"]') as HTMLElement).textContent ?? '';
}

// --- S5.16: a non-zero count shows the card ------------------------------

test('a non-zero held count shows the card and reads "N held for review"', async () => {
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', heldCount: 3, safeMode: false }));
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1');
  assert.equal(labelText(container), '3 held for review');
});

test('the rendered card names held deliveries, never chat messages, and says nothing about pausing', async () => {
  // §6's "messages held" wording predates the schema and was corrected on
  // 2026-09-16 because the underlying state is held alert DELIVERIES.
  // "paused" is forbidden for a different reason: safe mode is NOT
  // alert_queues.is_paused, and a creator must never read one as the
  // other. Asserted against the whole rendered subtree, not just the
  // label, so a decorative element cannot smuggle either word back in.
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', heldCount: 2, safeMode: false }));
  connection.fireChange();
  await flush();
  module.render(0);

  const rendered = (container.textContent ?? '').toLowerCase();
  assert.ok(rendered.includes('2 held for review'));
  for (const forbidden of ['message', 'chat', 'comment', 'paused', 'safe mode']) {
    assert.equal(rendered.includes(forbidden), false, `with safe mode off the rendered card must not contain "${forbidden}"`);
  }
});

// --- SAFE MODE, the half this completes ----------------------------------

test('safe mode ON with nothing held SHOWS the card and reads "safe mode on"', async () => {
  // Slice 5 hid the card whenever the count was zero. Safe mode changes
  // that in exactly one direction: "safe mode is on" is itself what a
  // creator needs to see, because it is the REASON nothing is reaching
  // the overlay. A silent canvas with no explanation is the failure this
  // card exists to prevent.
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', heldCount: 0, safeMode: true }));
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1', 'safe mode alone must be enough to show the card');
  assert.equal(labelText(container), 'safe mode on');
});

test('safe mode ON with a held count reads both, safe mode first', async () => {
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', heldCount: 3, safeMode: true }));
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1');
  assert.equal(labelText(container), 'safe mode on · 3 held for review');
  const rendered = (container.textContent ?? '').toLowerCase();
  for (const forbidden of ['message', 'chat', 'comment', 'paused']) {
    assert.equal(rendered.includes(forbidden), false, `the rendered card must not contain "${forbidden}"`);
  }
});

test('safe mode switching off hides the card again when nothing is held — it does not latch on', async () => {
  let safeMode = true;
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', heldCount: 0, safeMode }));
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '1');
  assert.equal(labelText(container), 'safe mode on');

  safeMode = false;
  connection.fireChange();
  await flush();
  module.render(16);
  assert.equal(container.style.opacity, '0', 'turning safe mode off with nothing held must hide the card again');
  assert.equal(labelText(container), '');
});

test('safe mode switching off while alerts are still held keeps the card up, now reading only the count', async () => {
  // This is the renderer's own view of the decision that turning safe
  // mode off releases NOTHING: the holds survive, so the card must keep
  // reporting them rather than implying the queue drained.
  let safeMode = true;
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', heldCount: 2, safeMode }));
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(labelText(container), 'safe mode on · 2 held for review');

  safeMode = false;
  connection.fireChange();
  await flush();
  module.render(16);
  assert.equal(container.style.opacity, '1', 'alerts are still held, so the card must stay up');
  assert.equal(labelText(container), '2 held for review');
});

// --- S5.15: THE ZERO CASE ------------------------------------------------

test('a held count of ZERO with safe mode OFF renders nothing visible and writes no copy at all', async () => {
  // Zero-and-off is a real, authorised answer from the server — nothing
  // is held and nothing is being held back. This module deliberately
  // says nothing about it: no "All clear", no "Nothing held", no tick.
  // Recorded in bharatstudio-requirements/active/tasks/PRF-02.md's
  // Slice 5 "Decisions" and preserved by
  // active/tasks/PRF-02-safe-mode.md's D7; asserted here so the decision
  // is enforced rather than merely written down.
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', heldCount: 0, safeMode: false }));
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '0', 'a zero held count must leave the card hidden');
  assert.equal(labelText(container), '', 'a zero held count must render no text at all');
  const rendered = (container.textContent ?? '').trim();
  assert.equal(rendered, '', 'no all-clear or celebratory copy may be rendered at zero');
});

test('a count falling back to zero hides the card again — it does not latch on', async () => {
  let held = 3;
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', heldCount: held, safeMode: false }));
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '1');
  assert.equal(labelText(container), '3 held for review');

  held = 0;
  connection.fireChange();
  await flush();
  module.render(16);
  assert.equal(container.style.opacity, '0', 'once the queue is cleared the card must hide again');
  assert.equal(labelText(container), '');
});

// --- S5.18: absent and malformed snapshots -------------------------------

test('a null snapshot renders nothing visible', async () => {
  const { container, connection, module } = mount(async () => null);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
  assert.equal(labelText(container), '');
});

test('a malformed snapshot is ignored, never thrown, never rendered', async () => {
  const malformed = [
    { schemaVersion: 'v1', heldCount: -4, safeMode: false },
    { schemaVersion: 'v1', heldCount: '7', safeMode: false },
    { schemaVersion: 'v1', heldCount: 3, safeMode: false, supporterName: 'Riya' },
    // Safe mode is NOT the queue-paused flag (owner decision,
    // 2026-09-16); that flag must never reach the card under any label.
    { schemaVersion: 'v1', heldCount: 3, safeMode: false, isPaused: true },
    // A truthy non-boolean must be refused, not coerced into "on".
    { schemaVersion: 'v1', heldCount: 3, safeMode: 'true' },
    // Half an answer is no answer: module #12 is the count AND the flag.
    { schemaVersion: 'v1', heldCount: 3 },
    { heldCount: 3, safeMode: false },
  ];
  for (const payload of malformed) {
    const { container, connection, module } = mount(async () => payload as unknown as ModeratorStatus);
    connection.fireChange();
    await flush();
    module.render(0);
    assert.equal(container.style.opacity, '0', `${JSON.stringify(payload)} must not be rendered`);
    assert.equal(labelText(container), '');
  }
});

test('a rejected fetch is swallowed and leaves the card hidden, never throwing out of render()', async () => {
  const { container, connection, module } = mount(async () => { throw new Error('synthetic network failure'); });
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
});

// --- S5.19: composite-only (PRF-03) --------------------------------------

test('composite-only: render() writes only opacity and transform', async () => {
  let held = 0;
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', heldCount: held, safeMode: false }));
  const card = () => container.querySelector('[data-role="moderator-status-card"]') as HTMLElement;

  for (const next of [0, 5, 0, 12]) {
    held = next;
    connection.fireChange();
    await flush();
    module.render(0);
    for (const layoutProp of ['width', 'height', 'top', 'left', 'right', 'bottom', 'margin', 'padding'] as const) {
      assert.equal(container.style[layoutProp], '', `render() must never write ${layoutProp} on the container`);
      assert.equal(card().style[layoutProp], '', `render() must never write ${layoutProp} on the card`);
    }
  }
  assert.ok(['translateY(0)', 'translateY(0px)'].includes(card().style.transform) || card().style.transform === 'translateY(-4px)');
});

test('prefers-reduced-motion declares no transition at all', async () => {
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', heldCount: 1, safeMode: false }), () => true);
  connection.fireChange();
  await flush();
  module.render(0);
  const card = container.querySelector('[data-role="moderator-status-card"]') as HTMLElement;
  assert.equal(card.style.transition, 'none');
});

// --- S5.20: no third-party code, no transport of its own -----------------

test('the module opens no connection and performs no fetch of its own — every read goes through the injected fetchSnapshot', async () => {
  // §9.1.1 / PRF-13: no third-party URL, HTML, script or stylesheet can
  // reach the Canvas through this module, because its options type has
  // no slot for one. Checked at compile time below, and operationally by
  // failing the test if the module ever touches global fetch.
  type HasKey<K extends string> = K extends keyof ModeratorStatusModuleOptions ? true : false;
  const urlAbsent: HasKey<'url'> = false;
  const htmlAbsent: HasKey<'html'> = false;
  const scriptAbsent: HasKey<'script'> = false;
  const apiOriginAbsent: HasKey<'apiOrigin'> = false;
  const tokenAbsent: HasKey<'token'> = false;
  assert.equal(urlAbsent, false);
  assert.equal(htmlAbsent, false);
  assert.equal(scriptAbsent, false);
  assert.equal(apiOriginAbsent, false, 'the module must never be handed an origin — it cannot open its own session');
  assert.equal(tokenAbsent, false, 'the module must never be handed an overlay token — it cannot open its own session');

  const realFetch = globalThis.fetch;
  let globalFetchCalls = 0;
  globalThis.fetch = (async () => { globalFetchCalls += 1; throw new Error('the module must not use global fetch'); }) as typeof fetch;
  try {
    let injectedCalls = 0;
    const { connection, module } = mount(async () => { injectedCalls += 1; return { schemaVersion: 'v1', heldCount: 1, safeMode: false }; });
    connection.fireChange();
    await flush();
    module.render(0);
    assert.equal(injectedCalls, 1);
    assert.equal(globalFetchCalls, 0, 'the module must never call fetch itself');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the module subscribes to the shared connection exactly once and never to its event/acknowledgement path', async () => {
  const container = document.createElement('div');
  let eventSubscriptions = 0;
  let acknowledgements = 0;
  const listeners = new Set<() => void>();
  const connection: MasterCanvasConnection = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeToEvents: () => { eventSubscriptions += 1; return () => {}; },
    acknowledge: async () => { acknowledgements += 1; return { ok: false }; },
    getOpenAttemptCount: () => 0,
    getSubscriberCount: () => listeners.size,
  };
  const module = createModeratorStatusModule({
    container, connection, fetchSnapshot: async () => ({ schemaVersion: 'v1', heldCount: 1, safeMode: false }), reducedMotion: () => false,
  });
  module.activate();
  assert.equal(listeners.size, 1, 'exactly one subscription on the shared connection');
  assert.equal(eventSubscriptions, 0, 'a snapshot module must never take Support Theater\'s event-payload path');
  assert.equal(acknowledgements, 0, 'a snapshot module must never acknowledge');
});

// --- S5.21: deactivate hygiene -------------------------------------------

test('deactivate() unsubscribes, discards a late in-flight fetch, and is idempotent', async () => {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let release: ((status: ModeratorStatus) => void) | undefined;
  const module = createModeratorStatusModule({
    container, connection,
    fetchSnapshot: () => new Promise<ModeratorStatus>((resolve) => { release = resolve; }),
    reducedMotion: () => false,
  });
  module.activate();
  assert.equal(connection.getSubscriberCount(), 1);
  connection.fireChange();
  await flush();

  module.deactivate();
  assert.equal(connection.getSubscriberCount(), 0, 'deactivate() must release the shared connection subscription');

  release?.({ schemaVersion: 'v1', heldCount: 9, safeMode: false });
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0', 'a fetch resolving after deactivate() must never be rendered');
  assert.equal(labelText(container), '');

  module.deactivate();
});

// --- S5.22: bounded DOM ---------------------------------------------------

test('bounded DOM: repeated snapshots and renders never grow the node count', async () => {
  let held = 1;
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', heldCount: held, safeMode: false }));
  connection.fireChange();
  await flush();
  module.render(0);
  const baseline = container.querySelectorAll('*').length;
  assert.ok(baseline > 0);

  for (let i = 2; i < 30; i += 1) {
    held = i % 5;
    connection.fireChange();
    await flush();
    module.render(i);
  }
  assert.equal(container.querySelectorAll('*').length, baseline, 'the module must reuse its elements, never append per update');
});

// --- the module key the runtime and the server agree on ------------------

test('the module registers under the catalogue key the server already knows (migration 0131)', async () => {
  const container = document.createElement('div');
  const module = createModeratorStatusModule({
    container, connection: fakeConnection(), fetchSnapshot: async () => null, reducedMotion: () => false,
  });
  assert.equal(module.key, 'moderator_status_card');
});
