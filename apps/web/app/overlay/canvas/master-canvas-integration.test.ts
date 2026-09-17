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
import { createStreamMissionModule } from './modules/stream-mission-module';
import { createModeratorStatusModule } from './modules/moderator-status-module';
import { createReactionCloudModule } from './modules/reaction-cloud-module';
import { createLobbyStatusModule } from './modules/lobby-status-module';
import { createGiveawayTournamentModule } from './modules/giveaway-tournament-module';
import { createMediaQueueModule } from './modules/media-queue-module';
import { createSafeSoundboardModule } from './modules/safe-soundboard-module';

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

/*
 * PRF-02 slice 5: Stream Mission Card (§6 #9) is module eight, and the
 * first since slice 1 to add an endpoint of its own (migration 0135's
 * `/v1/overlay-widgets/:overlayId/stream-mission`). A new ENDPOINT is not
 * a new TRANSPORT — this is the eight-modules version of the same
 * "adding a module adds zero connections and zero frame loops" proof this
 * suite already carries for two, four, five and seven, and it is the case
 * that would fail if the module had been given a session of its own.
 */

test('with all eight built modules registered (Stream Mission Card included): still exactly one connection and one rAF chain', async () => {
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
  const missionContainer = document.createElement('div');

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
  runtime.registerModule(createStreamMissionModule({
    container: missionContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));

  runtime.start();
  runtime.setModuleEntitled('support_theater', true);
  runtime.setModuleEntitled('supporter_ticker', true);
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('tug_of_war_vote', true);
  runtime.setModuleEntitled('boss_fight', true);
  runtime.setModuleEntitled('challenge_board', true);
  runtime.setModuleEntitled('milestone_celebration', true);
  runtime.setModuleEntitled('stream_mission_card', true);
  await flush();

  assert.equal(fetchCalls, 1, 'eight entitled modules must still open exactly one transport connection — the Stream Mission Card adds an endpoint, never a session');
  assert.equal(connection.getSubscriberCount(), 8, 'all eight modules are subscribers on the one shared connection');
  assert.equal(scheduler.pendingFrameCount(), 1, 'all eight active modules still share exactly one pending frame handle on the one rAF scheduler');
});

test('PRF-02.10: an un-entitled stream_mission_card never subscribes, never fetches its snapshot and never builds its DOM', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const tickerContainer = document.createElement('div');
  const missionContainer = document.createElement('div');
  let missionSnapshotCalls = 0;
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => [], reducedMotion: () => false,
  }));
  runtime.registerModule(createStreamMissionModule({
    container: missionContainer, connection,
    fetchSnapshot: async () => { missionSnapshotCalls += 1; return null; },
    reducedMotion: () => false,
  }));

  runtime.start();
  // Only the ticker is entitled — e.g. a Free channel's two-module cap is
  // already spent elsewhere. The mission record still exists server-side
  // and is still readable by the creator (§12.6); it simply is not
  // rendered, which is the only thing §30.3's cap governs.
  runtime.setModuleEntitled('supporter_ticker', true);
  await flush();

  assert.equal(connection.getSubscriberCount(), 1, 'the un-entitled mission module never subscribes to the shared connection');
  assert.equal(missionSnapshotCalls, 0, 'an un-entitled module never fetches its own snapshot — it costs nothing');
  assert.equal(missionContainer.children.length, 0, 'an un-entitled module never even builds its DOM');
  assert.equal(runtime.getModuleStatus('stream_mission_card'), 'inactive');
});

/*
 * PRF-02 slice 5: Moderator Status Card (§6 #12, HELD HALF ONLY) is the
 * ninth built module. It adds ONE endpoint and — the property this file
 * exists to defend — ZERO connections, ZERO sessions and ZERO render
 * loops. This is the nine-module version of the same proof the suite
 * already carries for two, four, five, seven and eight.
 */

