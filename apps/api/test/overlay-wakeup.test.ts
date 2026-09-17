import assert from 'node:assert/strict';
import test from 'node:test';
import { createOverlayWakeup } from '../src/db/overlay-wakeup.js';

test('direct overlay wake-up reconnects after listener failure and reports health', async () => {
  let calls = 0;
  let notify: ((value: string) => void) | undefined;
  let endCalls = 0;
  const client = {
    listen(_channel: string, onnotify: (value: string) => void, onlisten?: () => void) {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('synthetic listener failure'));
      notify = onnotify;
      onlisten?.();
      return new Promise(() => {});
    },
    async end() { endCalls += 1; },
  };
  const wakeup = createOverlayWakeup(client, { reconnectDelayMs: 5, maxReconnectDelayMs: 10 });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 2);
  assert.deepEqual(wakeup.health?.(), { connected: true, reconnects: 1, failures: 1 });

  const subscription = wakeup.subscribe('channel-1');
  assert.ok(subscription);
  const waiting = subscription.wait(100);
  notify?.(JSON.stringify({ channelId: 'channel-1', eventId: 'event-1' }));
  await waiting;
  subscription.release();
  await wakeup.close();
  assert.equal(endCalls, 1);
});

test('direct overlay wake-up stops reconnect scheduling when closed', async () => {
  let calls = 0;
  const client = {
    listen() {
      calls += 1;
      return Promise.reject(new Error('synthetic listener failure'));
    },
    async end() {},
  };
  const wakeup = createOverlayWakeup(client, { reconnectDelayMs: 20, maxReconnectDelayMs: 20 });
  await wakeup.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
});

test('listener rejection rejects every outstanding waiter across every channel, exposes disconnected health, and reconnect clears it', async () => {
  let listens = 0;
  let rejectListener: ((error: Error) => void) | undefined;
  const client = {
    listen(_channel: string, _notify: (value: string) => void, onlisten?: () => void) {
      listens += 1;
      if (listens === 1) {
        onlisten?.();
        return new Promise((_resolve, reject) => { rejectListener = reject; });
      }
      onlisten?.();
      return new Promise(() => {});
    },
    async end() {},
  };
  const wakeup = createOverlayWakeup(client, { reconnectDelayMs: 5, maxReconnectDelayMs: 5 });
  const subscriptionA = wakeup.subscribe('channel-a')!;
  const subscriptionB = wakeup.subscribe('channel-b')!;
  const waitingA = subscriptionA.wait(100);
  const waitingB = subscriptionB.wait(100);
  rejectListener?.(new Error('synthetic disconnect'));
  await assert.rejects(waitingA, /overlay_listener_unavailable/);
  await assert.rejects(waitingB, /overlay_listener_unavailable/);
  assert.equal(wakeup.health().connected, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(wakeup.health().connected, true);
  subscriptionA.release();
  subscriptionB.release();
  await wakeup.close();
});

// RT-02.1 — a notification for channel A wakes only channel A's
// subscribers; a channel B subscriber never resolves from it.
// The wake-up registry's per-wait timeout (src/db/overlay-wakeup.ts:169) and
// its reconnect timer (:100) are deliberately `unref()`d, and that is correct
// for production: an SSE request's real socket is what keeps the event loop
// alive there, and an unref'd timer is precisely what stops a pending wake-up
// from holding the process open at shutdown.
//
// A unit test has no socket. Once one of those timers is the only pending
// handle, Node reports the loop drained before it fires, and node:test cancels
// the still-pending test with "Promise resolution is still pending but the
// event loop has already resolved". Node 24 happens not to exhibit this, which
// is why CI's pinned 22.17.0 was the first thing ever to see it -- the same
// root cause, in a second file, that keepEventLoopAliveForInject addresses for
// app.test.ts's inject() calls.
//
// The remedy is identical and stays in the harness: hold one ordinary ref'd
// handle for the test's duration, standing in for the socket production always
// has. No timing, no assertion and no production code changes -- the 1s
// interval cannot fire inside these millisecond-scale tests.
function refdTest(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      await fn();
    } finally {
      clearInterval(keepAlive);
    }
  });
}

refdTest('RT-02.1: a notification wakes only the subscribers of its own channel', async () => {
  let notify: ((value: string) => void) | undefined;
  const client = {
    listen(_channel: string, onnotify: (value: string) => void, onlisten?: () => void) {
      notify = onnotify;
      onlisten?.();
      return new Promise(() => {});
    },
    async end() {},
  };
  const wakeup = createOverlayWakeup(client);

  const subscriptionA = wakeup.subscribe('channel-a')!;
  const subscriptionB = wakeup.subscribe('channel-b')!;
  let aResolved: string | undefined;
  let bResolved: string | undefined;
  const waitingA = subscriptionA.wait(40).then((result) => { aResolved = result; });
  const waitingB = subscriptionB.wait(40).then((result) => { bResolved = result; });

  notify?.(JSON.stringify({ channelId: 'channel-a', eventId: 'event-1' }));
  await waitingA;
  assert.equal(aResolved, 'notification');
  // Channel B never woke from A's notification — it only resolves once its
  // own 40ms timeout elapses, and with 'timeout', never 'notification'.
  await waitingB;
  assert.equal(bResolved, 'timeout');

  subscriptionA.release();
  subscriptionB.release();
  await wakeup.close();
});

