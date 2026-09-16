import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupportTheaterModule, DEFAULT_THEATER_AGGREGATE_POOL_SIZE } from './support-theater-module';
import type { MasterCanvasConnection, MasterCanvasConnectionEvent, MasterCanvasConnectionEventListener, MasterCanvasConnectionListener, MasterCanvasAcknowledgeResult } from '../master-canvas-connection';

/*
 * PRF-02 slice 3. These tests exercise Support Theater against a FAKE
 * `MasterCanvasConnection` — the same shared connection type the other
 * four modules use — rather than a private transport, matching the
 * corrected design (see support-theater-module.ts's own "CORRECTION"
 * header and reviews/2026-09-16-prf-02-slice-3-implementation.md). They
 * exist because the standalone page this module replaces
 * (../../[overlayId]/page.tsx) was never a module that could be turned
 * off, so "deactivated mid-acknowledgement" and "reactivated on the same
 * instance" are states nothing previously exercised — the scope review
 * named this gap directly
 * (reviews/2026-09-16-prf-02-slice-2-scope-review.md).
 */

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

function eventId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function fakeItem(item: { cursor: string; eventIdNum: number; eventType?: string; createdAt?: string; payload?: Record<string, unknown> }): unknown {
  return {
    schemaVersion: 'v1',
    cursor: item.cursor,
    eventId: eventId(item.eventIdNum),
    eventType: item.eventType ?? 'alert.ready',
    traceId: 'trace-1',
    createdAt: item.createdAt ?? '2026-09-16T00:00:00.000000Z',
    payload: item.payload ?? {},
  };
}

function createPendingController<T>() {
  const pending: Array<(value: T) => void> = [];
  return {
    wait(): Promise<T> { return new Promise((resolve) => { pending.push(resolve); }); },
    resolveOldest(value: T) {
      const resolve = pending.shift();
      if (!resolve) throw new Error('no pending item to resolve');
      resolve(value);
    },
    pendingCount() { return pending.length; },
  };
}

/**
 * A fake of the shared MasterCanvasConnection, exposing the same surface
 * Support Theater actually calls (`subscribeToEvents`, `acknowledge`) plus
 * test-only helpers to emit events and control acknowledgement timing —
 * standing in for the real connection's own SSE stream and its
 * once-per-attempt `POST .../cursor` call.
 */
function fakeConnectionWithEvents() {
  const listeners = new Set<MasterCanvasConnectionListener>();
  const eventListeners = new Set<MasterCanvasConnectionEventListener>();
  const ackController = createPendingController<MasterCanvasAcknowledgeResult>();
  const ackCalls: Array<{ cursor: string; eventId: string }> = [];
  const connection: MasterCanvasConnection & {
    emitConnected(): void;
    emitData(payload: unknown): void;
    ackController: ReturnType<typeof createPendingController<MasterCanvasAcknowledgeResult>>;
    ackCalls: Array<{ cursor: string; eventId: string }>;
    eventListenerCount(): number;
  } = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeToEvents(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    async acknowledge(cursor, eventId) {
      ackCalls.push({ cursor, eventId });
      return ackController.wait();
    },
    getOpenAttemptCount: () => 1,
    getSubscriberCount: () => listeners.size + eventListeners.size,
    emitConnected() {
      const event: MasterCanvasConnectionEvent = { type: 'connected' };
      for (const l of [...eventListeners]) l(event);
    },
    emitData(payload) {
      const event: MasterCanvasConnectionEvent = { type: 'data', payload };
      for (const l of [...eventListeners]) l(event);
    },
    ackController,
    ackCalls,
    eventListenerCount: () => eventListeners.size,
  };
  return connection;
}

async function flush(times = 20) { for (let i = 0; i < times; i += 1) await Promise.resolve(); }

