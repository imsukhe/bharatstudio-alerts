import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMasterCanvasConnection } from './master-canvas-connection';

/*
 * PRF-02.1: "A canvas with both modules opens exactly one transport
 * connection. Adding a module adds zero." These tests prove that at the
 * connection layer directly, independent of the runtime/module code —
 * `subscribe()` is the only thing a module ever calls, and it must never
 * itself trigger a new fetch to the events endpoint once the stream is
 * already open.
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
    clearTimeoutImpl: ((id: unknown) => {
      scheduled.delete(id as number);
    }) as typeof clearTimeout,
    flushAll() {
      const entries = [...scheduled.entries()];
      scheduled.clear();
      for (const [, fn] of entries) fn();
    },
    pendingCount() {
      return scheduled.size;
    },
  };
}

/** A fetch stub whose body never finishes — models an open, healthy SSE
 * stream that just hasn't sent anything new yet. */
function neverEndingStreamFetch(onCall: () => void) {
  return (async () => {
    onCall();
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}), // never resolves
          cancel: async () => {},
        }),
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** A fetch stub whose body yields the given frames, then ends (done:true). */
function scriptedStreamFetch(frames: string[], onCall: () => void) {
  return (async () => {
    onCall();
    let index = 0;
    const encoder = new TextEncoder();
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (index < frames.length) {
              const value = encoder.encode(frames[index]);
              index += 1;
              return { done: false, value };
            }
            return { done: true, value: undefined };
          },
          cancel: async () => {},
        }),
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

test('two subscribers share exactly one connection attempt — adding a module adds zero connections', async () => {
  let calls = 0;
  const timers = createManualTimers();
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => { calls += 1; }),
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  connection.subscribe(() => {});
  await flush();
  assert.equal(calls, 1);
  assert.equal(connection.getOpenAttemptCount(), 1);

  connection.subscribe(() => {}); // a second module subscribing
  await flush();
  assert.equal(calls, 1, 'a second subscriber must not open a second connection');
  assert.equal(connection.getOpenAttemptCount(), 1);
  assert.equal(connection.getSubscriberCount(), 2);
});

test('tearing down the last subscriber closes the stream; a fresh subscribe reopens it (a new connection, not a leaked one)', async () => {
  let calls = 0;
  const timers = createManualTimers();
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => { calls += 1; }),
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const unsubscribeA = connection.subscribe(() => {});
  const unsubscribeB = connection.subscribe(() => {});
  await flush();
  assert.equal(calls, 1);

  unsubscribeA();
  assert.equal(connection.getSubscriberCount(), 1);
  assert.equal(calls, 1, 'removing one of two subscribers must not reopen or close the shared connection');

  unsubscribeB();
  assert.equal(connection.getSubscriberCount(), 0);

  connection.subscribe(() => {});
  await flush();
  assert.equal(calls, 2, 'a subscribe after full teardown legitimately opens a new connection');
});

test('a subscribed listener is notified immediately (snapshot-on-subscribe), even before any data frame', async () => {
  const timers = createManualTimers();
  let notifyCount = 0;
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  connection.subscribe(() => { notifyCount += 1; });
  timers.flushAll(); // the subscribe-time debounce timer
  assert.ok(notifyCount >= 1);
});

test('a data frame notifies subscribers (debounced), and a throwing listener does not stop other listeners', async () => {
  const timers = createManualTimers();
  let goodListenerCalls = 0;
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: scriptedStreamFetch(['event: alert.ready\ndata: {}\nid: cursor-1\n\n'], () => {}),
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  connection.subscribe(() => { throw new Error('a misbehaving module must not break the shared connection'); });
  connection.subscribe(() => { goodListenerCalls += 1; });
  timers.flushAll(); // subscribe-time debounce
  await flush();
  timers.flushAll(); // the data-frame debounce
  await flush();
  assert.ok(goodListenerCalls >= 1, 'the well-behaved listener must still be notified of the data frame');
});

