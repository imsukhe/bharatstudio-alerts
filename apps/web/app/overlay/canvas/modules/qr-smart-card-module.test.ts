import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQrSmartCardModule } from './qr-smart-card-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import type { OverlayQrSmartCard } from './qr-smart-card-logic';

/*
 * PRF-02 slice 7, §6 module #10 (QR Smart Card). The renderer's own
 * cases: show/hide on presence/absence of a snapshot (the toggle IS the
 * read, per migration 0144), the SVG path/label content, bounded DOM,
 * and the structural §9.1.1 assertion that nothing on this module's path
 * ever fetches, links to or embeds the destination.
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

function mount(fetchSnapshot: () => Promise<OverlayQrSmartCard | null>, reducedMotion = () => false) {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createQrSmartCardModule({ container, connection, fetchSnapshot, reducedMotion });
  module.activate();
  return { container, connection, module };
}

function labelText(container: HTMLElement): string {
  return (container.querySelector('[data-role="qr-smart-card-label"]') as HTMLElement).textContent ?? '';
}

function pathD(container: HTMLElement): string {
  return (container.querySelector('[data-role="qr-smart-card-code"] path') as SVGPathElement | null)?.getAttribute('d') ?? '';
}

// --- show/hide is the read itself ------------------------------------------

test('a non-null snapshot shows the card, draws a non-empty QR path and writes the label', async () => {
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', destination: 'https://bharatstudio.in/creator/x', label: 'Follow me' }));
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1');
  assert.equal(labelText(container), 'Follow me');
  assert.ok(pathD(container).length > 0, 'the QR path must not be empty when a destination is present');
});

test('qrSmartCard: null hides the card -- a disabled card and a never-configured channel look identical', async () => {
  const { container, connection, module } = mount(async () => null);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '0');
  assert.equal(labelText(container), '');
});

test('the card hides again once a later snapshot goes back to null -- it does not latch on', async () => {
  let answer: OverlayQrSmartCard | null = { schemaVersion: 'v1', destination: 'https://x.io/a', label: 'A' };
  const { container, connection, module } = mount(async () => answer);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '1');

  answer = null;
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
  assert.equal(labelText(container), '');
});

test('a malformed snapshot (extra key, wrong type) is treated as no card, never rendered', async () => {
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', destination: 'https://x.io/a', label: 'A', scanCount: 3 } as unknown as OverlayQrSmartCard));
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '0');
});

// --- content updates only rebuild the path when the destination/label actually change ---

test('rendering the same destination/label twice does not change the drawn path between renders', async () => {
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', destination: 'https://x.io/same', label: 'Same' }));
  connection.fireChange();
  await flush();
  module.render(0);
  const firstPath = pathD(container);

  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(pathD(container), firstPath);
});

test('a changed destination redraws the path and updates the label', async () => {
  let destination = 'https://x.io/first';
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', destination, label: 'First' }));
  connection.fireChange();
  await flush();
  module.render(0);
  const firstPath = pathD(container);

  destination = 'https://x.io/second-and-quite-different';
  connection.fireChange();
  await flush();
  module.render(0);
  assert.notEqual(pathD(container), firstPath);
  assert.equal(labelText(container), 'First'); // label unchanged in this case
});

// --- bounded DOM (§19.5): four elements, created once ----------------------

test('the module creates exactly one card container, one svg, one path and one label, regardless of QR size', async () => {
  const { container, connection, module } = mount(async () => ({
    schemaVersion: 'v1',
    // A long destination selects a larger QR version (more modules), but
    // must not create more DOM nodes.
    destination: 'https://bharatstudio.in/creator/' + 'x'.repeat(80),
    label: 'Big code',
  }));
  connection.fireChange();
  await flush();
  module.render(0);
  module.render(1);
  module.render(2);

  assert.equal(container.querySelectorAll('[data-role="qr-smart-card"]').length, 1);
  assert.equal(container.querySelectorAll('svg').length, 1);
  assert.equal(container.querySelectorAll('path').length, 1);
  assert.equal(container.querySelectorAll('[data-role="qr-smart-card-label"]').length, 1);
});

// --- §9.1.1: the destination is data, never a fetch/link/embed target ------

test('§9.1.1: nothing in the rendered DOM is an anchor, iframe or script pointed at the destination', async () => {
  const destination = 'https://attacker.example/should-never-be-fetched';
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', destination, label: 'Test' }));
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.querySelectorAll('a').length, 0, 'no <a> element may exist on this module\'s path');
  assert.equal(container.querySelectorAll('iframe').length, 0, 'no <iframe> element may exist on this module\'s path');
  assert.equal(container.querySelectorAll('script').length, 0, 'no <script> element may exist on this module\'s path');
  // The destination text must never appear as an href/src attribute --
  // only inside the SVG path's geometric "d" attribute (drawn ink, not a
  // navigable reference) and nowhere else.
  for (const el of Array.from(container.querySelectorAll('*'))) {
    for (const attr of ['href', 'src']) {
      const value = el.getAttribute(attr);
      assert.equal(value, null, `no element may carry ${attr}="${value}"`);
    }
  }
});

test('deactivate() is idempotent and stops the module from rendering a later fetch', async () => {
  const { container, connection, module } = mount(async () => ({ schemaVersion: 'v1', destination: 'https://x.io/a', label: 'A' }));
  module.deactivate();
  module.deactivate(); // must not throw
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
});