function fetchRouter(opts: { lottieOk?: boolean; audio?: { wait(): Promise<Response>; resolveOldest(v: Response): void } } = {}): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes('/overlay-lottie')) return { ok: opts.lottieOk ?? false } as unknown as Response;
    if (url.includes('/overlay-audio')) {
      if (!opts.audio) return { ok: false } as unknown as Response;
      return opts.audio.wait();
    }
    throw new Error(`unexpected fetch url: ${url}`);
  }) as unknown as typeof fetch;
}

test('a delivered alert renders name/amount/message; next-up shows only the immediate next item, never deeper (§12.7)', async () => {
  const timers = createManualTimers();
  const connection = fakeConnectionWithEvents();
  const container = document.createElement('div');
  const module = createSupportTheaterModule({
    container, connection, overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    reducedMotion: () => false, fetchImpl: fetchRouter(), setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  module.activate();
  connection.emitData(fakeItem({ cursor: 'c1', eventIdNum: 1, payload: { displayName: 'Riya', amountPaise: 10000, message: 'yay' } }));
  connection.emitData(fakeItem({ cursor: 'c2', eventIdNum: 2, payload: { displayName: 'Aman', amountPaise: 5000, message: 'go team' } }));
  connection.emitData(fakeItem({ cursor: 'c3', eventIdNum: 3, payload: { displayName: 'Zara', amountPaise: 2000, message: 'later' } }));
  await flush();
  module.render(0);

  assert.equal(container.querySelector('[data-role="support-theater-name"]')?.textContent, 'Riya · ₹100');
  assert.equal(container.querySelector('[data-role="support-theater-message"]')?.textContent, 'yay');
  const nextText = container.querySelector('[data-role="support-theater-next-entry"]')?.textContent ?? '';
  assert.ok(nextText.includes('Aman'), 'next-up shows the immediate next item');
  assert.ok(!nextText.includes('Zara'), '§12.7 bound: next-up never shows more than one item deep, proven not asserted');
});

test('deactivate() mid-acknowledgement is safe (no double-ack, no lost alert) and re-activating the SAME instance runs the pump again — the stale active.current defect, made impossible by construction', async () => {
  const timers = createManualTimers();
  const connection = fakeConnectionWithEvents();
  const container = document.createElement('div');
  const module = createSupportTheaterModule({
    container, connection, overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    reducedMotion: () => false, fetchImpl: fetchRouter(), setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  module.activate();
  connection.emitData(fakeItem({ cursor: 'c1', eventIdNum: 1, payload: { displayName: 'Riya', amountPaise: 10000 } }));
  await flush();
  timers.flushAll(); // the display timer fires -> finishDisplay -> acknowledge() issues the ack call
  await flush();
  assert.equal(connection.ackController.pendingCount(), 1, 'the acknowledgement call is in flight');

  // Deactivate WHILE the ack response is still pending.
  module.deactivate();
  module.render(0);
  const currentEl = container.querySelector('[data-role="support-theater-current"]') as HTMLElement;
  assert.equal(currentEl.style.opacity, '0');

  // The stale ack response now arrives late. It must be a pure no-op: no
  // exception, and it must never repaint the canvas.
  assert.doesNotThrow(() => connection.ackController.resolveOldest({ ok: true, status: 204 }));
  await flush();
  module.render(0);
  assert.equal(currentEl.style.opacity, '0', 'a late ack response after deactivate() must never repaint the canvas');

  // Re-activate the SAME module instance. The delivery was never truly
  // acknowledged (the client gave up before the server confirmed it), so
  // per L05/migration 0022 the durable delivery stays replay-eligible —
  // modelled here by the connection delivering the same item again.
  module.activate();
  connection.emitData(fakeItem({ cursor: 'c1', eventIdNum: 1, payload: { displayName: 'Riya', amountPaise: 10000 } }));
  await flush();
  module.render(0);

  assert.equal(container.querySelector('[data-role="support-theater-name"]')?.textContent, 'Riya · ₹100', 'the pump runs again on the same instance — never stalled by a stale in-flight gate');
});

test('deactivate() mid-display-timer is safe and idempotent: no further acknowledgement is ever issued for the torn-down item', async () => {
  const timers = createManualTimers();
  const connection = fakeConnectionWithEvents();
  const container = document.createElement('div');
  const module = createSupportTheaterModule({
    container, connection, overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    reducedMotion: () => false, fetchImpl: fetchRouter(), setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  module.activate();
  connection.emitData(fakeItem({ cursor: 'c1', eventIdNum: 1, payload: { displayName: 'Riya', amountPaise: 10000 } }));
  await flush();
  assert.ok(timers.pendingCount() > 0, 'the display timer is scheduled while the item is on screen');

  assert.doesNotThrow(() => module.deactivate());
  assert.doesNotThrow(() => module.deactivate()); // idempotent — a second call must not throw or double-clean-up

  // The display timer must actually have been cleared, not merely
  // orphaned: flushing every remaining scheduled callback must never
  // trigger an acknowledgement call for an item this module no longer owns.
  timers.flushAll();
  await flush();
  assert.equal(connection.ackCalls.length, 0, 'deactivate() cleared the display timer — it never fired into finishDisplay()');
});

test('deactivate() mid-audio-playback is safe and idempotent: the in-flight playback is paused, not left running', async () => {
  const timers = createManualTimers();
  const connection = fakeConnectionWithEvents();
  const audio = createPendingController<Response>();
  let pauseCalls = 0;
  let resolvePlay: (() => void) | undefined;
  const container = document.createElement('div');
  const module = createSupportTheaterModule({
    container, connection, overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    reducedMotion: () => false, fetchImpl: fetchRouter({ audio }), setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
    // play() stays pending until this test resolves it explicitly (below)
    // — deliberately, so the assertions run while playback is genuinely
    // in flight rather than racing tts-runtime.ts's own real 1.5s
    // playback-start timeout (not this task's to change; see file header).
    createAudio: () => ({ play: () => new Promise<void>((resolve) => { resolvePlay = resolve; }), pause: () => { pauseCalls += 1; } }),
  });

  module.activate();
  connection.emitData(fakeItem({
    cursor: 'c1', eventIdNum: 1,
    payload: { displayName: 'Riya', amountPaise: 10000, ttsAudioUrl: '/v1/overlay-audio/a1', configSnapshot: { tts: { enabled: true } } },
  }));
  await flush();
  audio.resolveOldest({ ok: true, blob: async () => new Blob(['bytes']) } as unknown as Response);
  await flush();
  assert.equal(pauseCalls, 0, 'playback has not been paused yet');

  assert.doesNotThrow(() => module.deactivate());
  assert.equal(pauseCalls, 1, 'an in-flight playback is paused on deactivate, not left running behind a torn-down module');
  assert.doesNotThrow(() => module.deactivate()); // idempotent

  // Let the still-pending play() promise resolve so this test does not
  // leave tts-runtime.ts's real playback-start timer dangling past this
  // test's own assertions.
  resolvePlay?.();
  await flush();
});

test('a failed acknowledgement retries with backoff and eventually succeeds — the alert is neither dropped nor acknowledged twice', async () => {
  const timers = createManualTimers();
  const connection = fakeConnectionWithEvents();
  const container = document.createElement('div');
  const module = createSupportTheaterModule({
    container, connection, overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    reducedMotion: () => false, fetchImpl: fetchRouter(), setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  module.activate();
  connection.emitData(fakeItem({ cursor: 'c1', eventIdNum: 1, payload: { displayName: 'Riya', amountPaise: 10000 } }));
  await flush();
  timers.flushAll(); // display timer -> first ack attempt
  await flush();
  assert.equal(connection.ackController.pendingCount(), 1);
  connection.ackController.resolveOldest({ ok: false, status: 503 }); // transient failure
  await flush();
  timers.flushAll(); // the retry backoff
  await flush();
  assert.equal(connection.ackController.pendingCount(), 1, 'a retry re-issued the acknowledgement call after backoff');
  connection.ackController.resolveOldest({ ok: true, status: 204 });
  await flush();

  assert.equal(connection.ackCalls.length, 2, 'exactly two attempts for the one item — a retry, never a duplicate delivery');
  assert.equal(connection.ackCalls[0]?.cursor, 'c1');
  assert.equal(connection.ackCalls[1]?.cursor, 'c1');
});

test('cross-reconnect dedup survives the port: an already-pending item is not redisplayed or re-queued after the shared connection reconnects and replays it', async () => {
  const timers = createManualTimers();
  const connection = fakeConnectionWithEvents();
  const container = document.createElement('div');
  const module = createSupportTheaterModule({
    container, connection, overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    reducedMotion: () => false, fetchImpl: fetchRouter(), setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  module.activate();
  const item = fakeItem({ cursor: 'c1', eventIdNum: 1, payload: { displayName: 'Riya', amountPaise: 10000 } });
  connection.emitData(item);
  await flush();
  timers.flushAll(); // display timer -> first ack attempt (left pending — still "displaying")
  await flush();
  assert.equal(connection.ackController.pendingCount(), 1);

  // The shared connection reconnects (for any reason — a network blip
  // affecting every module, not something this module controls) and
  // replays the same still-unacknowledged item.
  connection.emitConnected();
  connection.emitData(item);
  await flush();

  assert.equal(connection.ackController.pendingCount(), 1, 'the replayed, already-pending cursor was not queued into a second acknowledgement attempt');
  const nextText = container.querySelector('[data-role="support-theater-next-entry"]')?.textContent ?? '';
  assert.equal(nextText, '', 'no duplicate entry was queued behind the still-displaying item');
});

test('audio stays synchronised to the displayed item: a late-resolving fetch for a group that already finished never plays', async () => {
  const timers = createManualTimers();
  const connection = fakeConnectionWithEvents();
  const audio = createPendingController<Response>();
  let createAudioCalls = 0;
  const container = document.createElement('div');
  const module = createSupportTheaterModule({
    container, connection, overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    reducedMotion: () => false, fetchImpl: fetchRouter({ audio }), setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
    createAudio: () => { createAudioCalls += 1; return { play: () => Promise.resolve(), pause: () => {} }; },
  });

  module.activate();
  connection.emitData(fakeItem({
    cursor: 'c1', eventIdNum: 1,
    payload: { displayName: 'Riya', amountPaise: 10000, ttsAudioUrl: '/v1/overlay-audio/a1', configSnapshot: { tts: { enabled: true } } },
  }));
  connection.emitData(fakeItem({ cursor: 'c2', eventIdNum: 2, payload: { displayName: 'Aman', amountPaise: 5000 } }));
  await flush(); // c1 displayed; its audio fetch is in flight (held by `audio`)
  timers.flushAll(); // c1's display timer fires
  await flush();
  connection.ackController.resolveOldest({ ok: true, status: 204 }); // c1 acknowledged — the pump advances to c2
  await flush();
  module.render(0);
  assert.equal(container.querySelector('[data-role="support-theater-name"]')?.textContent, 'Aman · ₹50', 'c2 is now the displayed item');

  // c1's audio fetch (issued while c1 was current) resolves only now, after
  // c2 has already taken over.
  audio.resolveOldest({ ok: true, blob: async () => new Blob(['bytes']) } as unknown as Response);
  await flush();

  assert.equal(createAudioCalls, 0, 'a late audio response for a group that is no longer current must never start playback (RT-03: never plays over a different alert)');
});

test('an aggregated group is drawn from a fixed, recycled pool — bounded DOM, not one <p> appended per supporter', async () => {
  const timers = createManualTimers();
  const connection = fakeConnectionWithEvents();
  const container = document.createElement('div');
  const module = createSupportTheaterModule({
    container, connection, overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    reducedMotion: () => false, fetchImpl: fetchRouter(), setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  module.activate();
  // A lead item is displayed first (and its ack held pending) so 20 more
  // items can back up behind it in the queue — aggregation only ever
  // triggers when multiple items are ALREADY queued at selection time
  // (overlay-policy.ts's selectPresentationGroup, unchanged by this task).
  connection.emitData(fakeItem({ cursor: 'lead', eventIdNum: 0, payload: { displayName: 'Lead', amountPaise: 1000 } }));
  await flush();
  for (let i = 0; i < 20; i += 1) {
    connection.emitData(fakeItem({
      cursor: `c${i}`, eventIdNum: i + 1,
      payload: {
        displayName: `Supporter ${i}`, amountPaise: 1000,
        // maxVisibleItems is bounded to [1,10] by overlay-policy.ts's own
        // normalizeOverlayConfig (§12.7) — 10 is the largest legal value,
        // so the aggregate group (10 items) still exceeds this module's
        // own 8-item recycled pool and exercises the overflow path.
        configSnapshot: { queue: { mode: 'aggregated', aggregationThreshold: 5 }, display: { maxVisibleItems: 10 } },
      },
    }));
  }
  await flush();
  timers.flushAll(); // the lead item's display timer fires -> finishDisplay -> acknowledge() issues the ack call
  await flush();
  assert.equal(connection.ackController.pendingCount(), 1, 'the lead item is displaying and awaiting acknowledgement');
  connection.ackController.resolveOldest({ ok: true, status: 204 }); // lead acknowledged -> pump() re-selects from the 20-item backlog -> aggregation threshold is met
  await flush();
  module.render(0);

  const lines = container.querySelectorAll('[data-role="support-theater-aggregate-line"]');
  assert.equal(lines.length, DEFAULT_THEATER_AGGREGATE_POOL_SIZE, 'the aggregate pool is a fixed size regardless of how many supporters are represented in the group');
  const lastLine = lines[lines.length - 1]?.textContent ?? '';
  assert.ok(lastLine.includes('more'), 'supporters beyond the pool size are summarised, never silently dropped from the count');
});

test('prefers-reduced-motion disables the opacity transition; only opacity/transform are ever written, never width/height/top/left', async () => {
  const timers = createManualTimers();
  const connection = fakeConnectionWithEvents();
  const container = document.createElement('div');
  const module = createSupportTheaterModule({
    container, connection, overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    reducedMotion: () => true, fetchImpl: fetchRouter(), setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  module.activate();
  const currentEl = container.querySelector('[data-role="support-theater-current"]') as HTMLElement;
  const nextEl = container.querySelector('[data-role="support-theater-next"]') as HTMLElement;
  assert.equal(currentEl.style.transition, 'none');
  assert.equal(nextEl.style.transition, 'none');
  assert.equal(currentEl.style.width, '');
  assert.equal(currentEl.style.height, '');
  assert.equal((currentEl.style as unknown as { top: string }).top, '');
  assert.equal((currentEl.style as unknown as { left: string }).left, '');
});

test('a throwing/malformed event payload is ignored, never thrown, and does not stall the module', async () => {
  const timers = createManualTimers();
  const connection = fakeConnectionWithEvents();
  const container = document.createElement('div');
  const module = createSupportTheaterModule({
    container, connection, overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    reducedMotion: () => false, fetchImpl: fetchRouter(), setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  assert.doesNotThrow(() => module.activate());
  assert.doesNotThrow(() => connection.emitData({ not: 'a real item' }));
  assert.doesNotThrow(() => connection.emitData(undefined));
  connection.emitData(fakeItem({ cursor: 'c1', eventIdNum: 1, payload: { displayName: 'Riya', amountPaise: 10000 } }));
  await flush();
  assert.doesNotThrow(() => module.render(0));
  assert.equal(container.querySelector('[data-role="support-theater-name"]')?.textContent, 'Riya · ₹100', 'the well-formed item after the malformed ones still displays');
});
