import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMasterCanvasConnection } from './master-canvas-connection';
import { createMasterCanvasRuntime, type CanvasModuleDefinition } from './master-canvas-runtime';
import { createSupporterTickerModule, DEFAULT_TICKER_ROW_POOL_SIZE } from './modules/supporter-ticker-module';
import { createGoalLadderModule } from './modules/goal-ladder-module';
import { createTugOfWarVoteModule } from './modules/tug-of-war-vote-module';
import { createBossFightModule } from './modules/boss-fight-module';
import { createSupportTheaterModule } from './modules/support-theater-module';
import { createChallengeBoardModule } from './modules/challenge-board-module';
import { createMilestoneCelebrationModule } from './modules/milestone-celebration-module';

/*
 * End-to-end wiring test: the real connection, the real runtime, and both
 * real module renderers together — not each piece in isolation. This is
 * the closest this test suite gets to "a canvas holding both modules"
 * (PRF-02.1) and to PRF-02.10 (a module the server has not marked active
 * costs nothing: no subscription, no fetch, ever).
 */

function createManualFrameScheduler() {
  let nextHandle = 1;
  const pending = new Map<number, (t: number) => void>();
  return {
    requestFrame: (cb: (t: number) => void) => { const h = nextHandle++; pending.set(h, cb); return h; },
    cancelFrame: (h: number) => { pending.delete(h); },
    tick(t = 0) { const cbs = [...pending.values()]; pending.clear(); for (const cb of cbs) cb(t); },
    pendingFrameCount() { return pending.size; },
  };
}

function neverEndingStreamFetch(onCall: () => void) {
  return (async () => {
    onCall();
    return { ok: true, body: { getReader: () => ({ read: () => new Promise<{ done: boolean }>(() => {}), cancel: async () => {} }) } } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

test('a canvas with both built modules entitled opens exactly one connection', async () => {
  let fetchCalls = 0;
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => { fetchCalls += 1; }),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const tickerContainer = document.createElement('div');
  const goalContainer = document.createElement('div');
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => [], reducedMotion: () => false,
  }));
  runtime.registerModule(createGoalLadderModule({
    container: goalContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));

  runtime.start();
  runtime.setModuleEntitled('supporter_ticker', true);
  runtime.setModuleEntitled('community_goal_ladder', true);
  await flush();

  assert.equal(fetchCalls, 1, 'two entitled modules must still open exactly one transport connection');
  assert.equal(connection.getSubscriberCount(), 2);
  assert.equal(tickerContainer.children.length, DEFAULT_TICKER_ROW_POOL_SIZE, 'the ticker still mounted its recycled row pool');
});

test('PRF-02.10/this task\'s §3: a module the server never marks active is never subscribed, never fetched, never rendered', async () => {
  let fetchCalls = 0;
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => { fetchCalls += 1; }),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const tickerContainer = document.createElement('div');
  const goalContainer = document.createElement('div');
  let tickerSnapshotCalls = 0;
  let goalSnapshotCalls = 0;
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => { tickerSnapshotCalls += 1; return []; }, reducedMotion: () => false,
  }));
  runtime.registerModule(createGoalLadderModule({
    container: goalContainer, connection, fetchSnapshot: async () => { goalSnapshotCalls += 1; return null; }, reducedMotion: () => false,
  }));

  runtime.start();
  // Only the ticker is entitled (e.g. Free tier's 2-module cap already
  // spent, or the module simply disabled) — the goal ladder is NEVER
  // marked entitled.
  runtime.setModuleEntitled('supporter_ticker', true);
  await flush();

  assert.equal(fetchCalls, 1, 'the shared connection still opens exactly once, for the one entitled module');
  assert.equal(connection.getSubscriberCount(), 1, 'the un-entitled module never subscribes to the shared connection');
  assert.ok(tickerSnapshotCalls > 0, 'the entitled module does its normal work');
  assert.equal(goalSnapshotCalls, 0, 'an un-entitled module never fetches its own snapshot — it costs nothing');
  assert.equal(goalContainer.children.length, 0, 'an un-entitled module never even builds its DOM');
  assert.equal(runtime.getModuleStatus('community_goal_ladder'), 'inactive');
});

test('going hidden tears down every module\'s connection subscription, not just its rendering', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  let hidden = false;
  const listeners = new Set<() => void>();
  const visibilitySource = {
    isHidden: () => hidden,
    addEventListener: (_t: string, l: () => void) => { listeners.add(l); },
    removeEventListener: (_t: string, l: () => void) => { listeners.delete(l); },
  };
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame, visibilitySource });

  const tickerContainer = document.createElement('div');
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => [], reducedMotion: () => false,
  }));
  runtime.start();
  runtime.setModuleEntitled('supporter_ticker', true);
  await flush();
  assert.equal(connection.getSubscriberCount(), 1);

  hidden = true;
  for (const l of listeners) l();
  assert.equal(connection.getSubscriberCount(), 0, 'a hidden OBS scene must release the shared connection subscription entirely, not merely stop rendering');
});

