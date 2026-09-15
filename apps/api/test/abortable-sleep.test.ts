import assert from 'node:assert/strict';
import test from 'node:test';
import { abortableSleep } from '../src/domain/abortable-sleep.js';

test('abortable fallback sleep resolves promptly and cleans up its timer/listener', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = abortableSleep(60_000, controller.signal);
  controller.abort();
  await pending;
  assert.ok(Date.now() - started < 250);
  assert.equal(controller.signal.onabort, null);
  // A second abort cannot trigger a retained waiter or cause any work.
  controller.abort();
});
