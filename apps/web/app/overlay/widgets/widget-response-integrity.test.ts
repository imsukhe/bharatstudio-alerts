import assert from 'node:assert/strict';
import test from 'node:test';
import { isOverlayGoal } from './goal/goal-widget-logic';
import { isOverlayChallenge } from './challenge/challenge-widget-logic';
import { isOverlayLeaderboard } from './leaderboard/leaderboard-widget-logic';
import { isOverlayHypeMode } from './hype/hype-widget-logic';
import { isOverlayVoteTally } from './vote/vote-widget-logic';
import { isExactRecord } from './shared/response-validation';

test('overlay widget guards accept only exact finite, bounded and enumerated v1 values', () => {
  const goal = { schemaVersion: 'v1', goalId: 'goal-1', title: 'Fund the stream', targetAmountPaise: 1000, window: 'open', progressPaise: 500, reached: false };
  assert.equal(isOverlayGoal(goal), true);
  assert.equal(isOverlayGoal({ ...goal, paymentId: 'private-payment' }), false);
  assert.equal(isOverlayGoal({ ...goal, window: 'forever' }), false);
  assert.equal(isOverlayGoal({ ...goal, progressPaise: Number.NaN }), false);

  const challenge = { schemaVersion: 'v1', challengeId: 'challenge-1', title: 'Challenge', kind: 'stake', targetAmountPaise: 1000, state: 'active', progressPaise: 500, targetReached: false };
  assert.equal(isOverlayChallenge(challenge), true);
  assert.equal(isOverlayChallenge({ ...challenge, providerUserId: 'private-provider' }), false);
  assert.equal(isOverlayChallenge({ ...challenge, kind: 'unknown' }), false);
  assert.equal(isOverlayChallenge({ ...challenge, targetAmountPaise: -1 }), false);

  const leaderboard = { schemaVersion: 'v1', window: 'weekly', rows: [{ rank: 1, viewerRef: 'supporter-1', tierLabel: 'Top supporter' }] };
  assert.equal(isOverlayLeaderboard(leaderboard), true);
  assert.equal(isOverlayLeaderboard({ ...leaderboard, rows: [{ ...leaderboard.rows[0], amountPaise: 5000 }] }), false);
  assert.equal(isOverlayLeaderboard({ ...leaderboard, window: 'all-time' }), false);
  assert.equal(isOverlayLeaderboard({ ...leaderboard, rows: [{ ...leaderboard.rows[0], rank: 0 }] }), false);

  const hype = { schemaVersion: 'v1', meterPaise: 500, thresholdPaise: 1000, reached: false, startedAt: '2026-09-09T00:00:00.000Z', endsAt: '2026-09-09T01:00:00.000Z', ended: false };
  assert.equal(isOverlayHypeMode(hype), true);
  assert.equal(isOverlayHypeMode({ ...hype, accessToken: 'secret' }), false);
  assert.equal(isOverlayHypeMode({ ...hype, startedAt: 'not-a-date' }), false);
  assert.equal(isOverlayHypeMode({ ...hype, thresholdPaise: Number.POSITIVE_INFINITY }), false);

  const votes = { schemaVersion: 'v1', options: [{ optionKey: 'yes', label: 'Yes', voteCount: 2 }], resolved: false, resolvedOptionKey: null };
  assert.equal(isOverlayVoteTally(votes), true);
  assert.equal(isOverlayVoteTally({ ...votes, viewerAccountId: 'private-account' }), false);
  assert.equal(isOverlayVoteTally({ ...votes, options: [{ ...votes.options[0], voteCount: -1 }] }), false);
  assert.equal(isOverlayVoteTally({ ...votes, resolvedOptionKey: 123 }), false);
});

test('shared polling envelope accepts only one expected v1 field', () => {
  assert.equal(isExactRecord({ schemaVersion: 'v1', tips: [] }, ['schemaVersion', 'tips']), true);
  assert.equal(isExactRecord({ schemaVersion: 'v1', tips: [], sessionToken: 'secret' }, ['schemaVersion', 'tips']), false);
  assert.equal(isExactRecord({ schemaVersion: 'v1' }, ['schemaVersion', 'tips']), false);
});