/*
 * PRF-02 slice 2 (this task's §3 "binding constraints"): adding modules
 * #3 (Tug-of-War Vote) and #4 (Boss Fight) must add ZERO connections and
 * ZERO frame loops — the four-built-modules version of the same proof
 * master-canvas-integration.test.ts already carries for two.
 */

test('with all four built modules entitled: still exactly one connection and one rAF chain', async () => {
  let fetchCalls = 0;
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => { fetchCalls += 1; }),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const tickerContainer = document.createElement('div');
  const goalContainer = document.createElement('div');
  const voteContainer = document.createElement('div');
  const bossFightContainer = document.createElement('div');
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => [], reducedMotion: () => false,
  }));
  runtime.registerModule(createGoalLadderModule({
    container: goalContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createTugOfWarVoteModule({
    container: voteContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createBossFightModule({
    container: bossFightContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));

  runtime.start();
  runtime.setModuleEntitled('supporter_ticker', true);
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('tug_of_war_vote', true);
  runtime.setModuleEntitled('boss_fight', true);
  await flush();

  assert.equal(fetchCalls, 1, 'four entitled modules must still open exactly one transport connection — adding modules #3/#4 adds zero connections');
  assert.equal(connection.getSubscriberCount(), 4);
  // Exactly one frame is ever pending on the manual scheduler at a time,
  // regardless of how many modules are active — the same one-rAF-chain
  // property master-canvas-runtime.test.ts proves generically, reproduced
  // here with all four real built modules.
  assert.equal(scheduler.pendingFrameCount(), 1, 'four active modules must still share exactly one pending frame handle');
});

test('a throwing tug_of_war_vote module does not blank the canvas; the three real modules keep rendering on the same frame', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  const downCalls: string[] = [];
  const runtime = createMasterCanvasRuntime({
    requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame,
    onModuleDown: (key) => downCalls.push(key),
  });

  const tickerContainer = document.createElement('div');
  const goalContainer = document.createElement('div');
  const bossFightContainer = document.createElement('div');
  let tickerRenders = 0;
  let goalRenders = 0;
  let bossFightRenders = 0;
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => { tickerRenders += 1; return []; }, reducedMotion: () => false,
  }));
  runtime.registerModule(createGoalLadderModule({
    container: goalContainer, connection, fetchSnapshot: async () => { goalRenders += 1; return null; }, reducedMotion: () => false,
  }));
  runtime.registerModule(createBossFightModule({
    container: bossFightContainer, connection, fetchSnapshot: async () => { bossFightRenders += 1; return null; }, reducedMotion: () => false,
  }));
  // A deliberately broken module keyed as the real Tug-of-War Vote module
  // would be — proves the runtime's generic per-module error boundary
  // (already proven in isolation, master-canvas-runtime.test.ts) holds
  // when the failing module sits alongside the three OTHER real,
  // production module renderers on the same shared loop, not just fakes.
  const brokenVote: CanvasModuleDefinition = {
    key: 'tug_of_war_vote',
    activate() {},
    deactivate() {},
    render() { throw new Error('tug-of-war render failure'); },
  };
  runtime.registerModule(brokenVote);

  runtime.start();
  runtime.setModuleEntitled('supporter_ticker', true);
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('boss_fight', true);
  runtime.setModuleEntitled('tug_of_war_vote', true);
  await flush();

  const originalTickerRenders = tickerRenders;
  const originalGoalRenders = goalRenders;
  const originalBossFightRenders = bossFightRenders;

  scheduler.tick(0); // first failure for tug_of_war_vote
  assert.equal(runtime.getModuleStatus('tug_of_war_vote'), 'active', 'one failure does not take a module down (PRF-14: fails TWICE)');
  scheduler.tick(1); // second failure -> down
  assert.equal(runtime.getModuleStatus('tug_of_war_vote'), 'down');
  assert.deepEqual(downCalls, ['tug_of_war_vote']);

  // The three OTHER real modules kept rendering across both frames the
  // broken module threw on — the canvas was never blanked.
  assert.ok(tickerRenders >= originalTickerRenders, 'ticker module unaffected');
  assert.ok(goalRenders >= originalGoalRenders, 'goal ladder module unaffected');
  assert.ok(bossFightRenders >= originalBossFightRenders, 'boss fight module unaffected');
  assert.equal(runtime.getModuleStatus('supporter_ticker'), 'active');
  assert.equal(runtime.getModuleStatus('community_goal_ladder'), 'active');
  assert.equal(runtime.getModuleStatus('boss_fight'), 'active');
});

/*
 * PRF-02 slice 3, CORRECTED 2026-09-16: Support Theater (§6 #1) is the
 * fifth module, and it shares the SAME MasterCanvasConnection the other
 * four use — an earlier version of this slice gave it a second, dedicated
 * session and transport, which this test file's own history no longer
 * reflects (see support-theater-module.ts's and master-canvas-
 * connection.ts's own "CORRECTION" headers, and
 * reviews/2026-09-16-prf-02-slice-3-implementation.md, for why: inside
 * one Canvas there is exactly one acknowledging consumer, so there was no
 * session-sharing race to defend against by adding a second session, only
 * a second connection PRF-02 exists specifically to not need). This test
 * proves PRF-02.1/S2.8's "one transport" claim now covers all FIVE built
 * modules, not four — one connection, one rAF chain, adding the fifth
 * module adds zero connections — with `support_theater` entitled FIRST,
 * matching the real host page's own registration/entitlement order (see
 * `canvas/[overlayId]/page.tsx`'s header for why that order matters: it
 * keeps this the ordinary "everyone starts together" case rather than the
 * connection's forced-resync backstop case, which is tested directly in
 * master-canvas-connection.test.ts instead).
 */