test('PRF-02.12: a dropped stream reconnects and forces a fresh notify — no listener is left showing a value as current with no signal to re-check it', async () => {
  const timers = createManualTimers();
  let attempt = 0;
  const fetchImpl = (async () => {
    attempt += 1;
    if (attempt === 1) {
      // First attempt: the stream ends immediately (server closed it) —
      // done:true straight away.
      return {
        ok: true,
        body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }), cancel: async () => {} }) },
      } as unknown as Response;
    }
    // Reconnect attempt: healthy, open stream.
    return {
      ok: true,
      body: { getReader: () => ({ read: () => new Promise<{ done: boolean }>(() => {}), cancel: async () => {} }) },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test', fetchImpl,
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  let notifyCount = 0;
  connection.subscribe(() => { notifyCount += 1; });
  // Only the subscribe-time debounce timer exists at this synchronous
  // point (the reconnect timer cannot exist yet — the stream hasn't even
  // had a chance to end). Flush it now, before it could ever be confused
  // with a later reconnect timer.
  timers.flushAll();
  await flush(20);
  const notifyAfterSubscribe = notifyCount;
  assert.equal(connection.getOpenAttemptCount(), 1);

  // The first stream ended (done:true) — run() loops back, waits on the
  // reconnect backoff timer, then retries. Poll rather than assume an
  // exact microtask-hop count across fetch -> read -> cancel -> reconnect.
  let waited = 0;
  while (timers.pendingCount() === 0 && waited < 50) {
    await flush(1);
    waited += 1;
  }
  assert.equal(timers.pendingCount() > 0, true, 'a reconnect backoff timer must be scheduled after the stream ends');
  timers.flushAll(); // fire the reconnect delay — the only timer pending at this point
  await flush(20);

  assert.equal(connection.getOpenAttemptCount(), 2, 'exactly one reconnect attempt — never duplicated, never silently abandoned');
  assert.ok(notifyCount > notifyAfterSubscribe, 'the reconnect itself must force a fresh notify, so every module re-reads rather than trusting stale state');
});

test('bounded data (§12.7/PRF-02.10): the connection retains no event history, only the current line-buffer tail and cursor', async () => {
  // Structural proof rather than a memory measurement: nothing in this
  // module's public surface (subscribe/getOpenAttemptCount/
  // getSubscriberCount) exposes or accumulates a list of past events —
  // there is no method to read "everything that has happened", only a
  // change signal. Driving many frames through and confirming the
  // subscriber is merely notified each time (not handed a growing array)
  // is the closest black-box proof available without reaching into the
  // module's private closure.
  const timers = createManualTimers();
  const frames = Array.from({ length: 50 }, (_, i) => `data: {}\nid: cursor-${i}\n\n`);
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: scriptedStreamFetch(frames, () => {}),
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  let notifyCallArgCount = -1;
  connection.subscribe((...args: unknown[]) => { notifyCallArgCount = args.length; });
  for (let i = 0; i < 10; i += 1) {
    timers.flushAll();
    await flush();
  }
  assert.equal(notifyCallArgCount, 0, 'the change signal carries no payload — a module always re-reads its own bounded snapshot, never receives event history');
});

/*
 * PRF-02 slice 3, CORRECTED 2026-09-16: these tests cover the connection's
 * extension for Support Theater — subscribeToEvents/acknowledge and the
 * ack-aware reconnect cursor — added when the module's original,
 * separate-session design was corrected to share this ONE connection
 * instead (see this file's own header for the full account). "Adding a
 * module adds zero connections" now needs to hold for an event-payload
 * subscriber too, not only a signal-only one — these tests prove the
 * specific mechanics that make that true and safe, not just the module-
 * level end-to-end count already covered in master-canvas-integration.test.ts.
 */

/** Like scriptedStreamFetch, but also records each call's request init
 * (headers, signal) so a test can assert on the reconnect cursor sent. */
function scriptedStreamFetchRecordingInit(frames: string[], calls: RequestInit[]) {
  return (async (_input: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    let index = 0;
    const encoder = new TextEncoder();
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (index < frames.length) {
              const value = encoder.encode(frames[index]);
              index += 1;
              return { done: false, value };
            }
            return { done: true, value: undefined };
          },
          cancel: async () => {},
        }),
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** A stream whose read() rejects the moment its request's AbortSignal
 * fires — models a real fetch/ReadableStream's abort behaviour, which
 * every other stub in this file deliberately does not, so forceReconnect
 * can be proven to actually unstick the read loop rather than merely
 * being called. */
