import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaQueueModule } from './media-queue-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import type { MediaQueueEntry, MediaQueueState } from './media-queue-logic';

/*
 * §6 catalogue module #20 (Media / Meme Queue) — the renderer's own
 * cases.
 *
 * The case that carries a recorded product decision rather than a
 * mechanical requirement: the 'next' entry is NEVER rendered visibly —
 * it exists only to warm the preload elements' cache. That is asserted
 * directly against the rendered subtree, not merely against the fetch
 * call, so a future edit that starts showing it turns this file red.
 *
 * The other case that matters is negative and covers the whole rendered
 * subtree: nothing this module can paint contains a submitter, a viewer
 * id, an approval state or a script/iframe/stylesheet element of any
 * kind — the DOM this module builds has no element type capable of
 * carrying one.
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

function mount(fetchSnapshot: () => Promise<MediaQueueState | null>, reducedMotion = () => false) {
  const container = document.createElement('div');
  const connection = fakeConnection();
  const module = createMediaQueueModule({ container, connection, fetchSnapshot, reducedMotion });
  module.activate();
  return { container, connection, module };
}

const image: MediaQueueEntry = {
  schemaVersion: 'v1', queueSlot: 'current', title: 'First meme', mediaKind: 'image',
  mimeType: 'image/png', playbackUrl: 'https://cdn.example.com/a.png', thumbnailPlaybackUrl: null, durationMs: null,
};

const video: MediaQueueEntry = {
  schemaVersion: 'v1', queueSlot: 'next', title: 'Second clip', mediaKind: 'video',
  mimeType: 'video/mp4', playbackUrl: 'https://cdn.example.com/b.mp4', thumbnailPlaybackUrl: 'https://cdn.example.com/b-thumb.png', durationMs: 5000,
};

test('the module key is the catalogue key migration 0131 already names', () => {
  const { module } = mount(async () => []);
  assert.equal(module.key, 'media_meme_queue');
});

test('an empty snapshot renders nothing: the container stays at opacity 0', async () => {
  const { container, connection, module } = mount(async () => []);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
});

// THE ARBITRARY-URL FINDING'S RENDER-LAYER FIX (migration 0148): a live
// entry with no resolved playbackUrl (mediaCdnBaseUrl unset -- every
// environment today) must render NOTHING, and must never assign a null
// or missing src to the visible <img>/<video> elements.
test('a current entry with playbackUrl: null renders nothing, same as no entry at all', async () => {
  const unresolved: MediaQueueEntry = { ...image, playbackUrl: null };
  const { container, connection, module } = mount(async () => [unresolved]);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
  const img = container.querySelector('[data-role="media-queue-current-image"]') as HTMLImageElement;
  assert.equal(img.getAttribute('src'), null, 'no src may ever be assigned from a null playbackUrl');
});

test('a current IMAGE entry is shown in the <img> element and the <video> element stays hidden', async () => {
  const { container, connection, module } = mount(async () => [image]);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '1');
  const img = container.querySelector('[data-role="media-queue-current-image"]') as HTMLImageElement;
  const videoEl = container.querySelector('[data-role="media-queue-current-video"]') as HTMLVideoElement;
  assert.equal(img.src, image.playbackUrl);
  assert.equal(img.alt, image.title);
  assert.equal(img.style.opacity, '1');
  assert.equal(videoEl.style.opacity, '0');
});

test('a current VIDEO entry is shown in the <video> element and the <img> element stays hidden', async () => {
  const currentVideo: MediaQueueEntry = { ...video, queueSlot: 'current' };
  const { container, connection, module } = mount(async () => [currentVideo]);
  connection.fireChange();
  await flush();
  module.render(0);
  const img = container.querySelector('[data-role="media-queue-current-image"]') as HTMLImageElement;
  const videoEl = container.querySelector('[data-role="media-queue-current-video"]') as HTMLVideoElement;
  assert.equal(videoEl.src, currentVideo.playbackUrl);
  assert.equal(videoEl.style.opacity, '1');
  assert.equal(img.style.opacity, '0');
});

test('a "next" entry is loaded into the hidden preload elements and NEVER into the visible ones', async () => {
  const { container, connection, module } = mount(async () => [image, video]);
  connection.fireChange();
  await flush();
  module.render(0);

  const preloadImg = container.querySelector('[data-role="media-queue-preload-image"]') as HTMLImageElement;
  const preloadVideo = container.querySelector('[data-role="media-queue-preload-video"]') as HTMLVideoElement;
  assert.equal(preloadVideo.src, video.playbackUrl, 'the next (video) entry must be preloaded');
  assert.equal(preloadVideo.style.display, 'none', 'the preload element must never be visible');
  assert.equal(preloadImg.style.display, 'none');

  // The visible current elements must show ONLY the current entry --
  // never the next one, by url or by content.
  const currentImg = container.querySelector('[data-role="media-queue-current-image"]') as HTMLImageElement;
  const currentVideoEl = container.querySelector('[data-role="media-queue-current-video"]') as HTMLVideoElement;
  assert.equal(currentImg.src, image.playbackUrl);
  assert.notEqual(currentVideoEl.src, video.playbackUrl, 'the video entry is "next", not "current", and must not be shown');
});

test('the rendered subtree contains no script, iframe, link or style element -- structurally, not by convention', async () => {
  const { container, connection, module } = mount(async () => [image, video]);
  connection.fireChange();
  await flush();
  module.render(0);
  for (const tag of ['script', 'iframe', 'link', 'style', 'object', 'embed']) {
    assert.equal(container.querySelectorAll(tag).length, 0, `no <${tag}> may ever appear in this module's DOM`);
  }
});

test('deactivate() is idempotent and unsubscribes from the connection', async () => {
  const { connection, module } = mount(async () => [image]);
  assert.equal(connection.getSubscriberCount(), 1);
  module.deactivate();
  module.deactivate();
  assert.equal(connection.getSubscriberCount(), 0);
});

test('a fetchSnapshot rejection renders nothing rather than throwing', async () => {
  const { container, connection, module } = mount(async () => { throw new Error('boom'); });
  connection.fireChange();
  await flush();
  assert.doesNotThrow(() => { module.render(0); });
  assert.equal(container.style.opacity, '0');
});
