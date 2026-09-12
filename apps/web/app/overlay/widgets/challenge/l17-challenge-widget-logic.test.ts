import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRupees, isOverlayChallenge, isWidgetVisible, progressPercent } from './challenge-widget-logic';

test('progressPercent is 0 for a zero/negative target, capped at 100, otherwise rounded', () => {
  assert.equal(progressPercent({ progressPaise: 500, targetAmountPaise: 0 }), 0);
  assert.equal(progressPercent({ progressPaise: 0, targetAmountPaise: 100000 }), 0);
  assert.equal(progressPercent({ progressPaise: 25000, targetAmountPaise: 100000 }), 25);
  assert.equal(progressPercent({ progressPaise: 100000, targetAmountPaise: 100000 }), 100);
  assert.equal(progressPercent({ progressPaise: 150000, targetAmountPaise: 100000 }), 100);
});

test('formatRupees renders paise as a locale-formatted rupee amount', () => {
  assert.equal(formatRupees(150000), '₹1,500');
  assert.equal(formatRupees(0), '₹0');
});

test('isOverlayChallenge rejects a malformed or partial payload rather than rendering garbage', () => {
  assert.equal(isOverlayChallenge(null), false);
  assert.equal(isOverlayChallenge({}), false);
  assert.equal(isOverlayChallenge({ schemaVersion: 'v1', challengeId: 'c1' }), false);
  assert.equal(isOverlayChallenge({ schemaVersion: 'v1', challengeId: 'c1', title: 'X', kind: 'stake', targetAmountPaise: 1000, state: 'not-a-real-state', progressPaise: 0, targetReached: false }), false);
  for (const state of ['draft', 'active', 'succeeded', 'failed', 'cancelled']) {
    assert.equal(
      isOverlayChallenge({ schemaVersion: 'v1', challengeId: 'c1', title: 'X', kind: 'stake', targetAmountPaise: 1000, state, progressPaise: 0, targetReached: false }),
      true,
      `expected state "${state}" to be accepted`,
    );
  }
});

test('isWidgetVisible is false only for a draft challenge — every other lifecycle state is shown', () => {
  const base = { schemaVersion: 'v1' as const, challengeId: 'c1', title: 'X', kind: 'stake' as const, targetAmountPaise: 1000, progressPaise: 0, targetReached: false };
  assert.equal(isWidgetVisible({ ...base, state: 'draft' }), false);
  for (const state of ['active', 'succeeded', 'failed', 'cancelled'] as const) {
    assert.equal(isWidgetVisible({ ...base, state }), true);
  }
});
