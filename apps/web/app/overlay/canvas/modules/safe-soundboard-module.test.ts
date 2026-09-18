import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSafeSoundboardModule } from './safe-soundboard-module';
import type { MasterCanvasConnection } from '../master-canvas-connection';
import type { OverlaySoundboardPlay } from './safe-soundboard-logic';

/*
 * §6 catalogue module #6 (Safe Soundboard Alert) — the renderer's own
 * cases.
 *
 * The case that carries a recorded product decision rather than a
 * mechanical requirement is the REPEAT-POLL one: the overlay read returns
 * the single most recent trigger, not a consumed queue, so a second poll
 * that returns the SAME playId must not replay the clip. Idempotent
 * deactivate() (PRF-13) and the null-playbackUrl (unconfigured CDN) case
 * matter too — a module that throws when the CDN base is unset would take
 * down the whole Canvas rather than degrade to a caption with no audio.
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

const triggeredAtMs = Date.parse('2026-09-17T10:00:00.000Z');

const play: OverlaySoundboardPlay = {
  schemaVersion: 'v1',
  playId: '00000000-0000-4000-8000-000000005c91',
  clipKind: 'catalogue',
  displayName: 'Air Horn',
  playbackUrl: 'https://cdn.example.com/soundboard/catalogue/air-horn',
  mimeType: 'audio/mpeg',
  durationSeconds: 3,
  triggeredAt: '2026-09-17T10:00:00.000Z',
};

function mount(
  fetchSnapshot: () => Promise<OverlaySoundboardPlay | null>,
  opts: { now?: () => number; createAudio?: (url: string) => { play: () => Promise<void> | void; pause: () => void } } = {},
) {
  const container = document.createElement('div');
  const connection = fakeConnection();
  let clockMs = triggeredAtMs;
  const now = opts.now ?? (() => clockMs);
  const audioCalls: string[] = [];
  const createAudio = opts.createAudio ?? ((url: string) => {
    audioCalls.push(url);
    return { play: () => Promise.resolve(), pause: () => {} };
  });
  const module = createSafeSoundboardModule({
    container, connection, fetchSnapshot, reducedMotion: () => false, now, createAudio,
  });
  module.activate();
  return { container, connection, module, audioCalls, advance: (ms: number) => { clockMs += ms; } };
}

test('the module key is the catalogue key migration 0131 already names', () => {
  const { module } = mount(async () => null);
  assert.equal(module.key, 'safe_soundboard_alert');
});

test('a fresh trigger starts audio playback and shows the caption', async () => {
  const { container, connection, module, audioCalls } = mount(async () => play);
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1');
  assert.equal((container.querySelector('[data-role="safe-soundboard-label"]') as HTMLElement).textContent, '\u{1F50A} Air Horn');
  assert.deepEqual(audioCalls, ['https://cdn.example.com/soundboard/catalogue/air-horn']);
});

test('a repeated poll of the SAME playId does not replay the clip -- the read is latest-supersedes, not a consumed queue', async () => {
  const { connection, module, audioCalls } = mount(async () => play);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(audioCalls.length, 1);

  // Same playId, second poll.
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(audioCalls.length, 1, 'a repeat of the same trigger must not start a second playback');
});

test('a DIFFERENT playId while the caption is still showing supersedes the previous one', async () => {
  let current = play;
  const { connection, module, audioCalls } = mount(async () => current);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(audioCalls.length, 1);

  current = { ...play, playId: '00000000-0000-4000-8000-000000005c92', displayName: 'Clap' };
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(audioCalls.length, 2);
  assert.equal(audioCalls[1], 'https://cdn.example.com/soundboard/catalogue/air-horn'); // same URL fixture, different id triggers a new call regardless
});

test('a null playbackUrl (configured-but-unset CDN base) still shows the caption with no audio call', async () => {
  const { container, connection, module, audioCalls } = mount(async () => ({ ...play, playbackUrl: null }));
  connection.fireChange();
  await flush();
  module.render(0);

  assert.equal(container.style.opacity, '1');
  assert.equal((container.querySelector('[data-role="safe-soundboard-label"]') as HTMLElement).textContent, '\u{1F50A} Air Horn');
  assert.equal(audioCalls.length, 0);
});

test('the caption fades out after its visible window elapses, with no new trigger', async () => {
  const { container, connection, module, advance } = mount(async () => play);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '1');

  advance(5000); // past CAPTION_VISIBLE_MS
  module.render(0);
  assert.equal(container.style.opacity, '0');
});

test('a null snapshot paints nothing', async () => {
  const { container, connection, module } = mount(async () => null);
  connection.fireChange();
  await flush();
  module.render(0);
  assert.equal(container.style.opacity, '0');
});

test('an audio play() rejection (autoplay refusal) never throws past the module boundary', async () => {
  const { connection, module } = mount(async () => play, {
    createAudio: () => ({ play: () => Promise.reject(new Error('NotAllowedError')), pause: () => {} }),
  });
  connection.fireChange();
  await flush();
  assert.doesNotThrow(() => module.render(0));
});

test('deactivate() is idempotent and stops any current audio', async () => {
  let pauseCalls = 0;
  const { connection, module } = mount(async () => play, {
    createAudio: () => ({ play: () => Promise.resolve(), pause: () => { pauseCalls += 1; } }),
  });
  connection.fireChange();
  await flush();
  module.render(0);

  module.deactivate();
  module.deactivate(); // must not throw a second time
  assert.equal(pauseCalls, 1);
});

test('hide/show cannot replay the same durable latest play, but a different later play still replaces it', async () => {
  let current = play;
  let pauseCalls = 0;
  let audioCreated = 0;
  const { connection, module } = mount(async () => current, {
    createAudio: () => {
      audioCreated += 1;
      return { play: () => Promise.resolve(), pause: () => { pauseCalls += 1; } };
    },
  });
  connection.fireChange();
  await flush();
  assert.equal(audioCreated, 1);

  module.deactivate();
  module.activate();
  connection.fireChange();
  await flush();
  assert.equal(pauseCalls, 1, 'the hidden source stops current audio exactly once');
  assert.equal(audioCreated, 1, 'reactivation must not replay the same durable latest play');

  current = { ...play, playId: '00000000-0000-4000-8000-000000005c93', displayName: 'Drum Roll' };
  connection.fireChange();
  await flush();
  assert.equal(pauseCalls, 1, 'there is no stale audio left to pause before the genuine next play');
  assert.equal(audioCreated, 2, 'a different later play still starts once');
});