test('with all nine modules registered (Moderator Status Card included): still exactly one connection and one rAF chain', async () => {
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
  const missionContainer = document.createElement('div');
  const moderatorStatusContainer = document.createElement('div');

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
  runtime.registerModule(createStreamMissionModule({
    container: missionContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createModeratorStatusModule({
    container: moderatorStatusContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));

  runtime.start();
  runtime.setModuleEntitled('support_theater', true);
  runtime.setModuleEntitled('supporter_ticker', true);
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('tug_of_war_vote', true);
  runtime.setModuleEntitled('boss_fight', true);
  runtime.setModuleEntitled('challenge_board', true);
  runtime.setModuleEntitled('milestone_celebration', true);
  runtime.setModuleEntitled('stream_mission_card', true);
  runtime.setModuleEntitled('moderator_status_card', true);
  await flush();

  assert.equal(fetchCalls, 1, 'nine entitled modules must still open exactly one transport connection — the Moderator Status Card adds an endpoint, never a session');
  assert.equal(connection.getSubscriberCount(), 9, 'all nine modules are subscribers on the one shared connection');
  assert.equal(scheduler.pendingFrameCount(), 1, 'all nine active modules still share exactly one pending frame handle on the one rAF scheduler');
});

test('PRF-02: safe mode paints on the SAME shared connection and rAF loop — it adds a field, never a session, a read or a frame', async () => {
  // Safe mode (migration 0138) completes §6 module #12 by adding one
  // boolean to the Moderator Status Card's EXISTING snapshot. This case
  // is the canvas-level proof that it cost nothing structurally: one
  // transport connection, one subscriber, one snapshot read per
  // activation, and one shared pending frame — the same shape the card
  // had with the held half alone.
  let fetchCalls = 0;
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => { fetchCalls += 1; }),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const moderatorStatusContainer = document.createElement('div');
  let snapshotCalls = 0;
  let safeMode = true;
  runtime.registerModule(createModeratorStatusModule({
    container: moderatorStatusContainer,
    connection,
    fetchSnapshot: async () => { snapshotCalls += 1; return { schemaVersion: 'v1', heldCount: 0, safeMode }; },
    reducedMotion: () => false,
  }));

  runtime.start();
  runtime.setModuleEntitled('moderator_status_card', true);
  await flush();
  scheduler.tick(0);

  assert.equal(fetchCalls, 1, 'safe mode must not open a second transport connection');
  assert.equal(connection.getSubscriberCount(), 1, 'safe mode must not add a second subscriber');
  assert.equal(snapshotCalls, 1, 'safe mode travels on the EXISTING snapshot — it must not add a second read');
  assert.equal(
    (moderatorStatusContainer.querySelector('[data-role="moderator-status-label"]') as HTMLElement).textContent,
    'safe mode on',
    'safe mode on with nothing held must paint on the shared loop',
  );
  assert.equal(scheduler.pendingFrameCount(), 1, 'one shared pending frame, as before');

  // Take the module down and back up: one fresh re-read on the same
  // connection, now with safe mode off and nothing held, which hides the
  // card again. No second connection, no second subscriber, no extra
  // frame handle.
  safeMode = false;
  runtime.setModuleEntitled('moderator_status_card', false);
  await flush();
  runtime.setModuleEntitled('moderator_status_card', true);
  await flush();
  scheduler.tick(16);

  // fetchCalls is 2 here and that is the connection's own documented
  // behaviour, not a cost safe mode introduced: the stream closes when
  // the LAST subscriber leaves and reopens on the next one (PRF-05,
  // "idle modules cost nothing"). What matters is that there is never
  // more than one stream open AT A TIME, which the subscriber count
  // below shows.
  assert.equal(fetchCalls, 2, 'the shared stream closed with its last subscriber and reopened with the next — one connection at a time, never two');
  assert.equal(connection.getSubscriberCount(), 1, 'still exactly one subscriber');
  assert.equal(snapshotCalls, 2, 'one re-read per activation, exactly as before safe mode existed');
  assert.equal(moderatorStatusContainer.style.opacity, '0', 'safe mode off with nothing held hides the card again — it does not latch on');
  assert.equal(scheduler.pendingFrameCount(), 1, 'safe mode must never schedule a frame of its own');
});

test('PRF-02.10: an un-entitled moderator_status_card never subscribes, never fetches its snapshot and never builds its DOM', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const tickerContainer = document.createElement('div');
  const moderatorStatusContainer = document.createElement('div');
  let moderatorSnapshotCalls = 0;
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => [], reducedMotion: () => false,
  }));
  runtime.registerModule(createModeratorStatusModule({
    container: moderatorStatusContainer, connection,
    fetchSnapshot: async () => { moderatorSnapshotCalls += 1; return null; },
    reducedMotion: () => false,
  }));

  runtime.start();
  // Only the ticker is entitled. §30.3's cap governs how many modules a
  // tier may RENDER; it never gates the underlying moderation records,
  // which stay complete and reachable by the creator (§12.6). An
  // un-entitled card simply costs nothing.
  runtime.setModuleEntitled('supporter_ticker', true);
  await flush();

  assert.equal(connection.getSubscriberCount(), 1, 'the un-entitled moderator status module never subscribes to the shared connection');
  assert.equal(moderatorSnapshotCalls, 0, 'an un-entitled module never fetches its own snapshot — it costs nothing');
  assert.equal(moderatorStatusContainer.children.length, 0, 'an un-entitled module never even builds its DOM');
  assert.equal(runtime.getModuleStatus('moderator_status_card'), 'inactive');
});

