import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplayCoalescer } from '../src/domain/overlay-replay-coalescer.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// RT-02.2 — two callers for the same key, arriving while the first is still
// in flight, cause exactly one underlying read; both receive its result.
test('RT-02.2: concurrent callers for the same key share exactly one read', async () => {
  const coalescer = createReplayCoalescer<string[]>();
  let reads = 0;
  const gate = deferred<string[]>();
  const fn = async () => { reads += 1; return gate.promise; };

  const first = coalescer.run('channel-a|cursor-1|50', fn);
  const second = coalescer.run('channel-a|cursor-1|50', fn);
  gate.resolve(['event-1']);
  const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

  assert.equal(reads, 1);
  assert.deepEqual(firstOutcome, { result: ['event-1'], shared: false });
  assert.deepEqual(secondOutcome, { result: ['event-1'], shared: true });
});

// RT-02.6 — different cursors (or any other key component) are never
// coalesced: each key gets its own read.
test('RT-02.6: different keys are never coalesced', async () => {
  const coalescer = createReplayCoalescer<string[]>();
  let reads = 0;
  const fn = async () => { reads += 1; return ['x']; };

  await Promise.all([
    coalescer.run('channel-a|cursor-1|50', fn),
    coalescer.run('channel-a|cursor-2|50', fn),
    coalescer.run('channel-b|cursor-1|50', fn),
    coalescer.run('channel-a|cursor-1|25', fn),
  ]);

  assert.equal(reads, 4);
});

// RT-02.5(part 1) — a leader read that resolves to null (its own session
// was invalid) does not hand followers a null result; they fall back to
// their own read.
test('RT-02.5: a null leader result does not propagate — followers fall back to their own read', async () => {
  const coalescer = createReplayCoalescer<string[]>();
  let leaderCalls = 0;
  let followerCalls = 0;
  const gate = deferred<string[] | null>();
  const leaderFn = async () => { leaderCalls += 1; return gate.promise; };
  const followerFn = async () => { followerCalls += 1; return ['fallback-event']; };

  const leader = coalescer.run('channel-a|cursor-1|50', leaderFn);
  const follower = coalescer.run('channel-a|cursor-1|50', followerFn);
  gate.resolve(null);

  const [leaderOutcome, followerOutcome] = await Promise.all([leader, follower]);
  assert.equal(leaderCalls, 1);
  assert.equal(followerCalls, 1, 'a null leader result must trigger the follower\'s own read');
  assert.deepEqual(leaderOutcome, { result: null, shared: false });
  assert.deepEqual(followerOutcome, { result: ['fallback-event'], shared: false });
});

// RT-02.5(part 2) / RT-02.10 — a leader read that throws (including an
// abort/disconnect mid-read) does not reject the follower; the follower
// falls back to its own read instead of inheriting the leader's failure.
test('RT-02.5/RT-02.10: a leader read that throws does not reject followers', async () => {
  const coalescer = createReplayCoalescer<string[]>();
  let followerCalls = 0;
  const gate = deferred<string[]>();
  const leaderFn = async () => gate.promise;
  const followerFn = async () => { followerCalls += 1; return ['fallback-event']; };

  const leader = coalescer.run('channel-a|cursor-1|50', leaderFn);
  const follower = coalescer.run('channel-a|cursor-1|50', followerFn);
  gate.reject(new Error('aborted: client disconnected mid-read'));

  await assert.rejects(leader, /aborted/);
  const followerOutcome = await follower;
  assert.equal(followerCalls, 1);
  assert.deepEqual(followerOutcome, { result: ['fallback-event'], shared: false });
});

test('a later call for the same key after the in-flight one settles starts a fresh read', async () => {
  const coalescer = createReplayCoalescer<string[]>();
  let reads = 0;
  const fn = async () => { reads += 1; return [`event-${reads}`]; };

  const first = await coalescer.run('channel-a|cursor-1|50', fn);
  const second = await coalescer.run('channel-a|cursor-1|50', fn);

  assert.equal(reads, 2);
  assert.deepEqual(first, { result: ['event-1'], shared: false });
  assert.deepEqual(second, { result: ['event-2'], shared: false });
});
