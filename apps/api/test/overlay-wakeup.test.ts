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

  const waiting = wakeup.wait('overlay-1', 100);
  notify?.('{"event":"synthetic"}');
  await waiting;
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

test('one durable wake-up broadcasts to every overlay waiter', async () => {
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

  let firstResolved = false;
  let secondResolved = false;
  const first = wakeup.wait('overlay-a', 100).then(() => { firstResolved = true; });
  const second = wakeup.wait('overlay-b', 100).then(() => { secondResolved = true; });
  notify?.('{"event":"committed"}');
  await Promise.all([first, second]);

  assert.equal(firstResolved, true);
  assert.equal(secondResolved, true);
  await wakeup.close();
});

test('malformed wake-up is ignored and cannot release an overlay waiter', async () => {
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
  let resolved = false;
  const waiting = wakeup.wait('overlay-a', 50).then(() => { resolved = true; });
  notify?.('not-json');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(resolved, false);
  await waiting;

  assert.equal(resolved, true);
  assert.equal(wakeup.health?.().failures, 0);
  await wakeup.close();
});

test('aborting an overlay waiter resolves it immediately and removes it', async () => {
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
  const controller = new AbortController();
  let resolved = false;
  const waiting = wakeup.wait('overlay-aborted', 60_000, controller.signal).then(() => { resolved = true; });

  controller.abort();
  await waiting;
  assert.equal(resolved, true);

  // A later notification must not resolve a second copy of this waiter or
  // change any durable state; it is only a wake-up optimisation.
  notify?.('{"event":"after-abort"}');
  await wakeup.close();
});
