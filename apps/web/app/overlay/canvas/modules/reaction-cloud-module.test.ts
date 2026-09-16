import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReactionCloudModule } from './reaction-cloud-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import type { ReactionCloudEntry } from './reaction-cloud-logic';

/*
 * PRF-02 slice 6 / PRF-06, §6 catalogue module #5 (Reaction Cloud) — the
 * renderer's own cases.
 *
 * Two of them carry recorded decisions rather than mechanical
 * requirements, and are asserted in both directions so they cannot
 * quietly rot into "it happens to work":
 *
 *   * THE MODULE NEVER SAMPLES. §19.5 requires sampling to happen
 *     server-side; the proof here is that N entries in produce N glyphs
 *     out, for a large N, with no cap anywhere.
 *   * THE DOM IS A RECYCLED POOL. A busy minute followed by a quiet one
 *     followed by another busy one must not grow the node count a second
 *     time.
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
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function mount(fetchSnapshot: () => Promise<ReactionCloudEntry[] | null>, reducedMotion = () => false) {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createReactionCloudModule({ container, connection, fetchSnapshot, reducedMotion });
  module.activate();
  return { container, connection, module };
}

function glyphs(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-role="reaction-cloud-glyph"]')) as HTMLElement[];
}

function visibleLabels(container: HTMLElement): string[] {
  return glyphs(container).filter((glyph) => glyph.style.opacity === '1').map((glyph) => glyph.textContent ?? '');
}

const cloud: ReactionCloudEntry[] = [
  { entrySource: 'catalogue', entryId: 'e1', displayName: 'Clap', reactionCount: 12 },
  { entrySource: 'creator_pack', entryId: 'e2', displayName: 'Pack Star', reactionCount: 3 },
];

// --- the happy path --------------------------------------------------------

test('a cloud with reactions is shown, one glyph per catalogue entry', async () => {
  const { container, connection, module } = mount(async () => cloud);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1');
  assert.deepEqual(visibleLabels(container), ['Clap ×12', 'Pack Star ×3']);
});

test('the rendered cloud names catalogue entries and counts, never a person or an amount', async () => {
  const { container, connection, module } = mount(async () => cloud);
  connection.fireChange();
  await flush();
  module.render(0);

  const text = (container.textContent ?? '').toLowerCase();
  for (const word of ['riya', 'supporter', 'viewer', 'anonymous', '₹', 'paise', 'held']) {
    assert.ok(!text.includes(word), `the cloud must never render "${word}"`);
  }
});

// --- the empty case, in both directions ------------------------------------

test('an empty cloud renders nothing', async () => {
  const { container, connection, module } = mount(async () => []);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '0');
  assert.deepEqual(visibleLabels(container), []);
});

test('a snapshot that never arrives renders the same nothing as an empty cloud', async () => {
  const { container, connection, module } = mount(async () => null);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '0');
  assert.deepEqual(visibleLabels(container), []);
});

test('the cloud hides again when it empties — it does not latch on', async () => {
  let snapshot: ReactionCloudEntry[] | null = cloud;
  const { container, connection, module } = mount(async () => snapshot);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '1');

  snapshot = [];
  connection.fireChange();
  await flush();
  module.render(16);
  assert.equal(container.style.opacity, '0');
  assert.deepEqual(visibleLabels(container), []);
});

// --- the guard is the last line --------------------------------------------

test('a payload carrying an identifying field renders nothing at all', async () => {
  const polluted = [{ ...cloud[0], viewerId: '00000000-0000-4000-8000-0000000000a1' }] as unknown as ReactionCloudEntry[];
  const { container, connection, module } = mount(async () => polluted);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '0');
  assert.ok(!(container.textContent ?? '').includes('00000000-0000-4000-8000-0000000000a1'));
});

test('a rejected fetch leaves the cloud hidden rather than throwing', async () => {
  const { container, connection, module } = mount(async () => { throw new Error('network'); });
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
});

// --- §19.5: the module never samples ---------------------------------------

test('forty entries in, forty glyphs out — the module caps nothing', async () => {
  // Sampling is server-side (§19.5): the SQL function aggregates and then
  // applies the configured display ceiling. If this test ever fails
  // because a cap was added here, the cap is in the wrong place.
  const many: ReactionCloudEntry[] = Array.from({ length: 40 }, (_, index) => ({
    entrySource: 'catalogue' as const,
    entryId: `e${index}`,
    displayName: `Entry ${index}`,
    reactionCount: 40 - index,
  }));
  const { container, connection, module } = mount(async () => many);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(visibleLabels(container).length, 40);
});

// --- §19.5: bounded, recycled DOM ------------------------------------------

test('glyph elements are recycled, never appended per reaction', async () => {
  let snapshot: ReactionCloudEntry[] = cloud;
  const { container, connection, module } = mount(async () => snapshot);
  connection.fireChange();
  await flush();
  module.render(0);
  const afterFirst = glyphs(container).length;
  assert.equal(afterFirst, 2);

  // A quiet minute, then the same busy minute again, twenty times over.
  for (let round = 0; round < 20; round += 1) {
    snapshot = [];
    connection.fireChange();
    await flush();
    module.render(round * 32);
    snapshot = cloud;
    connection.fireChange();
    await flush();
    module.render(round * 32 + 16);
  }

  assert.equal(glyphs(container).length, afterFirst, 'the node count must not grow with reaction volume');
  assert.deepEqual(visibleLabels(container), ['Clap ×12', 'Pack Star ×3']);
});

test('the pool grows to the largest snapshot seen and then stays there', async () => {
  let snapshot: ReactionCloudEntry[] = cloud;
  const { container, connection, module } = mount(async () => snapshot);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(glyphs(container).length, 2);

  snapshot = Array.from({ length: 6 }, (_, index) => ({
    entrySource: 'catalogue' as const, entryId: `e${index}`, displayName: `Entry ${index}`, reactionCount: 6 - index,
  }));
  connection.fireChange();
  await flush();
  module.render(16);
  assert.equal(glyphs(container).length, 6);

  snapshot = cloud;
  connection.fireChange();
  await flush();
  module.render(32);
  assert.equal(glyphs(container).length, 6, 'the pool is recycled, not rebuilt');
  assert.equal(visibleLabels(container).length, 2, 'unused glyphs are hidden, not removed');
});

// --- PRF-03: composite-only on the frame path ------------------------------

test('render writes only transform and opacity', async () => {
  const { container, connection, module } = mount(async () => cloud);
  connection.fireChange();
  await flush();
  module.render(0);

  for (const glyph of glyphs(container)) {
    assert.ok(glyph.style.transform.includes('scale('), 'position and size come from transform');
    assert.equal(glyph.style.left, '', 'no left is ever written');
    assert.equal(glyph.style.top, '', 'no top is ever written');
    assert.equal(glyph.style.width, '', 'no width is ever written');
    assert.equal(glyph.style.height, '', 'no height is ever written');
    assert.equal(glyph.style.fontSize, '', 'no font-size is ever written');
  }
});

test('reduced motion disables the transition rather than the content', async () => {
  const { container, connection, module } = mount(async () => cloud, () => true);
  connection.fireChange();
  await flush();
  module.render(0);

  for (const glyph of glyphs(container)) {
    assert.equal(glyph.style.transition, 'none');
  }
  assert.deepEqual(visibleLabels(container), ['Clap ×12', 'Pack Star ×3']);
});

// --- lifecycle -------------------------------------------------------------

test('render is a no-op when nothing changed since the last frame', async () => {
  let fetches = 0;
  const { connection, module } = mount(async () => { fetches += 1; return cloud; });
  connection.fireChange();
  await flush();
  module.render(0);
  module.render(16);
  module.render(32);
  assert.equal(fetches, 1, 'frames do not trigger fetches; only connection signals do');
});

test('deactivate releases the subscription and discards an in-flight fetch', async () => {
  let resolveFetch: ((value: ReactionCloudEntry[]) => void) | undefined;
  const { container, connection, module } = mount(() => new Promise((resolve) => { resolveFetch = resolve; }));
  connection.fireChange();
  await flush();

  module.deactivate();
  assert.equal(connection.getSubscriberCount(), 0, 'deactivate unsubscribes from the shared connection');

  resolveFetch?.(cloud);
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0', 'a response arriving after deactivate must never repaint the canvas');
});

test('a slow response superseded by a faster later one never lands', async () => {
  const pending: ((value: ReactionCloudEntry[]) => void)[] = [];
  const { container, connection, module } = mount(() => new Promise((resolve) => { pending.push(resolve); }));
  connection.fireChange();
  await flush();
  connection.fireChange();
  await flush();

  // Resolve the SECOND (current) fetch first, then the stale first one.
  pending[1]?.([{ entrySource: 'catalogue', entryId: 'e9', displayName: 'Newest', reactionCount: 1 }]);
  await flush();
  module.render(0);
  assert.deepEqual(visibleLabels(container), ['Newest ×1']);

  pending[0]?.(cloud);
  await flush();
  module.render(16);
  assert.deepEqual(visibleLabels(container), ['Newest ×1'], 'the stale response must be discarded on arrival');
});
