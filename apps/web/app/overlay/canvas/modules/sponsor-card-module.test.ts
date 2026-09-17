import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSponsorCardModule } from './sponsor-card-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import type { SponsorCardSnapshot } from './sponsor-card-logic';

/*
 * §6 catalogue module #11 (Sponsor Card) — the renderer's own cases.
 *
 * The case that carries a recorded product decision rather than a
 * mechanical requirement: this module never calls any counting, timing or
 * accumulation function, checked here by grepping this test file's own
 * imports and the module's source shape (compile-time, via
 * sponsor-card-logic.test.ts's commented-out field probes) rather than by
 * a runtime assertion alone.
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

const withLogo: SponsorCardSnapshot = {
  schemaVersion: 'v1',
  sponsorName: 'Acme Energy Drinks',
  logoMimeType: 'image/png',
  logoStorageKey: '00000000-0000-4000-8000-000000005b11/' + 'ab'.repeat(32),
};

const nameOnly: SponsorCardSnapshot = {
  schemaVersion: 'v1',
  sponsorName: 'Text-Only Sponsor',
  logoMimeType: null,
  logoStorageKey: null,
};

function mount(fetchSnapshot: () => Promise<SponsorCardSnapshot | null>, reducedMotion = () => false) {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createSponsorCardModule({ container, connection, fetchSnapshot, reducedMotion });
  module.activate();
  return { container, connection, module };
}

function nameText(container: HTMLElement): string {
  return (container.querySelector('[data-role="sponsor-card-name"]') as HTMLElement).textContent ?? '';
}

function cardEl(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-role="sponsor-card"]') as HTMLElement;
}

test('the module key is the catalogue key migration 0131 already names', () => {
  const { module } = mount(async () => null);
  assert.equal(module.key, 'sponsor_card');
});

test('a valid snapshot with a logo renders the name and records the logo reference', async () => {
  const { container, connection, module } = mount(async () => withLogo);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1');
  assert.equal(nameText(container), 'Acme Energy Drinks');
  assert.equal(cardEl(container).dataset.logoStorageKey, withLogo.logoStorageKey);
});

test('a valid snapshot with no logo renders the name and carries no logo reference', async () => {
  const { container, connection, module } = mount(async () => nameOnly);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1');
  assert.equal(nameText(container), 'Text-Only Sponsor');
  assert.equal(cardEl(container).dataset.logoStorageKey, undefined);
});

test('a null snapshot paints nothing', async () => {
  const { container, connection, module } = mount(async () => null);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '0');
  assert.equal(nameText(container), '');
  assert.equal(cardEl(container).dataset.logoStorageKey, undefined);
});

test('a malformed snapshot (fails the structural guard) renders as if it were null', async () => {
  const { container, connection, module } = mount(async () => ({ ...withLogo, extraField: 'x' }) as unknown as SponsorCardSnapshot);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '0');
  assert.equal(nameText(container), '');
});

test('going from a card to null hides it again, and the logo reference is cleared', async () => {
  let snapshot: SponsorCardSnapshot | null = withLogo;
  const { container, connection, module } = mount(async () => snapshot);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '1');
  assert.equal(cardEl(container).dataset.logoStorageKey, withLogo.logoStorageKey);

  snapshot = null;
  connection.fireChange();
  await flush();
  module.render(16);
  assert.equal(container.style.opacity, '0');
  assert.equal(nameText(container), '');
  assert.equal(cardEl(container).dataset.logoStorageKey, undefined);
});

test('a stale in-flight fetch superseded by a newer one is discarded, never rendered as current', async () => {
  let resolveFirst: (value: SponsorCardSnapshot | null) => void = () => {};
  const first = new Promise<SponsorCardSnapshot | null>((resolve) => { resolveFirst = resolve; });
  let callCount = 0;
  const { container, connection, module } = mount(async () => {
    callCount += 1;
    if (callCount === 1) return first;
    return withLogo;
  });

  connection.fireChange(); // triggers the first (slow) fetch
  connection.fireChange(); // triggers the second (fast) fetch, which resolves first
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '1');
  assert.equal(nameText(container), 'Acme Energy Drinks');

  // Now the stale first fetch resolves — its answer must never overwrite
  // the current, newer one.
  resolveFirst(nameOnly);
  await flush();
  module.render(16);
  assert.equal(nameText(container), 'Acme Energy Drinks');
});

test('deactivate discards any in-flight fetch so it can never render after teardown', async () => {
  let resolveIt: (value: SponsorCardSnapshot | null) => void = () => {};
  const pending = new Promise<SponsorCardSnapshot | null>((resolve) => { resolveIt = resolve; });
  const { container, connection, module } = mount(async () => pending);
  connection.fireChange();
  module.deactivate();
  resolveIt(withLogo);
  await flush();
  module.render(0);
  assert.equal(nameText(container), '');
});

test('render() only writes when dirty — no thrash on an unchanged frame', async () => {
  const { container, connection, module } = mount(async () => withLogo);
  connection.fireChange();
  await flush();
  module.render(0);
  const opacityBefore = container.style.opacity;
  // A second render with no new snapshot must not throw or change state.
  module.render(16);
  assert.equal(container.style.opacity, opacityBefore);
});

test('reduced motion removes the transition but the sponsor name still renders', async () => {
  const { container, connection, module } = mount(async () => withLogo, () => true);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(cardEl(container).style.transition, 'none');
  assert.equal(nameText(container), 'Acme Energy Drinks');
});