// RT-02.8 — malformed notifications, and notifications with no usable
// channelId, wake nobody and never throw.
refdTest('RT-02.8: malformed or channel-less notifications wake nobody and never throw', async () => {
  let notify: ((value: string) => void) | undefined;
  const client = {
    listen(_channel: string, onnotify: (value: string) => void, onlisten?: () => void) {
      notify = onnotify;
      onlisten?.();
      return new Promise(() => {});
    },
    async end() {},
  };
  const wakeup = createOverlayWakeup(client);
  const subscription = wakeup.subscribe('channel-a')!;
  let resolved: string | undefined;
  const waiting = subscription.wait(50).then((result) => { resolved = result; });

  assert.doesNotThrow(() => notify?.('not-json'));
  assert.doesNotThrow(() => notify?.(JSON.stringify({ eventId: 'no-channel-id' })));
  assert.doesNotThrow(() => notify?.(JSON.stringify({ channelId: 42 })));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(resolved, undefined);

  await waiting;
  assert.equal(resolved, 'timeout');
  assert.equal(wakeup.health?.().failures, 0);
  subscription.release();
  await wakeup.close();
});

// RT-02.9 — the registry does not leak: subscriber/channel counts return to
// baseline after every stream closes. Proven indirectly through admission:
// a ceiling of 1 is reached, then freed by release(), for the SAME channel,
// repeatedly — a leaking count would eventually refuse every subscriber.
refdTest('RT-02.9: releasing a subscription frees its admission slot, repeatedly, with no leak', async () => {
  const client = {
    listen(_channel: string, _onnotify: (value: string) => void, onlisten?: () => void) {
      onlisten?.();
      return new Promise(() => {});
    },
    async end() {},
  };
  const wakeup = createOverlayWakeup(client, { maxChannelSubscribers: 1, maxInstanceSubscribers: 1 });
  for (let i = 0; i < 50; i += 1) {
    const subscription = wakeup.subscribe('channel-a');
    assert.ok(subscription, `iteration ${i} should have been admitted after the previous release`);
    // A second concurrent subscriber is rejected while the first is open.
    assert.equal(wakeup.subscribe('channel-a'), null);
    subscription.release();
    // release() is idempotent and must not free the slot twice.
    subscription.release();
  }
  const final = wakeup.subscribe('channel-a');
  assert.ok(final);
  final.release();
  await wakeup.close();
});

refdTest('an admission ceiling rejects further subscribers on the same channel and the instance, independently', async () => {
  const client = {
    listen(_channel: string, _onnotify: (value: string) => void, onlisten?: () => void) {
      onlisten?.();
      return new Promise(() => {});
    },
    async end() {},
  };
  const wakeup = createOverlayWakeup(client, { maxChannelSubscribers: 2, maxInstanceSubscribers: 3 });
  const a1 = wakeup.subscribe('channel-a');
  const a2 = wakeup.subscribe('channel-a');
  assert.ok(a1);
  assert.ok(a2);
  // Channel ceiling (2) reached for channel-a specifically.
  assert.equal(wakeup.subscribe('channel-a'), null);
  // A different channel is unaffected by channel-a's ceiling...
  const b1 = wakeup.subscribe('channel-b');
  assert.ok(b1);
  // ...but the shared instance ceiling (3) is now reached.
  assert.equal(wakeup.subscribe('channel-b'), null);
  assert.equal(wakeup.subscribe('channel-c'), null);

  a1.release();
  const admittedAfterRelease = wakeup.subscribe('channel-c');
  assert.ok(admittedAfterRelease, 'a released slot must be usable by a different channel');

  a2.release();
  b1.release();
  admittedAfterRelease.release();
  await wakeup.close();
});

// RT-01 non-regression, restated at the wakeup layer: with no ceiling
// configured, subscribe() never rejects.
refdTest('unset admission limits never reject a subscriber', async () => {
  const client = {
    listen(_channel: string, _onnotify: (value: string) => void, onlisten?: () => void) {
      onlisten?.();
      return new Promise(() => {});
    },
    async end() {},
  };
  const wakeup = createOverlayWakeup(client);
  const subscriptions = Array.from({ length: 500 }, () => wakeup.subscribe('channel-a'));
  assert.ok(subscriptions.every((subscription) => subscription !== null));
  for (const subscription of subscriptions) subscription?.release();
  await wakeup.close();
});

refdTest('aborting a wait resolves it immediately and removes it from the registry', async () => {
  let notify: ((value: string) => void) | undefined;
  const client = {
    listen(_channel: string, onnotify: (value: string) => void, onlisten?: () => void) {
      notify = onnotify;
      onlisten?.();
      return new Promise(() => {});
    },
    async end() {},
  };
  const wakeup = createOverlayWakeup(client);
  const subscription = wakeup.subscribe('channel-aborted')!;
  const controller = new AbortController();
  let resolved = false;
  const waiting = subscription.wait(60_000, controller.signal).then(() => { resolved = true; });

  controller.abort();
  await waiting;
  assert.equal(resolved, true);

  // A later notification must not resolve a second copy of this waiter or
  // change any durable state; it is only a wake-up optimisation.
  notify?.(JSON.stringify({ channelId: 'channel-aborted', eventId: 'after-abort' }));
  subscription.release();
  await wakeup.close();
});

refdTest('notification outcomes are reported through the optional onNotification hook, without a channel or overlay identifier', async () => {
  let notify: ((value: string) => void) | undefined;
  const outcomes: string[] = [];
  const client = {
    listen(_channel: string, onnotify: (value: string) => void, onlisten?: () => void) {
      notify = onnotify;
      onlisten?.();
      return new Promise(() => {});
    },
    async end() {},
  };
  const wakeup = createOverlayWakeup(client, { onNotification: (outcome) => outcomes.push(outcome) });
  notify?.(JSON.stringify({ channelId: 'channel-a', eventId: 'e1' }));
  notify?.('not-json');
  notify?.(JSON.stringify({ eventId: 'no-channel' }));
  assert.deepEqual(outcomes, ['routed', 'unroutable', 'unroutable']);
  await wakeup.close();
});