function abortAwareHangingStreamFetch(calls: RequestInit[]) {
  return (async (_input: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    const signal = init?.signal;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: () => new Promise<{ done: boolean }>((_resolve, reject) => {
            if (!signal) return;
            if (signal.aborted) { reject(new Error('aborted')); return; }
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
          cancel: async () => {},
        }),
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

test('subscribeToEvents receives a connected marker on (re)connect and each event frame\'s parsed payload exactly once', async () => {
  const timers = createManualTimers();
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: scriptedStreamFetch(['data: {"a":1}\nid: cursor-1\n\n'], () => {}),
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const events: unknown[] = [];
  connection.subscribeToEvents((event) => events.push(event));
  await flush(20);

  assert.deepEqual(events[0], { type: 'connected' });
  assert.deepEqual(events[1], { type: 'data', payload: { a: 1 } });
  assert.equal(events.length, 2, 'exactly one connected marker and one data event for one frame — no duplication');
});

test('a plain subscribe() listener pays nothing extra: with no event-payload subscriber, a malformed data frame is never even parsed', async () => {
  const timers = createManualTimers();
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: scriptedStreamFetch(['data: {not valid json\nid: cursor-1\n\n'], () => {}),
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  let notifyCount = 0;
  connection.subscribe(() => { notifyCount += 1; });
  timers.flushAll();
  await flush(20);
  timers.flushAll(); // the data-frame debounce
  await flush(20);
  assert.ok(notifyCount >= 1, 'the signal-only subscriber still gets its re-read signal regardless of the frame body being unparseable JSON');
});

test('once an event-payload subscriber exists, reconnect uses the ack-aware cursor — never the merely-seen one — so an unacknowledged delivery is never skipped', async () => {
  const timers = createManualTimers();
  const calls: RequestInit[] = [];
  // First connect: one frame arrives (cursor-1) and is SEEN but never
  // acknowledged, then the stream ends (done:true), forcing a reconnect.
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: scriptedStreamFetchRecordingInit(['data: {"a":1}\nid: cursor-1\n\n'], calls),
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  connection.subscribeToEvents(() => {});
  await flush(20);

  let waited = 0;
  while (timers.pendingCount() === 0 && waited < 50) { await flush(1); waited += 1; }
  timers.flushAll(); // reconnect backoff fires
  await flush(20);

  assert.equal(calls.length, 2, 'the stream reconnected once');
  const secondCallHeaders = calls[1]?.headers as Record<string, string> | undefined;
  assert.equal(secondCallHeaders?.['last-event-id'], undefined, 'the reconnect must NOT send cursor-1 as last-event-id — it was seen but never acknowledged, so sending it would let the server skip re-sending it');
});

test('acknowledge() success advances the reconnect cursor, so a LATER reconnect resumes from exactly the acknowledged point', async () => {
  const timers = createManualTimers();
  const calls: RequestInit[] = [];
  let ackFetchCalls = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/cursor')) { ackFetchCalls += 1; return { ok: true, status: 204 } as unknown as Response; }
    calls.push(init ?? {});
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }), cancel: async () => {} }) },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test', fetchImpl,
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  connection.subscribeToEvents(() => {});
  await flush(20);
  assert.equal(calls.length, 1, 'first connect, no cursor yet');

  const result = await connection.acknowledge('cursor-9', '00000000-0000-4000-8000-000000000001');
  assert.equal(result.ok, true);
  assert.equal(ackFetchCalls, 1);

  let waited = 0;
  while (timers.pendingCount() === 0 && waited < 50) { await flush(1); waited += 1; }
  timers.flushAll(); // reconnect backoff fires (the first connect ended immediately, done:true)
  await flush(20);

  assert.equal(calls.length, 2, 'reconnected once after the ack');
  const secondCallHeaders = calls[1]?.headers as Record<string, string> | undefined;
  assert.equal(secondCallHeaders?.['last-event-id'], 'cursor-9', 'the reconnect resumes exactly from the acknowledged cursor');
});

test('a late event-payload subscriber joining an already-running signal-only stream forces an IMMEDIATE reconnect — not the backed-off delay', async () => {
  const timers = createManualTimers();
  const calls: RequestInit[] = [];
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: abortAwareHangingStreamFetch(calls),
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  // A plain, signal-only subscriber starts the stream first — exactly the
  // "wrong order" case this mechanism exists to correct.
  connection.subscribe(() => {});
  await flush(20);
  assert.equal(calls.length, 1, 'the stream is running for the plain subscriber, with no event-payload subscriber yet');

  const events: unknown[] = [];
  connection.subscribeToEvents((event) => events.push(event));
  // No timers.flushAll() here on purpose: forceReconnect bypasses the
  // backoff entirely (delay reset to 0), so the fresh connect must happen
  // on its own, from aborting the in-flight read, without this test ever
  // touching the manual timer queue.
  await flush(30);

  assert.equal(calls.length, 2, 'the late event-payload subscriber forced a second, immediate connect attempt — required for correct ack-aware replay, not a silent stall');
  assert.ok(events.some((e) => (e as { type: string }).type === 'connected'), 'the new event-payload subscriber received its own connected marker from the forced reconnect');
});