test('with all five built modules registered (Support Theater included): still exactly one connection and one rAF chain — PRF-02.1 restored to cover all five, not four', async () => {
  let fetchCalls = 0;
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => { fetchCalls += 1; }),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const tickerContainer = document.createElement('div');
  const goalContainer = document.createElement('div');
  const voteContainer = document.createElement('div');
  const bossFightContainer = document.createElement('div');
  const theaterContainer = document.createElement('div');
  // Support Theater is registered FIRST here too, mirroring the host
  // page's own ordering (canvas/[overlayId]/page.tsx).
  runtime.registerModule(createSupportTheaterModule({
    container: theaterContainer, connection, overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    reducedMotion: () => false,
  }));
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => [], reducedMotion: () => false,
  }));
  runtime.registerModule(createGoalLadderModule({
    container: goalContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createTugOfWarVoteModule({
    container: voteContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createBossFightModule({
    container: bossFightContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));

  runtime.start();
  // support_theater entitled FIRST — see this test's own header comment.
  runtime.setModuleEntitled('support_theater', true);
  runtime.setModuleEntitled('supporter_ticker', true);
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('tug_of_war_vote', true);
  runtime.setModuleEntitled('boss_fight', true);
  await flush();

  assert.equal(fetchCalls, 1, 'five entitled modules, Support Theater included, must still open exactly one transport connection');
  assert.equal(connection.getSubscriberCount(), 5, 'all five modules are subscribers on the one shared connection');
  assert.equal(scheduler.pendingFrameCount(), 1, 'all five active modules still share exactly one pending frame handle on the one rAF scheduler');
});

/*
 * PRF-02 slice 4: Challenge Board (§6 #8, current-only) and Milestone
 * Celebration (§6 #13) are modules six and seven. Neither adds an
 * endpoint, a query or an event (Challenge Board reads the existing
 * `/v1/overlay-challenges/:overlayId` snapshot; Milestone Celebration
 * reuses the SAME goal/vote snapshot fetchers the goal/vote modules
 * already call) — this test is the seven-modules version of the same
 * "adding a module adds zero connections" proof this suite already
 * carries for two, four and five.
 */

test('with all seven modules registered (Challenge Board + Milestone Celebration included): still exactly one connection and one rAF chain', async () => {
  let fetchCalls = 0;
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => { fetchCalls += 1; }),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const tickerContainer = document.createElement('div');
  const goalContainer = document.createElement('div');
  const voteContainer = document.createElement('div');
  const bossFightContainer = document.createElement('div');
  const theaterContainer = document.createElement('div');
  const challengeContainer = document.createElement('div');
  const milestoneContainer = document.createElement('div');

  const fetchGoalSnapshot = async () => null;
  const fetchVoteSnapshot = async () => null;

  runtime.registerModule(createSupportTheaterModule({
    container: theaterContainer, connection, overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    reducedMotion: () => false,
  }));
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => [], reducedMotion: () => false,
  }));
  runtime.registerModule(createGoalLadderModule({
    container: goalContainer, connection, fetchSnapshot: fetchGoalSnapshot, reducedMotion: () => false,
  }));
  runtime.registerModule(createTugOfWarVoteModule({
    container: voteContainer, connection, fetchSnapshot: fetchVoteSnapshot, reducedMotion: () => false,
  }));
  runtime.registerModule(createBossFightModule({
    container: bossFightContainer, connection, fetchSnapshot: fetchGoalSnapshot, reducedMotion: () => false,
  }));
  runtime.registerModule(createChallengeBoardModule({
    container: challengeContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createMilestoneCelebrationModule({
    container: milestoneContainer, connection, fetchGoalSnapshot, fetchVoteSnapshot, reducedMotion: () => false,
  }));

  runtime.start();
  runtime.setModuleEntitled('support_theater', true);
  runtime.setModuleEntitled('supporter_ticker', true);
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('tug_of_war_vote', true);
  runtime.setModuleEntitled('boss_fight', true);
  runtime.setModuleEntitled('challenge_board', true);
  runtime.setModuleEntitled('milestone_celebration', true);
  await flush();

  assert.equal(fetchCalls, 1, 'seven entitled modules must still open exactly one transport connection — adding Challenge Board and Milestone Celebration adds zero connections');
  assert.equal(connection.getSubscriberCount(), 7, 'all seven modules are subscribers on the one shared connection');
  assert.equal(scheduler.pendingFrameCount(), 1, 'all seven active modules still share exactly one pending frame handle on the one rAF scheduler');
});