test('a Moderator Status Card that throws twice goes down while every other module keeps rendering (PRF-14)', async () => {
  // The per-module error boundary is the runtime's, not this module's —
  // proven here with the real runtime and a real neighbour so "one
  // module failing must never blank the canvas" (§6) is asserted for
  // this module rather than assumed to be inherited.
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  const down: string[] = [];
  const runtime = createMasterCanvasRuntime({
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
    onModuleDown: (key) => down.push(key),
  });

  let neighbourRenders = 0;
  const neighbour: CanvasModuleDefinition = {
    key: 'community_goal_ladder',
    activate() {},
    deactivate() {},
    render() { neighbourRenders += 1; },
  };
  const exploding: CanvasModuleDefinition = {
    key: 'moderator_status_card',
    activate() {},
    deactivate() {},
    render() { throw new Error('synthetic moderator status failure'); },
  };
  runtime.registerModule(neighbour);
  runtime.registerModule(exploding);

  runtime.start();
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('moderator_status_card', true);
  await flush();

  for (let frame = 0; frame < 4; frame += 1) {
    scheduler.tick(frame * 16);
    await flush();
  }

  assert.equal(runtime.getModuleStatus('moderator_status_card'), 'down', 'two failures must take the module down and keep it down');
  assert.ok(down.includes('moderator_status_card'), 'the host page is told, so it can show the creator-visible note');
  assert.equal(runtime.getModuleStatus('community_goal_ladder'), 'active', 'a neighbour must be unaffected');
  assert.ok(neighbourRenders >= 2, 'the neighbour keeps rendering on the same loop after the failure');
});

/*
 * PRF-02 slice 6 / PRF-06: Reaction Cloud (§6 #5) is the tenth built
 * module. It adds ONE endpoint and — the property this file exists to
 * defend — ZERO connections, ZERO sessions and ZERO render loops. This is
 * the ten-module version of the same proof the suite already carries for
 * two, four, five, seven, eight and nine.
 */

