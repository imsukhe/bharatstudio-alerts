import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRisingEdge } from './milestone-celebration-logic';

test('undefined -> true is NOT a rising edge (first-ever observation, or a reconnect redelivering an already-true snapshot)', () => {
  assert.equal(isRisingEdge(undefined, true), false);
});

test('false -> true IS a rising edge — the only case that fires', () => {
  assert.equal(isRisingEdge(false, true), true);
});

test('true -> true is NOT a rising edge — never fires repeatedly while the value stays true', () => {
  assert.equal(isRisingEdge(true, true), false);
});

test('false -> false is NOT a rising edge', () => {
  assert.equal(isRisingEdge(false, false), false);
});

test('true -> false is NOT a rising edge (a falling edge, never celebrated)', () => {
  assert.equal(isRisingEdge(true, false), false);
});

test('undefined -> false is NOT a rising edge', () => {
  assert.equal(isRisingEdge(undefined, false), false);
});
