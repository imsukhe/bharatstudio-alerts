import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRupees, isOverlayGoal, progressPercent } from './goal-widget-logic';

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

test('isOverlayGoal rejects a malformed or partial payload rather than rendering garbage', () => {
  assert.equal(isOverlayGoal(null), false);
  assert.equal(isOverlayGoal({}), false);
  assert.equal(isOverlayGoal({ schemaVersion: 'v1', goalId: 'g1' }), false);
  assert.equal(
    isOverlayGoal({ schemaVersion: 'v1', goalId: 'g1', title: 'Fund', targetAmountPaise: 1000, window: 'open', progressPaise: 500, reached: false }),
    true,
  );
});