test('with all ten modules registered (Reaction Cloud included): still exactly one connection and one rAF chain', async () => {
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
  const missionContainer = document.createElement('div');
  const moderatorStatusContainer = document.createElement('div');
  const reactionCloudContainer = document.createElement('div');

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
  runtime.registerModule(createStreamMissionModule({
    container: missionContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createModeratorStatusModule({
    container: moderatorStatusContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createReactionCloudModule({
    container: reactionCloudContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));

  runtime.start();
  runtime.setModuleEntitled('support_theater', true);
  runtime.setModuleEntitled('supporter_ticker', true);
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('tug_of_war_vote', true);
  runtime.setModuleEntitled('boss_fight', true);
  runtime.setModuleEntitled('challenge_board', true);
  runtime.setModuleEntitled('milestone_celebration', true);
  runtime.setModuleEntitled('stream_mission_card', true);
  runtime.setModuleEntitled('moderator_status_card', true);
  runtime.setModuleEntitled('reaction_cloud', true);
  await flush();

  assert.equal(fetchCalls, 1, 'ten entitled modules must still open exactly one transport connection — the Reaction Cloud adds an endpoint, never a session');
  assert.equal(connection.getSubscriberCount(), 10, 'all ten modules are subscribers on the one shared connection');
  assert.equal(scheduler.pendingFrameCount(), 1, 'all ten active modules still share exactly one pending frame handle on the one rAF scheduler');
});

test('PRF-02.10: an un-entitled reaction_cloud never subscribes, never fetches its snapshot and never builds its DOM', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const tickerContainer = document.createElement('div');
  const reactionCloudContainer = document.createElement('div');
  let reactionSnapshotCalls = 0;
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => [], reducedMotion: () => false,
  }));
  runtime.registerModule(createReactionCloudModule({
    container: reactionCloudContainer, connection,
    fetchSnapshot: async () => { reactionSnapshotCalls += 1; return null; },
    reducedMotion: () => false,
  }));

  runtime.start();
  // Only the ticker is entitled. §30.3's module cap governs how many
  // modules a tier may RENDER; it never gates reactions themselves, which
  // §30.3's own tier table makes available at every tier, nor the durable
  // reaction record.
  runtime.setModuleEntitled('supporter_ticker', true);
  await flush();

  assert.equal(connection.getSubscriberCount(), 1, 'the un-entitled reaction cloud never subscribes to the shared connection');
  assert.equal(reactionSnapshotCalls, 0, 'an un-entitled module never fetches its own snapshot — it costs nothing');
  assert.equal(reactionCloudContainer.children.length, 0, 'an un-entitled module never even builds its DOM');
  assert.equal(runtime.getModuleStatus('reaction_cloud'), 'inactive');
});

test('a Reaction Cloud that throws twice goes down while every other module keeps rendering (PRF-14)', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  const down: string[] = [];
  const runtime = createMasterCanvasRuntime({
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
    onModuleDown: (key) => down.push(key),
  });

  let neighbourRenders = 0;
  const neighbour: CanvasModuleDefinition = {
    key: 'community_goal_ladder',
    activate() {},
    deactivate() {},
    render() { neighbourRenders += 1; },
  };
  const exploding: CanvasModuleDefinition = {
    key: 'reaction_cloud',
    activate() {},
    deactivate() {},
    render() { throw new Error('synthetic reaction cloud failure'); },
  };
  runtime.registerModule(neighbour);
  runtime.registerModule(exploding);

  runtime.start();
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('reaction_cloud', true);
  await flush();

  for (let frame = 0; frame < 4; frame += 1) {
    scheduler.tick(frame * 16);
    await flush();
  }

  assert.equal(runtime.getModuleStatus('reaction_cloud'), 'down', 'two failures must take the module down and keep it down');
  assert.ok(down.includes('reaction_cloud'), 'the host page is told, so it can show the creator-visible note');
  assert.equal(runtime.getModuleStatus('community_goal_ladder'), 'active', 'a neighbour must be unaffected');
  assert.ok(neighbourRenders >= 2, 'the neighbour keeps rendering on the same loop after the failure');
});

test('with all eleven modules registered (Lobby Status included): still exactly one connection and one rAF chain', async () => {
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
  const missionContainer = document.createElement('div');
  const moderatorStatusContainer = document.createElement('div');
  const reactionCloudContainer = document.createElement('div');
  const lobbyStatusContainer = document.createElement('div');
  const giveawayTournamentContainer = document.createElement('div');
  const mediaQueueContainer = document.createElement('div');
  const safeSoundboardContainer = document.createElement('div');

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
  runtime.registerModule(createStreamMissionModule({
    container: missionContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createModeratorStatusModule({
    container: moderatorStatusContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createReactionCloudModule({
    container: reactionCloudContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createLobbyStatusModule({
    container: lobbyStatusContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createGiveawayTournamentModule({
    container: giveawayTournamentContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createMediaQueueModule({
    container: mediaQueueContainer, connection, fetchSnapshot: async () => [], reducedMotion: () => false,
  }));
  runtime.registerModule(createSafeSoundboardModule({
    container: safeSoundboardContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));

  runtime.start();
  runtime.setModuleEntitled('support_theater', true);
  runtime.setModuleEntitled('supporter_ticker', true);
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('tug_of_war_vote', true);
  runtime.setModuleEntitled('boss_fight', true);
  runtime.setModuleEntitled('challenge_board', true);
  runtime.setModuleEntitled('milestone_celebration', true);
  runtime.setModuleEntitled('stream_mission_card', true);
  runtime.setModuleEntitled('moderator_status_card', true);
  runtime.setModuleEntitled('reaction_cloud', true);
  runtime.setModuleEntitled('lobby_status', true);
  runtime.setModuleEntitled('giveaway_tournament_card', true);
  runtime.setModuleEntitled('media_meme_queue', true);
  runtime.setModuleEntitled('safe_soundboard_alert', true);
  await flush();

  assert.equal(fetchCalls, 1, 'fourteen entitled modules must still open exactly one transport connection — the Safe Soundboard Alert adds an endpoint, never a session');
  assert.equal(connection.getSubscriberCount(), 14, 'all fourteen modules are subscribers on the one shared connection');
  assert.equal(scheduler.pendingFrameCount(), 1, 'all fourteen active modules still share exactly one pending frame handle on the one rAF scheduler — the countdown ticks on THIS loop, never on a timer of its own');
});

test('PRF-02: the Lobby Status card paints on the SAME shared connection and rAF loop, and the whole canvas keeps one of each', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const goalContainer = document.createElement('div');
  const lobbyStatusContainer = document.createElement('div');
  let lobbySnapshotCalls = 0;

  runtime.registerModule(createGoalLadderModule({
    container: goalContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createLobbyStatusModule({
    container: lobbyStatusContainer,
    connection,
    fetchSnapshot: async () => {
      lobbySnapshotCalls += 1;
      return { schemaVersion: 'v1' as const, seatCount: 16, confirmedSeatCount: 8, queueCount: 12 };
    },
    reducedMotion: () => false,
  }));

  runtime.start();
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('lobby_status', true);
  await flush();
  scheduler.tick(0);
  await flush();

  assert.ok(lobbySnapshotCalls >= 1, 'the module reads its snapshot off the shared connection signal, not a timer of its own');
  assert.equal(connection.getSubscriberCount(), 2, 'both modules subscribe to the ONE shared connection');
  assert.equal(scheduler.pendingFrameCount(), 1, 'both modules share the ONE rAF loop');

  const label = lobbyStatusContainer.querySelector('[data-role="lobby-status-label"]') as HTMLElement;
  assert.equal(label.textContent, '8/16 seats confirmed · 12 in queue');
  // §16 on the rendered surface as well as in the query: nothing here is a
  // code, a password, a player name or an avatar.
  const rendered = (lobbyStatusContainer.textContent ?? '').toLowerCase();
  for (const forbidden of ['code', 'password', 'player', 'discord', 'avatar', 'http']) {
    assert.ok(!rendered.includes(forbidden), `the rendered lobby card must never contain "${forbidden}"`);
  }
});

test('PRF-02: the Giveaway / Tournament card paints on the SAME shared connection and rAF loop, and its countdown ticks on THAT loop', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const goalContainer = document.createElement('div');
  const giveawayTournamentContainer = document.createElement('div');
  let giveawaySnapshotCalls = 0;
  let nowMs = Date.parse('2026-09-17T10:00:00.000Z');

  runtime.registerModule(createGoalLadderModule({
    container: goalContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createGiveawayTournamentModule({
    container: giveawayTournamentContainer,
    connection,
    fetchSnapshot: async () => {
      giveawaySnapshotCalls += 1;
      return {
        schemaVersion: 'v1' as const,
        entryCount: 143,
        entryClosesAt: '2026-09-17T10:30:00.000Z',
        tournamentCurrentRound: 2,
        tournamentTotalRounds: 3,
        tournamentCompletedMatchesInRound: 1,
        tournamentMatchesInRound: 2,
      };
    },
    reducedMotion: () => false,
    now: () => nowMs,
  }));

  runtime.start();
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('giveaway_tournament_card', true);
  await flush();
  scheduler.tick(0);
  await flush();

  assert.ok(giveawaySnapshotCalls >= 1, 'the module reads its snapshot off the shared connection signal, not a timer of its own');
  assert.equal(connection.getSubscriberCount(), 2, 'both modules subscribe to the ONE shared connection');
  assert.equal(scheduler.pendingFrameCount(), 1, 'both modules share the ONE rAF loop');

  const giveawayLine = giveawayTournamentContainer.querySelector('[data-role="giveaway-line"]') as HTMLElement;
  const tournamentLine = giveawayTournamentContainer.querySelector('[data-role="tournament-line"]') as HTMLElement;
  assert.equal(giveawayLine.textContent, '143 entries · closes in 30:00');
  assert.equal(tournamentLine.textContent, 'Round 2 of 3 · 1 of 2 matches complete');

  // THE COUNTDOWN ADVANCES ON THE SHARED SCHEDULER'S NEXT FRAME, with no
  // refetch and no timer of this module's own: still one connection, still
  // one pending frame.
  const callsBefore = giveawaySnapshotCalls;
  nowMs += 65_000;
  scheduler.tick(16);
  await flush();
  assert.equal(giveawayLine.textContent, '143 entries · closes in 28:55');
  assert.equal(giveawaySnapshotCalls, callsBefore, 'a countdown tick must not cost a fetch');
  assert.equal(connection.getSubscriberCount(), 2, 'the countdown adds no third subscriber and opens no second connection');
  assert.equal(scheduler.pendingFrameCount(), 1, 'the countdown schedules no second frame loop');

  // §17 on the rendered surface as well as in the query: nothing here is a
  // winner, a prize, an address, a claim link, a seed or a participant.
  const rendered = (giveawayTournamentContainer.textContent ?? '').toLowerCase();
  for (const forbidden of ['winner', 'champion', 'prize', 'escrow', 'claim', 'address', 'seed', 'player', 'discord', 'avatar', 'http']) {
    assert.ok(!rendered.includes(forbidden), `the rendered giveaway/tournament card must never contain "${forbidden}"`);
  }
});

test('PRF-02.10: an un-entitled giveaway_tournament_card never subscribes, never fetches its snapshot and never builds its DOM', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const goalContainer = document.createElement('div');
  const giveawayTournamentContainer = document.createElement('div');
  let giveawaySnapshotCalls = 0;

  runtime.registerModule(createGoalLadderModule({
    container: goalContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createGiveawayTournamentModule({
    container: giveawayTournamentContainer, connection,
    fetchSnapshot: async () => { giveawaySnapshotCalls += 1; return null; },
    reducedMotion: () => false,
  }));

  runtime.start();
  runtime.setModuleEntitled('community_goal_ladder', true);
  // §30.3's Creator+/Events-Pack entitlement is 0140's own
  // app_private.events_pack_entitled, called from inside
  // app_private.list_overlay_giveaway_tournament (migration 0142) rather
  // than reimplemented. It gates only whether the CANVAS renders the card,
  // never the creator's own giveaway or tournament record. 0131's §30.3
  // module cap is the second, independent gate.
  runtime.setModuleEntitled('giveaway_tournament_card', false);
  await flush();
  scheduler.tick(0);
  await flush();

  assert.equal(connection.getSubscriberCount(), 1, 'the un-entitled card never subscribes to the shared connection');
  assert.equal(giveawaySnapshotCalls, 0, 'an un-entitled module never fetches its own snapshot — it costs nothing');
  assert.equal(giveawayTournamentContainer.children.length, 0, 'an un-entitled module never even builds its DOM');
  assert.equal(runtime.getModuleStatus('giveaway_tournament_card'), 'inactive');
});

test('PRF-02.10: an un-entitled media_meme_queue never subscribes, never fetches its snapshot and never builds its DOM', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const goalContainer = document.createElement('div');
  const mediaQueueContainer = document.createElement('div');
  let mediaQueueSnapshotCalls = 0;

  runtime.registerModule(createGoalLadderModule({
    container: goalContainer, connection, fetchSnapshot: async () => null, reducedMotion: () => false,
  }));
  runtime.registerModule(createMediaQueueModule({
    container: mediaQueueContainer, connection,
    fetchSnapshot: async () => { mediaQueueSnapshotCalls += 1; return []; },
    reducedMotion: () => false,
  }));

  runtime.start();
  runtime.setModuleEntitled('community_goal_ladder', true);
  // This module has NO PER-MODULE §30.3 entitlement of its own (unlike
  // the Giveaway / Tournament card above) — only migration 0131's
  // existing, untouched, module-wide "Master Canvas modules active" cap
  // governs whether the Canvas renders it, and that is what
  // setModuleEntitled(false) simulates here.
  runtime.setModuleEntitled('media_meme_queue', false);
  await flush();
  scheduler.tick(0);
  await flush();

  assert.equal(connection.getSubscriberCount(), 1, 'the un-entitled module never subscribes to the shared connection');
  assert.equal(mediaQueueSnapshotCalls, 0, 'an un-entitled module never fetches its own snapshot — it costs nothing');
  assert.equal(mediaQueueContainer.children.length, 0, 'an un-entitled module never even builds its DOM');
  assert.equal(runtime.getModuleStatus('media_meme_queue'), 'inactive');
});

test('PRF-02.10: an un-entitled lobby_status never subscribes, never fetches its snapshot and never builds its DOM', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  const runtime = createMasterCanvasRuntime({ requestFrame: scheduler.requestFrame, cancelFrame: scheduler.cancelFrame });

  const tickerContainer = document.createElement('div');
  const lobbyStatusContainer = document.createElement('div');
  let lobbySnapshotCalls = 0;
  runtime.registerModule(createSupporterTickerModule({
    container: tickerContainer, connection, fetchSnapshot: async () => [], reducedMotion: () => false,
  }));
  runtime.registerModule(createLobbyStatusModule({
    container: lobbyStatusContainer, connection,
    fetchSnapshot: async () => { lobbySnapshotCalls += 1; return null; },
    reducedMotion: () => false,
  }));

  runtime.start();
  // Only the ticker is entitled. Two independent server-side gates can
  // produce this state: §30.3's module cap (migration 0131) and the
  // Creator+/Events Pack entitlement inside
  // app_private.list_overlay_lobby_status (migration 0140). Neither gates
  // the creator's own lobby record — only whether the canvas renders it.
  runtime.setModuleEntitled('supporter_ticker', true);
  await flush();

  assert.equal(connection.getSubscriberCount(), 1, 'the un-entitled lobby status never subscribes to the shared connection');
  assert.equal(lobbySnapshotCalls, 0, 'an un-entitled module never fetches its own snapshot — it costs nothing');
  assert.equal(lobbyStatusContainer.children.length, 0, 'an un-entitled module never even builds its DOM');
  assert.equal(runtime.getModuleStatus('lobby_status'), 'inactive');
});

test('a Lobby Status card that throws twice goes down while every other module keeps rendering (PRF-14)', async () => {
  const connection = createMasterCanvasConnection({
    overlayId: 'ov1', token: 'tok', apiOrigin: 'https://api.example.test',
    fetchImpl: neverEndingStreamFetch(() => {}),
  });
  const scheduler = createManualFrameScheduler();
  const down: string[] = [];
  const runtime = createMasterCanvasRuntime({
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
    onModuleDown: (key) => down.push(key),
  });

  let neighbourRenders = 0;
  const neighbour: CanvasModuleDefinition = {
    key: 'community_goal_ladder',
    activate() {},
    deactivate() {},
    render() { neighbourRenders += 1; },
  };
  const exploding: CanvasModuleDefinition = {
    key: 'lobby_status',
    activate() {},
    deactivate() {},
    render() { throw new Error('synthetic lobby status failure'); },
  };
  runtime.registerModule(neighbour);
  runtime.registerModule(exploding);

  runtime.start();
  runtime.setModuleEntitled('community_goal_ladder', true);
  runtime.setModuleEntitled('lobby_status', true);
  await flush();

  for (let frame = 0; frame < 4; frame += 1) {
    scheduler.tick(frame * 16);
    await flush();
  }

  assert.equal(runtime.getModuleStatus('lobby_status'), 'down', 'two failures must take the module down and keep it down');
  assert.ok(down.includes('lobby_status'), 'the host page is told, so it can show the creator-visible note');
  assert.equal(runtime.getModuleStatus('community_goal_ladder'), 'active', 'a neighbour must be unaffected');
  assert.ok(neighbourRenders >= 2, 'the neighbour keeps rendering on the same loop after the failure');
});
